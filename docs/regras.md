# Regras e interpretações adotadas

Documento vivo. Tudo que o enunciado deixa em aberto e foi decidido fica aqui; ele alimenta o `ARCHITECTURE.md`.

## Money
- Entrada: `^(0|[1-9]\d*)(\.\d{1,2})?$`, normalizada para 2 casas (`"25.5"` → `"25.50"`).
- Rejeitados: negativo, notação científica, `NaN`, `Infinity`, vazio, mais de 2 casas.
- Sem arredondamento: valor com mais casas é rejeitado.
- Valor zero só em `LOSS`; nas demais operações o valor é positivo.

## Idempotência
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas, valor normalizado) de `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`.
- Mesma chave + mesmo hash → replay com o resultado original (inclui o saldo daquele momento).
- Mesma chave + hash diferente → conflito.
- Chave diferente para o mesmo `(providerId, externalTransactionId)` → conflito.
- A chave é escopada pelo provedor (`UNIQUE (provider_id, idempotency_key)`): a mesma chave em provedores diferentes são operações independentes.

## Reversões
- Uma transação tem no máximo **uma reversão efetiva** (`REFUND` ou `ROLLBACK`). Mais restrito que a regra 4 do enunciado, para impedir crédito duplo de uma mesma BET.
- `ROLLBACK` de um `REFUND` é permitido (é outra referência).
- Referência `REJECTED`/`FAILED` → rejeita com `REFERENCE_NOT_PROCESSED`.
- Referência ainda `PENDING_REFERENCE` → a dependente continua pendente.

## Referência por tipo de operação
| Operação | Referência | Pode referenciar |
|---|---|---|
| `BET` | proibida (payload inválido) | — |
| `WIN`, `LOSS` | opcional | `BET` |
| `REFUND` | obrigatória | `BET` |
| `ROLLBACK` | obrigatória | `BET`, `WIN`, `REFUND` |

- Uma transação não pode referenciar a si mesma (payload inválido).
- A exigência de valor igual e de reversão única vale só para `REFUND` e `ROLLBACK`; `WIN`/`LOSS` com referência validam apenas provider, player, wallet, moeda, rodada e tipo.
- `WIN`/`LOSS` com referência ausente também ficam em `PENDING_REFERENCE`.
- Ordem das validações: wallet/player → moeda → referência (dados iguais → tipo permitido → estado → valor → já revertida) → saldo.
- Transação cujo `playerId` não é o dono da wallet → `WALLET_NOT_FOUND` (não revela que a wallet existe).

## Referência fora de ordem
- Persiste `PENDING_REFERENCE`; HTTP responde 202.
- Worker com backoff exponencial (2s, 4s, 8s, ...), 6 tentativas (~2 min), configurável.
- Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` + evento.
- Se a referência existe mas nunca saiu de pendente, o esgotamento rejeita com `REFERENCE_NOT_PROCESSED`.
- O evento `WagerTransactionPendingReference` é publicado uma vez, na entrada no estado (não a cada tentativa).
- Backoff sem jitter (determinístico e testável); a dispersão entre instâncias vem do intervalo de polling.
- Worker em toda instância (`PENDING_REFERENCE_ENABLED`), consultando a cada 1s as transações vencidas (até 50 por rodada).
- Cada pendência é reavaliada na sua própria transação SQL, pelo mesmo código de regras do caminho normal, com a wallet travada primeiro.
- Com várias instâncias, quem chega depois relê a transação sob o lock, vê que já não está vencida e não faz nada.
- Wallet travada ou banco fora: a pendência fica para a próxima rodada e não segura as outras.
- Os eventos da resolução tardia usam o id da própria transação como `correlationId` (a requisição original já terminou).
- A resolução não é disparada pela chegada da referência; espera a próxima tentativa agendada (no máximo o backoff corrente).
- Justificativa do limite (6 tentativas, ~2 min): provedores reentregam em segundos; depois de 2 minutos a referência provavelmente não existe, e segurar a transação aberta atrasa a resposta definitiva ao provedor.

## Modelo
- `WalletLedgerEntry` carrega `walletVersion` (versão da wallet depois do lançamento): numera a cadeia do ledger e permite detectar buraco.
- `WagerTransaction.processedAt` é o instante em que a transação chegou a qualquer estado terminal.
- `WagerTransaction.resultingBalance` guarda o saldo observado na resolução; é o que o replay devolve.
- `OPENING` usa provider `internal` e `externalTransactionId = opening:{walletId}`.
- Outbox: backoff de 1s dobrando até 60s, sem limite de tentativas (evento confirmado nunca é descartado).

## Garantias aplicadas no schema
Cada item abaixo tem um teste de integração que tenta violá-lo direto no PostgreSQL (`test/integration/schema.test.ts`).

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Uma reversão efetiva por referência | índice único parcial em `reference_transaction_id` (`PROCESSED`, `REFUND`/`ROLLBACK`) |
| Estado terminal não muda; transação não é apagada | trigger `wager_tx_guard` |
| Coerência status × `failure_code`, `processed_at`, `next_attempt_at`, saldo resultante | `CHECK`s |
| Ledger append-only | trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` |
| Aritmética do lançamento | `CHECK (after = before ± amount)` |
| Um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Cadeia do ledger sem buraco | `UNIQUE (wallet_id, wallet_version)` + trigger que exige versão e saldo anteriores |
| Saldo materializado == último lançamento | constraint trigger **adiado para o commit**, em `wallets` e no ledger |
| Dedup de mensagens | PK `(consumer_name, message_id)` no inbox |

