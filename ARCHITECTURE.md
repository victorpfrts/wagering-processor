# Arquitetura

Este documento explica como o serviço garante correção financeira sob duplicação, desordem e concorrência, quais decisões foram tomadas, o que se abriu mão em cada uma e o que ficou de fora.

Detalhe de cada regra: [`docs/regras.md`](docs/regras.md). Histórico das decisões: [`docs/adr/`](docs/adr).

## 1. A ideia central

**O banco de dados é o guardião das invariantes.** Código de aplicação, ordenação da fila e deduplicação do broker são otimizações; se todos falharem, o PostgreSQL ainda recusa o saldo negativo, o débito duplicado e o ledger adulterado.

Disso saem três regras que se repetem no projeto inteiro:

1. **Uma transação SQL por operação.** Transação de aposta, lançamento no ledger, saldo, registro de inbox e eventos de saída são confirmados juntos ou desfeitos juntos.
2. **Nada sai do processo antes do commit.** Eventos são gravados numa tabela (outbox) e publicados depois; o ack da fila só acontece depois do commit.
3. **Toda entrada é idempotente.** Repetir uma requisição, uma mensagem ou uma publicação nunca repete o efeito.

Com isso, um `kill -9` em qualquer ponto é seguro: o que não foi confirmado é desfeito pelo banco e reprocessado depois; o que foi confirmado é reconhecido como já feito.

## 2. Visão geral

```mermaid
flowchart LR
  P[Provedor] -->|HTTP| API
  P -->|SQS| Q[(wager-transactions.fifo)]
  Q --> C[Consumidor]
  subgraph Instância ×N
    API[Controllers HTTP] --> UC
    C --> UC[ProcessWagerTransaction]
    W[Worker de referências pendentes] --> UC
    PUB[Publisher da outbox]
  end
  UC -->|uma transação SQL| DB[(PostgreSQL)]
  PUB -->|lê pendentes| DB
  PUB --> E[(wager-events.fifo)]
  C -.->|falha permanente / limite| DLQ[(wager-transactions-dlq.fifo)]
```

Toda instância roda os quatro papéis (API, consumidor, publisher, worker). Não há líder, eleição nem lock distribuído: as instâncias não se conhecem e quem as coordena é o banco, por lock de linha, índices únicos e `SKIP LOCKED`.

## 3. Camadas

```
interfaces  →  application  →  domain
                    ↑
              infrastructure
```

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, inbox/outbox, eventos, regras das operações | nada (nem NestJS, nem ORM) |
| `application` | casos de uso e as **portas** que eles exigem (`UnitOfWork`, repositórios, `EventPublisher`, `Clock`, métricas, log) | `domain` |
| `infrastructure` | adaptadores das portas: MikroORM, SQS, pino, Prometheus, workers | `application`, `domain` |
| `interfaces` | controllers HTTP e handler de mensagens: traduzem protocolo para caso de uso | `application` |

`app.module.ts` é o único lugar que liga porta a adaptador.

**Modelagem do domínio.** Classes com construtor privado e factories (`create`, `open`, `rehydrate`). `rehydrate` só reconstrói estado; não revalida transições. `WalletLedgerEntry` não tem campo mutável nem método de transição. As regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` ficam numa função pura (`applyWagerTransaction`) que recebe a wallet já carregada: 121 testes de unidade rodam em cerca de 50 ms, sem banco.

**Por que não deixar as regras no serviço Nest?** Porque só seriam testáveis com banco. O custo é uma camada a mais; o ganho é que o caso de uso cuida apenas de lock, transação e persistência.

## 4. Modelo de dados e garantias no schema

Cinco tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`. Uma migration com SQL explícito e `down` testado (up → down → up).

| Garantia | Mecanismo no PostgreSQL |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Uma reversão efetiva por transação | índice único parcial em `reference_transaction_id` |
| Estado terminal não muda; transação não é apagada | trigger |
| Ledger só aceita inserção | trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| No máximo um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Cadeia do ledger sem buraco | `UNIQUE (wallet_id, wallet_version)` + trigger que exige versão e saldo anteriores |
| **Saldo materializado = último lançamento** | constraint trigger **adiado para o commit** |
| Deduplicação de mensagens | chave primária `(consumer_name, message_id)` |

