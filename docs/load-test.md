# Teste de carga

Executado em 2026-11-12. Reproduzir: `bun run docker:up && bun run test:load` (script em [`scripts/load-test.ts`](../scripts/load-test.ts)).

## Resumo

- **Correção sob carga:** em 9 execuções (cerca de 250 mil requisições), nenhuma resposta de erro, nenhum 503 e nenhuma wallet com saldo diferente do ledger.
- **Vazão:** entre 455 e 1331 req/s na carga distribuída, com as 3 réplicas. A variação entre execuções foi de quase 3 vezes, então o número serve como ordem de grandeza, não como medida.
- **Gargalo encontrado:** o publisher da outbox não acompanha a carga sustentada. O atraso chegou a 15–26 s e levou de 7 a 23 s para zerar depois da carga.
- **Wallet quente:** 214 req/s com 64 clientes na mesma wallet, sem nenhum timeout de lock.
- **Custo dos triggers de consistência:** cerca de 1,4 % por transação, dentro do ruído da medição.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | notebook Apple Silicon, 10 núcleos, macOS |
| Docker | OrbStack, 10 CPUs e 7,8 GiB para todos os containers |
| Aplicação | 3 réplicas (`oven/bun:1-alpine`, Bun 1.4), pool de 10 conexões cada |
| Banco | PostgreSQL 17, configuração padrão da imagem, 1 container |
| Fila | LocalStack 3.8 (emulador de SQS) |
| Gerador de carga | o próprio script, na mesma máquina |

**O que isso significa para os números.** Gerador de carga, 3 réplicas, banco e emulador de fila disputam os mesmos núcleos, e havia outros containers em execução na máquina. O LocalStack é um emulador e não representa o desempenho do SQS real. Os valores absolutos **não** preveem produção; o que se aproveita são as relações (o que satura primeiro, o que cresce com a carga) e a verificação de correção.

## Metodologia

- **Modelo fechado:** 64 clientes virtuais; cada um envia uma requisição, espera a resposta e envia a próxima, alternando entre as 3 réplicas. Sem tempo de espera entre requisições.
- **Duração:** 30 s por cenário.
- **Mistura:** 65 % `BET`, 25 % `WIN`, 10 % reenvio de uma requisição já feita (replay). Valores aleatórios entre 1,00 e 10,00.
- **Saldo inicial alto** (1.000.000,00), para medir o caminho de sucesso sem rejeição por saldo.
- **Cenários:** *carga distribuída* (200 wallets) e *wallet quente* (1 wallet, pior caso de disputa).
- **Durante a carga:** amostra `wagering_outbox_lag_seconds` e `wagering_outbox_pending_messages` a cada 500 ms.
- **Depois da carga:** mede quanto tempo a outbox leva para esvaziar e chama a reconciliação de **todas** as wallets usadas. O script sai com erro se alguma estiver inconsistente.
- **Latência** medida no cliente, de ponta a ponta (inclui o HTTP local).

Limitações do método: modelo fechado esconde o efeito de fila que um modelo aberto (taxa fixa de chegada) mostraria; 30 s não revelam degradação lenta; sem aquecimento separado; a entrada pela fila SQS não foi exercitada.

## Resultados

### Carga distribuída (200 wallets, 64 clientes, 30 s)

Código final, cada execução partindo de um banco vazio:

| Execução | Vazão | p50 | p99 | Outbox lag máx. | Pendentes máx. | Tempo para esvaziar |
|---|---|---|---|---|---|---|
| 1 | 455 req/s | 119,7 ms | 434,3 ms | 17,0 s | 14.054 | 8,0 s |
| 2 | 677 req/s | 82,6 ms | 289,8 ms | 16,7 s | 21.297 | 7,0 s |

A primeira execução do dia, com o mesmo código, foi bem mais rápida:

| Vazão | p50 | p95 | p99 | Máx. | Outbox lag máx. | Pendentes máx. | Tempo para esvaziar |
|---|---|---|---|---|---|---|---|
| 1331 req/s | 41,1 ms | 107,5 ms | 167,9 ms | 284,8 ms | 26,5 s | 58.837 | 23,1 s |