- `wager_transactions.wallet_id` **não** é chave estrangeira: transação para wallet inexistente é gravada como `REJECTED` (`WALLET_NOT_FOUND`).
- `walletId` precisa ser UUID (coluna `uuid`); outro formato é payload inválido (400).
- Migrations são classes MikroORM com SQL explícito e `down` testado. `migration:down` reverte uma migration por vez.
- A segunda migration (escopo da idempotency key) cria o índice novo antes de remover o antigo; o `down` é recusado se dois provedores já compartilham uma chave.
- Cada arquivo de teste de integração cria um banco próprio, porque o ledger não permite limpeza.

## Limitações conhecidas
- A rodada não é um agregado: não impedimos `WIN` depois de a `BET` da rodada ter sido revertida, nem duas `BET` na mesma rodada.

## Códigos de falha
| Código | Significado | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo | escalar para operação |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir payload |
| `WALLET_NOT_FOUND` | wallet inexistente ou de outro player | corrigir payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | reenviar a referência e depois esta |
| `REFERENCE_NOT_PROCESSED` | referência existe mas não foi aplicada | desistir |
| `REFERENCE_MISMATCH` | provider/player/wallet/moeda/rodada diferentes | corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de WIN | corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente da referência | corrigir payload |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | desistir |

## Status HTTP
| Situação | Status |
|---|---|
| Processada ou replay | 200 |
| `PENDING_REFERENCE` | 202 |
| Payload inválido / header ausente | 400 |
| Não encontrado (consultas) | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeição de negócio | 422 |
| Falha transitória | 503 + `Retry-After` |
| Replay de transação `FAILED` | 500 |

## Lock e falha transitória
- Espera máxima por lock de wallet: 3s (`DB_LOCK_TIMEOUT_MS`), aplicada com `SET LOCAL` em cada transação. Estourou → `TRANSIENT_FAILURE` (`LOCK_TIMEOUT`), HTTP 503 com `Retry-After: 1`; nada é gravado e a mesma requisição pode ser reenviada.
- Deadlock, falha de serialização e banco indisponível também são falha transitória.
- Violação de constraint que não seja de unicidade é erro interno (500): indica bug, não disputa.
- Corpo de erro único em todos os endpoints: `{ code, message, details? }`.
- Corpo com campo desconhecido é payload inválido (400).
- Replay de transação `PENDING_REFERENCE` devolve 202 com `idempotentReplay: true` e sem saldo.

## Wallets e consultas
- `POST /wallets` responde 201 com `Location`. Saldo inicial zero cria só a wallet (versão 1), sem transação, lançamento ou evento.
- A abertura com saldo publica `WagerTransactionProcessed` (da `OPENING`) e `WalletBalanceChanged`.
- `POST /wallets` não é idempotente: repetir devolve 409 `WALLET_ALREADY_EXISTS`. Quem decide a corrida é o índice único.
- Id malformado na rota (não UUID) é 400; id bem formado e inexistente é 404.
- Consulta por id externo é escopada pelo provedor: o id de outro provedor devolve 404.
- Ledger: do lançamento mais recente para o mais antigo; `limit` de 1 a 200 (padrão 50).
- Cursor: base64url de `{"v": walletVersion}`; busca "versão menor que X". Como o ledger é append-only e a versão é única por wallet, lançamentos novos não repetem nem pulam itens nas páginas seguintes.