A penúltima linha merece destaque. Um `CHECK` não alcança duas tabelas, então um trigger adiado confere, no commit de toda transação que toca wallet ou ledger, que o saldo e a versão da wallet são os do último lançamento. Alterar o saldo sem lançar, ou lançar sem alterar o saldo, faz o commit falhar. A invariante final do desafio (`wallet.balance == saldo do ledger`) é imposta pelo banco em cada transação, e não só verificada depois pela reconciliação.

- **Custo:** uma leitura por índice a mais em cada commit financeiro. Não medi o impacto isolado.
- **Alternativa descartada:** confiar apenas na reconciliação, que detecta a divergência depois que ela já existe.

Cada linha da tabela tem um teste que tenta violar a garantia direto no banco (`test/integration/schema.test.ts`).

## 5. Caminho de uma transação

`ProcessWagerTransaction` é o **único** caso de uso para a entrada HTTP e para a fila.

1. **Valida o formato** antes de abrir conexão: `Money`, tipo de operação, exigência de referência.
2. Abre a transação SQL e **trava a linha da wallet** (`SELECT ... FOR UPDATE`).
3. Se a entrada é a fila, **registra a mensagem no inbox**.
4. **Procura a idempotency key.** Encontrou com o mesmo payload: devolve o resultado original. Encontrou com payload diferente: conflito.
5. **Aplica as regras** (função pura): resulta em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`.
6. **Grava**, nesta ordem: transação, lançamento, saldo da wallet, eventos na outbox.
7. **Commit.** Só depois disso vêm a resposta HTTP, o ack da fila e a contagem de métricas.

O lock vem antes da consulta de idempotência de propósito: dali em diante todas as leituras veem um estado que ninguém mais pode mudar. O custo é que até um replay espera na fila do lock.

### Transições de estado

```
PENDING ───────────────► PROCESSED | REJECTED
PENDING ───────────────► PENDING_REFERENCE
PENDING_REFERENCE ─────► PENDING_REFERENCE   (nova tentativa agendada)
PENDING_REFERENCE ─────► PROCESSED | REJECTED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar transicionar a partir deles lança erro no domínio e é recusado por trigger no banco.

`FAILED` existe no modelo e no schema, mas **nenhum fluxo atual o grava**: falha de infraestrutura desfaz a transação inteira e a operação é repetida; uma mensagem que esgota as tentativas vai para a DLQ sem deixar linha de transação. Ver limitações.

## 6. Decisões

### 6.1 ORM: MikroORM com registros de persistência e mappers ([ADR-001](docs/adr/2026-11-12-orm-mikroorm-com-mappers.md))

O ORM mapeia **registros** (objetos simples definidos com `EntitySchema`), não as classes de domínio. Mappers convertem registro ↔ domínio chamando `rehydrate`.

- **Por quê:** o domínio fica sem decorators e sem dependência do ORM, e a reidratação passa pela factory exigida.
- **Custo:** um mapper por agregado e escritas explícitas no repositório.
- **Descartado:** decorators nas classes de domínio (acopla o domínio ao ORM); `EntitySchema` apontando para as classes de domínio (o ORM instanciaria por fora das factories).

**Estratégia transacional.** Cada `UnitOfWork.run()` cria um `EntityManager` novo (`em.fork()`, Identity Map limpo) e abre `em.transactional()`. A wallet travada com `LockMode.PESSIMISTIC_WRITE` fica no Identity Map e é a mesma instância que o repositório altera ao salvar. Cada escrita faz `flush` imediato: abre-se mão do agrupamento automático de comandos para que a ordem do SQL seja a do caso de uso (a transação antes do lançamento que a referencia) e o erro de constraint apareça no ponto que o causou.

SQL explícito aparece só onde o ORM não tem equivalente direto: o `lock_timeout` da transação, a seleção e a marcação de eventos da outbox (`FOR UPDATE SKIP LOCKED`), a soma do ledger na reconciliação e a leitura do atraso da outbox.

### 6.2 Money ([ADR-004](docs/adr/2026-11-12-money-decimal-e-numeric.md))