Em todas: 0 respostas 4xx/5xx, 0 erros de rede, 0 conflitos de lock por timeout, 0 wallets inconsistentes.

### Wallet quente (1 wallet, 64 clientes, 30 s)

| Medida | Valor |
|---|---|
| Requisições | 6.521 |
| Vazão | 214 req/s |
| Latência p50 / p95 / p99 / máx. | 271,0 / 569,5 / 789,8 / 1163,4 ms |
| Falha transitória (503) | 0 |
| Conflitos de lock (timeout de 3 s) | 0 |
| Outbox lag máximo | 9,4 s |
| Wallets inconsistentes | 0 |

### Custo dos triggers de consistência

Medição separada, de baixo ruído: uma conexão, transações em sequência na mesma wallet, 5 rodadas de 1.500 apostas alternando com e sem os três triggers (`wallet_matches_ledger`, `ledger_matches_wallet`, `ledger_chain_guard`).

| | Tempo por transação (mediana) |
|---|---|
| Com os triggers | 2,407 ms |
| Sem os triggers | 2,375 ms |
| Diferença | 1,4 % |

A diferença é menor que a variação entre rodadas (de 1,9 a 2,6 ms). O custo existe, mas não foi possível distingui-lo do ruído.

## Análise

**1. A correção se manteve.** É o resultado mais sólido, porque não depende do ambiente: nenhuma divergência entre saldo e ledger em nenhuma execução, com replays misturados à carga e três réplicas escrevendo ao mesmo tempo.

**2. A vazão não é um número confiável aqui.** O mesmo código produziu de 455 a 1331 req/s. As causas prováveis são a disputa de CPU na máquina e o estado do banco (execuções sobre um banco já carregado ficaram na faixa de 660–740 req/s). Não isolei cada fator. A afirmação honesta é "centenas a pouco mais de mil requisições por segundo neste notebook".

**3. A outbox é o gargalo sob carga sustentada.** Em todas as execuções o atraso cresceu durante a carga e só zerou depois dela. Cada transação gera dois eventos, e o publisher não acompanha a taxa de produção. Nada se perde (é atraso, não perda), mas um consumidor dos eventos veria os dados com segundos de defasagem durante um pico.

Hipóteses para a causa, **não verificadas**:
- o envio é em rodadas com no máximo uma mensagem por wallet, e cada transação gera dois eventos da mesma wallet, o que força pelo menos duas chamadas ao SQS por lote;
- os lotes de uma rodada são enviados um depois do outro;
- o LocalStack pode ser o limite, e não a aplicação.

Testei a segunda hipótese: enviar em paralelo os lotes de uma mesma rodada. Em duas execuções com banco limpo de cada versão não houve ganho mensurável (502–553 req/s e 6,5–9,1 s para esvaziar, contra 455–677 req/s e 7,0–8,0 s). **Reverti a mudança**, por não manter otimização sem evidência.

Próximo passo seria medir o publisher isolado, com a fila real, antes de mexer no desenho.

**4. Wallet quente se comporta como esperado.** Com todas as operações em fila na mesma linha, a vazão (214 req/s) é o inverso do tempo de uma transação (cerca de 4,7 ms), e a latência cresce com o número de clientes esperando: p50 de 271 ms com 64 clientes. Nenhuma requisição chegou perto do limite de 3 s do lock. É o custo previsto do lock pessimista, agora com número.

**5. O trigger de consistência é barato.** A dúvida registrada no `ARCHITECTURE.md` (custo não medido) fica respondida: abaixo do ruído nesta medição.

## O que este teste não responde

- Desempenho com o SQS real e com um PostgreSQL dimensionado.
- Comportamento com mais de 3 réplicas ou com o pool de conexões saturado.
- Degradação em execuções longas (crescimento das tabelas, autovacuum).
- Vazão da entrada pela fila.
- Latência sob taxa de chegada fixa (modelo aberto).
