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
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
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
- Migrations são classes MikroORM com SQL explícito e `down` testado (up → down → up).
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

## Lock e falha transitória
- Espera máxima por lock de wallet: 3s (`DB_LOCK_TIMEOUT_MS`), aplicada com `SET LOCAL` em cada transação. Estourou → `TRANSIENT_FAILURE` (`LOCK_TIMEOUT`), HTTP 503 com `Retry-After: 1`; nada é gravado e a mesma requisição pode ser reenviada.
- Deadlock, falha de serialização e banco indisponível também são falha transitória.
- Violação de constraint que não seja de unicidade é erro interno (500): indica bug, não disputa.
- Corpo de erro único em todos os endpoints: `{ code, message, details? }`.
- Corpo com campo desconhecido é payload inválido (400).
- Replay de transação `PENDING_REFERENCE` devolve 202 com `idempotentReplay: true` e sem saldo.

## SQS
- Negócio → grava `REJECTED`, ack.
- Transitório → visibilidade com backoff; 5 recebimentos → DLQ (redrive).
- Permanente (schema inválido, mesmo `messageId` com hash diferente) → DLQ direto.
- `SIGTERM` → para de buscar, conclui o que está em andamento, devolve a visibilidade do resto.
- Eventos em `wager-events.fifo`, grupo = `walletId`, deduplicação = `eventId`.

## Autenticação
Não implementada (não pontua). Ponto de extensão: `AuthGuard` no-op + `ProviderIdentityPort`. Desenho com Keycloak (client credentials por provedor) no `ARCHITECTURE.md`.