- No domínio: `decimal.js`, imutável, com precisão folgada para que somas nunca arredondem.
- No banco: `NUMERIC(19,2)` + `CHAR(3)`. O driver entrega `NUMERIC` como string e é assim que o valor entra em `Money.from`.
- Nos contratos: string decimal com 2 casas.

Nenhum ponto do caminho converte para `number`; um teste passa `90071992547409.93` (acima de 2^53) por ORM e banco sem perder centavos.

A entrada aceita até 2 casas e normaliza (`"25.5"` vira `"25.50"`). Negativo, notação científica, `NaN`, `Infinity`, vazio e mais de 2 casas são **rejeitados**, nunca arredondados. O modelo é multi-moeda; operar entre moedas diferentes é erro de domínio.

- **Descartado:** centavos em `bigint`, que é exato e rápido, mas fixa a escala no código e foge do esqueleto pedido.

### 6.3 Concorrência: lock pessimista por wallet ([ADR-002](docs/adr/2026-11-12-concorrencia-lock-pessimista-por-wallet.md))

Toda operação financeira trava a linha da wallet como primeiro passo da transação.

- **Por quê:** REFUND e ROLLBACK precisam ler a referência, conferir se já foi revertida e alterar o saldo de forma serializada. Com o lock, tudo que toca a mesma wallet acontece em fila, e a correção é simples de provar.
- **Sem deadlock:** cada transação pega um único lock de wallet, e ele é sempre o primeiro.
- **Lock por wallet, não global:** wallets diferentes seguem em paralelo (há um teste em que uma wallet travada não atrasa outra).
- **Espera limitada:** `SET LOCAL lock_timeout` (3 s). Estourou, a operação falha como transitória (HTTP 503 com `Retry-After`, ou retry na fila) e nada é gravado.
- **Custo:** a vazão de uma wallet é limitada pela duração da transação.
- **Descartado:** optimistic locking com retry, melhor quando conflito é raro, mas que em wallet quente vira tempestade de retries; update atômico condicionado (`UPDATE ... WHERE balance >= x`), ótimo para BET, mas que não serializa a checagem de referência.

`version` continua existindo: incrementa a cada mudança de saldo e numera a cadeia do ledger.

### 6.4 Idempotência ([ADR-003](docs/adr/2026-11-12-idempotencia-chave-e-hash-de-payload.md))

A própria `wager_transactions` é o registro de idempotência: guarda a chave, o hash do payload e o **saldo observado quando a transação foi resolvida**. É esse saldo que o replay devolve, não o atual.

