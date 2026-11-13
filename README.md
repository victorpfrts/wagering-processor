# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores de jogos por HTTP e por SQS. Desafio técnico da Jungle Gaming.

O sistema continua correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo**, com várias instâncias rodando e com processos morrendo em qualquer ponto.

- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Todas as regras e interpretações adotadas: [`docs/regras.md`](docs/regras.md)
- Registros de decisão (ADRs): [`docs/adr/`](docs/adr)

## Stack

Bun 1.x · TypeScript estrito · NestJS · MikroORM · PostgreSQL 17 · AWS SQS (LocalStack) · Docker Compose

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Como rodar

### Opção 1 — tudo em Docker, com 3 instâncias

```sh
bun run docker:up     # PostgreSQL, LocalStack, migrations e 3 réplicas da aplicação
bun run docker:down   # derruba tudo e apaga os volumes
```

As réplicas respondem em `http://localhost:3000`, `:3001` e `:3002`. Um serviço `migrate` aplica o schema uma vez, antes de as réplicas subirem.

### Opção 2 — aplicação local, infraestrutura em Docker

```sh
bun install
cp .env.example .env
bun run infra:up        # PostgreSQL (porta 5433) e LocalStack/SQS (porta 4566), com as filas criadas
bun run migration:up    # aplica o schema
bun run dev             # http://localhost:3000, com recarga automática
```

Para desfazer: `bun run migration:down` reverte o schema e `bun run infra:down` remove os containers.

## Testes

Os testes de integração e de concorrência usam **PostgreSQL e SQS reais** (os containers do `infra:up`). Nada é substituído por mock. Cada arquivo de teste cria um banco e filas próprios, então não é preciso rodar migrations antes nem limpar nada depois.

```sh
bun run infra:up           # uma vez
bun test                   # tudo: 279 testes, cerca de 40 s
bun run test:unit          # domínio puro, sem infraestrutura (122 testes)
bun run test:integration   # schema, use cases, HTTP, outbox, fila, observabilidade (139 testes)
bun run test:concurrency   # corridas reais, 3 processos, kill -9, reinício (18 testes)
bun run typecheck
```

| Exigência da seção 13 | Onde está |
|---|---|
| `Money`, `Wallet`, regras das operações, conflito de moeda, key com payload divergente | `test/unit/` |
| Migrations e constraints | `test/integration/schema.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `process-wager-transaction.test.ts`, `sqs-consumer.test.ts` |
| Inbox e redelivery; retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/outbox-publisher.test.ts` |
| 1. Mesma aposta 50 vezes em paralelo | `wallet-concurrency.test.ts` (e 60 vezes por 3 processos em `multi-instance.test.ts`) |
| 2. Disputa de saldo (100, duas apostas de 80) | `wallet-concurrency.test.ts`, `multi-instance.test.ts` |
| 3. Wallets distintas em paralelo | `wallet-concurrency.test.ts` |
| 4. Três ou mais processos simultâneos | `test/concurrency/multi-instance.test.ts` |
| 5. Worker morto depois do commit e antes do ack | `multi-instance.test.ts` (processo real, `SIGKILL`) |
| 6. Dois publishers sobre a mesma outbox | `outbox-publisher.test.ts`, `multi-instance.test.ts` |
| 7. `ROLLBACK`/`REFUND` antes da referência | `test/integration/pending-reference.test.ts` |
| 8. Reinício com comprovação da consistência final | `multi-instance.test.ts` |

Todos os testes de integração e concorrência terminam conferindo a invariante `wallet.balance == saldo reconstruído pelo ledger`.

## API

Dinheiro é sempre `{ "amount": "25.00", "currency": "BRL" }`, com `amount` em string decimal.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Abre uma wallet |
| `GET` | `/wallets/:walletId` | Saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | Lançamentos, do mais recente para o mais antigo |
| `POST` | `/wallets/:walletId/reconciliation` | Compara o saldo com o ledger |
| `POST` | `/wagering/transactions` | Submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `GET` | `/health/live`, `/health/ready` | Liveness e readiness (PostgreSQL e SQS) |
| `GET` | `/metrics` | Métricas no formato Prometheus |

### Exemplo

```sh
# abre a wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# aposta (troque <walletId>)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# repetir o mesmo comando → 200 com "idempotentReplay": true e o mesmo saldo
```

### Status HTTP

| Situação | Status | O provedor deve |
|---|---|---|
| Processada, ou replay de uma já processada | 200 | seguir |
| Aceita, aguardando a transação referenciada | 202 | consultar depois |
| Wallet criada | 201 | seguir |
| Payload inválido | 400 | corrigir e reenviar |
| Recurso inexistente | 404 | — |
| Conflito de idempotência, ou wallet duplicada | 409 | não reenviar com a mesma chave |
| Rejeitada por regra de negócio (`failureCode` no corpo) | 422 | decidir pelo `failureCode` |
| Falha transitória (`Retry-After`) | 503 | reenviar a mesma requisição |
| Replay de transação `FAILED` (falha permanente, terminal) | 500 | abrir uma nova operação |

Erros têm sempre o corpo `{ "code", "message", "details"? }`. A lista de `failureCode` está em [`docs/regras.md`](docs/regras.md#códigos-de-falha).

## Filas SQS

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada: mensagens `WagerTransactionRequested` |
| `wager-transactions-dlq.fifo` | mensagens com falha permanente ou que esgotaram 5 recebimentos |
| `wager-events.fifo` | saída: eventos de integração publicados pela outbox |

Para enviar uma mensagem de teste (formato na seção 10 do enunciado):

```sh
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "<walletId>" --message-deduplication-id "$(date +%s)" \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

## Configuração

Variáveis de ambiente, todas com valor padrão (ver [`.env.example`](.env.example)).

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering` | PostgreSQL |
| `DB_POOL_MAX` | `10` | Conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `3000` | Espera máxima por lock de wallet antes de responder 503 |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, —, — | Credenciais (no LocalStack, `test`/`test`) |
| `SQS_TRANSACTIONS_QUEUE`, `SQS_DLQ_QUEUE`, `SQS_EVENTS_QUEUE` | nomes acima | Filas |
| `CONSUMER_ENABLED` | `true` | Liga o consumidor da fila |
| `CONSUMER_RETRY_BASE_SECONDS` / `_MAX_SECONDS` | `2` / `60` | Backoff do retry de mensagens |
| `CONSUMER_MAX_RECEIVE_COUNT` | `5` | Entregas com falha antes de gravar `FAILED` e enviar à DLQ |
| `OUTBOX_ENABLED` | `true` | Liga o publisher de eventos |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` | `500`, `100` | Ritmo do publisher |
| `PENDING_REFERENCE_ENABLED` | `true` | Liga o worker de referências fora de ordem |
| `LOG_LEVEL` | `info` | Nível de log (pino) |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | Prazo do desligamento limpo |

## Estrutura

```
src/
  domain/           regras de negócio puras: Money, Wallet, WagerTransaction, ledger, eventos
  application/      casos de uso e portas (interfaces) que eles exigem
  infrastructure/   adaptadores: MikroORM, SQS, workers, logs, métricas
  interfaces/       entradas: controllers HTTP e handler de mensagens da fila
  app.module.ts     composição: liga portas a adaptadores
migrations/         schema versionado e reversível
test/
  unit/             domínio, sem infraestrutura
  integration/      PostgreSQL e SQS reais
  concurrency/      corridas reais e processos reais
docs/
  regras.md         todas as regras e interpretações adotadas
  adr/              registros de decisão
```

O domínio não importa NestJS nem MikroORM; a aplicação só conhece interfaces.