## Reconciliação
- Saldo e soma do ledger são lidos num único comando SQL (mesmo snapshot), somados em `NUMERIC` pelo banco.
- Responde 200 também quando há divergência, com `consistent: false` e `difference = stored − calculated` (pode ser negativa).
- Divergência gera log de erro e incrementa métrica. Nada é corrigido.

## Publicação de eventos (outbox)
- Worker em toda instância (`OUTBOX_ENABLED`), consultando a cada 500 ms quando ocioso e sem pausa enquanto há trabalho; lote de até 100 cabeças de wallet.
- Entrega at-least-once: `published_at` só é gravado depois da confirmação do SQS. O consumidor deduplica por `eventId`.
- Ordem garantida **por wallet**; entre wallets diferentes não há ordem.
- Falha de envio: `attempts + 1` e nova tentativa em 1s, 2s, 4s... até 60s, sem limite. Enquanto isso os eventos seguintes da mesma wallet esperam.
- A transação do banco fica aberta durante o envio ao SQS (é o que mantém os eventos travados). Aceito porque o lote é pequeno e a transação não toca em wallets.
- No `SIGTERM` o worker termina a rodada em andamento antes de parar.

## SQS (consumo de `wager-transactions.fifo`)
- A fila chama o **mesmo use case** do HTTP; a única diferença é o registro no inbox, feito na mesma transação SQL.
- `correlationId` e `causationId` dos eventos gerados = `messageId` da mensagem.
- Inbox: chave `(consumerName, messageId)`, com hash do conteúdo de negócio (`type` + `data`; `occurredAt` é transporte).
- Ack (`DeleteMessage`) só depois do commit.

| Situação | Classe | Ação |
|---|---|---|
| Processada, rejeitada por regra, ou pendente de referência | desfecho confirmado | ack |
| Redelivery (mesmo `messageId`, mesmo conteúdo) | duplicata | ack, sem efeito novo |
| Mesma operação em outra mensagem (mesma idempotency key) | replay | ack, sem efeito novo |
| JSON malformado, schema inválido, valor inválido | permanente | DLQ direto, com atributo `failureReason` |
| Mesmo `messageId` com conteúdo diferente | permanente (`MESSAGE_ID_REUSED`) | DLQ direto |
| Mesma idempotency key com payload diferente | permanente (`IDEMPOTENCY_CONFLICT`) | DLQ direto, para auditoria |
| Lock disputado, banco fora, erro inesperado | transitório | volta à fila com backoff |
| Falha transitória na 5ª entrega (`CONSUMER_MAX_RECEIVE_COUNT`) | permanente por esgotamento | grava `FAILED`, DLQ com `RETRIES_EXHAUSTED` |

- Na fila não existe resposta ao provedor, então conflito de idempotência vai para a DLQ em vez de ser descartado com ack (no HTTP é 409).
- Erro desconhecido é tratado como transitório: na dúvida não se perde a mensagem; se persistir, o limite leva à DLQ.
- Backoff do retry: visibilidade de 2s, 4s, 8s... até 60s, pelo número de recebimentos.
- Limite: 5 entregas. Na 5ª falha transitória a aplicação grava a transação como `FAILED` (`INTERNAL_ERROR`), publica `WagerTransactionFailed` e envia a mensagem à DLQ.
- O registro de `FAILED` não trava a wallet (não há efeito financeiro). Se a operação já tiver desfecho gravado, ele é preservado.
- Rede de segurança: se nem o registro for possível (banco fora), a mensagem volta à fila e o `maxReceiveCount = 5` da fila (redrive do SQS) a move para a DLQ, sem linha de transação.
- `FAILED` é terminal: o replay devolve `FAILED` (HTTP 500) e a operação só pode ser refeita com outro `externalTransactionId`.
- Consequência: reenviar a mensagem da DLQ para a fila principal não a reprocessa; devolve o `FAILED` gravado. A DLQ é para auditoria e diagnóstico.
- `FAILED` só nasce da fila. No HTTP, falha transitória é 503 e a decisão de desistir é do provedor.
- Ordem: grupos (wallets) diferentes em paralelo; dentro do grupo, na ordem do lote.
- Retry de uma mensagem: as seguintes do mesmo grupo recebidas no mesmo lote são devolvidas (visibilidade 0) **sem serem tentadas**. O SQS FIFO as retém enquanto a primeira estiver em voo. Envio à DLQ não interrompe o grupo.
- Efeito colateral: as devolvidas acumulam recebimentos sem terem sido tentadas e se aproximam do limite de 5.
- O LocalStack 3.8 não emula a retenção do grupo: nos testes as devolvidas reaparecem na hora. A ordem continua sendo otimização; a correção vem do banco.
- `SIGTERM`: interrompe o long polling, termina as mensagens em andamento e devolve as recebidas e não iniciadas com visibilidade 0.
- Falha ao avisar o broker (ack, visibilidade) é só logada: a mensagem reaparece e o inbox absorve.
- Eventos de saída em `wager-events.fifo`, grupo = `walletId`, deduplicação = `eventId`.