**Algoritmo do `payloadHash`:** SHA-256, em hexadecimal, do JSON canônico (chaves ordenadas em todos os níveis, campos `undefined` omitidos) de:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId,
kind, money { amount normalizado para 2 casas, currency },
referenceExternalTransactionId
```

O header e metadados de transporte não entram.

| Situação | Resultado |
|---|---|
| Mesma chave, mesmo hash | replay: resposta original, `idempotentReplay: true` |
| Mesma chave, hash diferente | conflito (409 no HTTP; DLQ na fila) |
| Chave diferente para o mesmo `(providerId, externalTransactionId)` | conflito |

Transações rejeitadas também são persistidas, então a rejeição é idempotente e auditável.

**Corrida sem wallet.** Se a wallet não existe, não há linha para travar e duas requisições iguais rodam em paralelo. O índice único barra o segundo `INSERT`, o caso de uso reexecuta e encontra o registro. Um teste com 20 envios paralelos revelou um defeito sutil aqui (a segunda busca enxergava uma linha confirmada depois da primeira e respondia "conflito"); a decisão passou a ser tomada pela chave gravada na linha encontrada.

### 6.5 Transactional outbox ([ADR-005](docs/adr/2026-11-12-transactional-outbox-skip-locked.md))

Os eventos são gravados em `outbox_messages` na mesma transação do efeito financeiro. Um worker em cada instância os publica em `wager-events.fifo`.

- **Vários publishers:** `FOR UPDATE SKIP LOCKED`. Ninguém espera por ninguém e ninguém pega a mesma linha.
- **Ordem por wallet:** cada publisher trava só a **cabeça** de cada wallet (o evento pendente mais antigo dela); apenas quem travou a cabeça pega os demais eventos daquela wallet. O envio é em rodadas, uma mensagem por wallet por rodada; se uma falha, as seguintes da mesma wallet não saem.
- **Queda:** `published_at` só é gravado depois da confirmação do SQS. Se o processo morre com o lote travado, a transação é desfeita, os locks caem e outra instância assume.
- **Entrega at-least-once:** morrer entre o envio e o commit reenvia o evento. O `MessageDeduplicationId` (igual ao `eventId`) faz o SQS descartar o reenvio por 5 minutos; fora dessa janela, o consumidor deduplica pelo `eventId`.
- **Falha de envio:** nova tentativa em 1 s, 2 s, 4 s... até 60 s, sem limite. Evento confirmado nunca é descartado.

Trade-offs assumidos:

- A transação do banco fica aberta durante a chamada ao SQS. É o que mantém os eventos travados. Aceito porque o lote é pequeno e essa transação não toca em wallets.
- Um evento que nunca consegue sair segura os seguintes **da mesma wallet**. Não há DLQ para eventos de saída; a métrica de atraso da outbox é o que denuncia o caso.
- **Descartado:** publicar em memória logo após o commit (perde o evento se o processo morre); CDC lendo o WAL (robusto, mas infraestrutura pesada para o escopo); lock consultivo por wallet (testado: um publisher segurava todas as wallets e o outro ficava ocioso).

Eventos publicados: `WagerTransactionProcessed` (toda transação aplicada, inclusive `LOSS` e a `OPENING`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo muda) e `WagerTransactionPendingReference` (uma vez, na entrada no estado). Cada evento é uma subclasse de `IntegrationEvent` com `eventType` e `version` no tipo; `data` carrega `MoneyProps`, nunca `Money`.

### 6.6 Consumo da fila e inbox

O handler traduz a mensagem para o mesmo caso de uso do HTTP e devolve uma **decisão**; o consumidor a executa no SQS.

| Situação | Classe | Ação |
|---|---|---|
| Processada, rejeitada por regra, ou pendente de referência | desfecho confirmado | ack |
| Redelivery (mesmo `messageId`, mesmo conteúdo) | duplicata | ack, sem efeito novo |
| JSON malformado, schema inválido, valor inválido | permanente | DLQ direto, com o motivo |
| Mesmo `messageId` com conteúdo diferente | permanente | DLQ direto |
| Mesma idempotency key com payload diferente | permanente | DLQ direto |
| Lock disputado, banco fora, erro inesperado | transitório | volta à fila com backoff |

- **Inbox na mesma transação.** A chave é `(consumerName, messageId)`. Se a transação é desfeita, o registro some junto e a mensagem volta a ser "nunca vista".
- **Ack só depois do commit.**
- **Conflito de idempotência vai para a DLQ**, e não para um ack silencioso: na fila não há resposta ao provedor, e descartar perderia a informação.
- **Erro desconhecido é transitório.** Na dúvida, não se perde a mensagem; se persistir, o limite leva à DLQ.
- **Limite:** `maxReceiveCount = 5` na fila (redrive do SQS), com visibilidade de 2 s dobrando até 60 s.
- **Ordem é otimização.** Uma mensagem em retry não segura as seguintes da mesma wallet; o sistema já tolera chegada fora de ordem.
- **`SIGTERM`:** interrompe o long polling, termina as mensagens em andamento e devolve as recebidas e não iniciadas com visibilidade 0.

### 6.7 Referências fora de ordem

`REFUND` ou `ROLLBACK` cuja referência ainda não chegou é gravado como `PENDING_REFERENCE` (HTTP 202). Um worker em cada instância reavalia as pendências vencidas, cada uma na sua própria transação e pelo mesmo código de regras.

- **Backoff:** 2, 4, 8, 16, 32 e 64 s, seis tentativas, cerca de 2 minutos no total.
- **Esgotou:** `REJECTED` com `REFERENCE_NOT_FOUND` e evento publicado.
- **Por que 2 minutos:** provedores reentregam em segundos; depois disso a referência provavelmente não existe, e manter a transação aberta atrasa a resposta definitiva.
- **Resolução por agendamento, não por gatilho.** A chegada da referência não dispara nada. É um caminho de código a menos para provar; o custo é latência de até o backoff corrente.

### 6.8 Regras de reversão

O enunciado diz que uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação. Adotei uma regra mais restrita: **uma transação tem no máximo uma reversão efetiva, seja `REFUND` ou `ROLLBACK`.** Pela regra literal, uma mesma `BET` poderia receber um `REFUND` e um `ROLLBACK`, e o jogador seria creditado duas vezes. `ROLLBACK` de um `REFUND` continua permitido, porque é outra referência.

Reversão que deixaria o saldo negativo é rejeitada com `REVERSAL_WOULD_OVERDRAW`, distinto do `INSUFFICIENT_FUNDS` de uma aposta sem saldo.

### 6.9 Status HTTP e códigos de falha

O mapeamento distingue as cinco situações pedidas, de forma igual em todos os endpoints: 400 (payload inválido), 409 (conflito de idempotência), 422 (rejeição de negócio, com `failureCode`), 202 (aceite pendente) e 503 com `Retry-After` (falha transitória). A tabela completa está no [`README.md`](README.md#status-http) e a taxonomia de `failureCode`, com o que o provedor deve fazer em cada caso, em [`docs/regras.md`](docs/regras.md#códigos-de-falha).

Rejeição de negócio e aceite pendente **não são erros**: são desfechos da transação, gravados e idempotentes. Por isso saem do controller, e não do filtro de exceções.

## 7. Autenticação: não implementada

Decisão: **não implementar**, conforme a seção 2 do desafio permite. Ela não pontua e competiria com correção financeira, concorrência e idempotência.

**Ponto de extensão no código** (`src/interfaces/http/auth.ts`):

- `ProviderAuthGuard`, um guard global que já roda em toda rota;
- `ProviderIdentityPort`, a porta que identifica o provedor. A implementação atual (`AnonymousProviderIdentity`) devolve "anônimo";
- `@Public()` marca os health checks e `/metrics`.

O guard já contém a regra de autorização e ela é testada com uma identidade falsa: com um IdP ligado, anônimo recebe 401 e um provedor só age em seu próprio nome (403 se o `providerId` do corpo ou da rota for de outro).

**Desenho que eu adotaria (Keycloak):**

1. Keycloak no Docker Compose, com um realm `wagering`.
2. Cada provedor é um *client* confidencial usando **client credentials** (comunicação máquina a máquina, sem usuário).
3. Um *mapper* inclui a claim `provider_id` no token de acesso.
4. Uma implementação de `ProviderIdentityPort` valida o JWT do header `Authorization`: assinatura pelas chaves públicas do realm (JWKS, com cache), `iss`, `aud` e expiração; devolve o `provider_id`.
5. Escopos separariam escrita (`wagering:write`) de leitura e de operação (reconciliação).

Nenhum controller mudaria. Mensagens da fila continuam tratadas como canal interno confiável, com a identidade do provedor sujeita às mesmas validações de domínio.

## 8. Observabilidade

- **Logs:** pino, uma linha JSON por evento. Todo processamento gera uma linha com `correlationId`, `transactionId`, `walletId`, `providerId` e `messageId` (quando vem da fila). O log sai do caso de uso, então é igual para HTTP e fila.
- **Sem dados financeiros:** o código não envia valor, saldo nem corpo de requisição. Como segunda barreira, o logger mascara as chaves `money`, `amount`, `balance`, `payload`, `body` e `authorization`.
- **Métricas** em `/metrics` (Prometheus): transações por status, duplicatas, retries, DLQ, conflitos de concorrência, atraso da outbox e latência. Só contam depois do commit ou do erro definitivo. A lista está em [`docs/regras.md`](docs/regras.md#observabilidade).
- **Health:** `/health/live` não toca em dependências; `/health/ready` verifica PostgreSQL e SQS.
- **Reconciliação:** compara saldo e soma do ledger lidos num único comando SQL. Divergência é logada, contada e sinalizada na resposta; nunca corrigida.

## 9. Estratégia de testes

| Nível | O que prova | Como |
|---|---|---|
| Unidade (121) | regras de negócio | domínio puro, sem I/O |
| Integração (136) | schema, atomicidade, HTTP, outbox, fila | PostgreSQL e LocalStack reais |
| Concorrência (18) | corridas e quedas | conexões paralelas e **processos reais** |

- **Sem mocks de infraestrutura.** Onde é preciso provocar uma falha, ela é injetada em volta do componente real (um publisher que falha para um evento específico, um cliente SQS que descarta o primeiro ack).
- **Isolamento por banco.** Cada arquivo de teste cria um banco próprio, porque o ledger não permite limpeza.
- **Determinismo.** O backoff é testado com relógio controlado; os testes de queda usam `SIGKILL` em processos reais.
- **Injeção de falha.** O ponto "depois do commit e antes do ack" é atingido com `FAULT_INJECTION=consumer.before-ack`, que faz o processo se matar exatamente ali. É código de produção que existe para teste: desligado por padrão, não deve ser definido em produção. Sem ele, acertar essa janela dependeria de sorte no tempo.

Os testes encontraram defeitos reais durante o desenvolvimento, entre eles a corrida de idempotência sem wallet e a perda de paralelismo dos publishers com lock consultivo.

## 10. Restrições do desafio: onde cada uma é garantida

| Restrição (seção 5) | Garantia |
|---|---|
| 1. Sem `number` para dinheiro | `Money` sobre `decimal.js`, `NUMERIC` no banco, string nos contratos |
| 2. Sem cache em memória para idempotência | índices únicos no PostgreSQL |
| 3. Não confiar só no FIFO | lock de linha, índices únicos e inbox; a fila é otimização |
| 4. Sem evento antes do commit | outbox na mesma transação; publicação por worker |
| 5. Ledger sem sobrescrita nem exclusão | trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` |
| 6. Sem lock global | lock por linha de wallet |
| 7. Sem `read → calculate → update` desprotegido | `SELECT ... FOR UPDATE` antes de ler o saldo |
| 8. Correto com várias instâncias | testes com 3 processos reais |
| 9. Garantias no schema | seção 4 deste documento |

## 11. Limitações conhecidas

**Modelo**

- A **rodada não é um agregado**. Não impedimos um `WIN` depois de a `BET` da rodada ter sido revertida, nem duas `BET` na mesma rodada.
- **`FAILED` não é gravado por nenhum fluxo.** Uma mensagem que esgota as tentativas vai para a DLQ sem deixar transação; a auditoria desse caso está na fila, não no banco.
- O `correlationId` da requisição original **não é guardado na transação**. Os eventos de uma resolução tardia usam o id da transação como correlação.
- Reversão parcial está fora de escopo, como o enunciado define. Não há conversão entre moedas.

**Operação**

- **Wallet quente:** a vazão por wallet é limitada pelo lock. Sob disputa acima de 3 s, o provedor recebe 503 e precisa reenviar.
- **Polling:** três workers por instância consultam o banco em intervalos fixos; a carga de consulta cresce com o número de instâncias.
- **Sem retenção:** inbox, outbox publicada e transações crescem sem limpeza nem particionamento.
- **Sem DLQ para eventos de saída:** um evento que nunca publica segura os seguintes da mesma wallet.
- **Métricas por instância;** não há Prometheus, dashboard nem OpenTelemetry no compose.
- **Sem autenticação** (seção 7) e sem limite de requisições por provedor.

**Ambiente**

- O LocalStack está fixado na versão 3.8.
- O trigger de consistência no commit não teve o custo medido isoladamente.

## 12. Com mais tempo

1. Modelar a rodada como agregado, com estado próprio.
2. Gravar `FAILED` para mensagens que vão à DLQ por esgotamento, fechando a auditoria no banco.
3. Persistir o `correlationId` na transação.
4. Retenção e particionamento para inbox, outbox e ledger.
5. Substituir o polling da outbox por `LISTEN/NOTIFY` como gatilho, mantendo o polling como rede de segurança.
6. Keycloak, conforme o desenho da seção 7.
7. Rastreamento distribuído com OpenTelemetry.