## Observabilidade
**Logs** (pino, uma linha JSON por evento; `LOG_LEVEL`, padrão `info`):
- Todo processamento de transação gera uma linha com `correlationId`, `transactionId`, `walletId`, `providerId`, `messageId` (quando vem da fila), `source`, `kind`, `status`, `failureCode` e `idempotentReplay`.
- O log sai do use case, então é igual para HTTP e fila.
- `correlationId`: no HTTP vem do header `X-Correlation-Id` (ou é gerado) e volta na resposta; na fila é o `messageId`.
- Nunca entram valor, saldo, corpo de requisição ou de mensagem. Como segunda barreira, o logger mascara as chaves `money`, `amount`, `balance`, `payload`, `body` e `authorization`.
- Log de acesso HTTP: método, padrão da rota, status e duração. Health e `/metrics` não geram log de acesso.
- Os logs internos do NestJS saem no mesmo formato.

**Métricas** (`GET /metrics`, formato Prometheus, sem autenticação):

| Exigência do desafio | Métrica |
|---|---|
| Transações por status | `wagering_transactions_total{kind,status,failure_code,source}` |
| Duplicatas detectadas | `wagering_duplicates_total{type}` (`idempotent_replay`, `idempotency_conflict`, `inbox_redelivery`) |
| Retries | `wagering_messages_total{outcome="retried"}`, `wagering_pending_reference_retries_total{status}`, `wagering_outbox_publish_total{result="failed"}` |
| Mensagens em DLQ | `wagering_messages_total{outcome="dead_lettered"}` e `wagering_dlq_messages` (profundidade atual) |
| Conflitos de lock | `wagering_concurrency_conflicts_total{reason}` (`LOCK_TIMEOUT`, `DEADLOCK`, `DUPLICATE_KEY`) |
| Outbox lag | `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo) e `wagering_outbox_pending_messages` |
| Latência de processamento | `wagering_processing_duration_seconds{source,outcome}` e `wagering_http_request_duration_seconds{method,route,status}` |
| Reconciliação | `wagering_reconciliation_divergences_total` |

- Contadores só são incrementados depois do commit ou do erro definitivo, nunca dentro de transação que ainda pode ser desfeita.
- Outbox lag e profundidade da DLQ são lidos na hora da coleta, com limite de 2s; se a leitura falhar, o `/metrics` responde sem eles.
- Rótulos de rota usam o padrão (`/wallets/:walletId`), nunca ids.
- Cada instância expõe as próprias métricas; a soma é feita no Prometheus.

## Múltiplas instâncias, queda e reinício
- Toda instância roda os quatro papéis: API, consumidor da fila, publisher da outbox e worker de referências pendentes. Não há líder nem coordenação entre instâncias: quem coordena é o banco (lock de linha, índices únicos, `SKIP LOCKED`).
- `docker compose --profile app up` sobe 3 réplicas (portas 3000 a 3002) depois de um serviço `migrate` que roda uma vez.
- `SIGTERM`/`SIGINT`: fecha o HTTP, espera os workers terminarem o que estão fazendo, fecha o banco e sai com código 0. Prazo de 25s (`SHUTDOWN_TIMEOUT_MS`); estourou, sai com código 1.
- `kill -9` em qualquer ponto é seguro: efeito não confirmado é desfeito pelo banco; mensagem não confirmada volta à fila; evento não publicado continua na outbox para outra instância.
- Os testes de queda usam processos reais (`bun src/main.ts`) e `SIGKILL`. O ponto "depois do commit e antes do ack" é atingido por injeção de falha (`FAULT_INJECTION=consumer.before-ack`), desligada por padrão e proibida em produção.

## Autenticação
Não implementada (não pontua). Ponto de extensão: `AuthGuard` no-op + `ProviderIdentityPort`. Desenho com Keycloak (client credentials por provedor) no `ARCHITECTURE.md`.
