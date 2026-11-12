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

## Referência fora de ordem
- Persiste `PENDING_REFERENCE`; HTTP responde 202.
- Worker com backoff exponencial (2s, 4s, 8s, ...), 6 tentativas (~2 min), configurável.
- Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` + evento.

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

## SQS
- Negócio → grava `REJECTED`, ack.
- Transitório → visibilidade com backoff; 5 recebimentos → DLQ (redrive).
- Permanente (schema inválido, mesmo `messageId` com hash diferente) → DLQ direto.
- `SIGTERM` → para de buscar, conclui o que está em andamento, devolve a visibilidade do resto.
- Eventos em `wager-events.fifo`, grupo = `walletId`, deduplicação = `eventId`.

## Autenticação
Não implementada (não pontua). Ponto de extensão: `AuthGuard` no-op + `ProviderIdentityPort`. Desenho com Keycloak (client credentials por provedor) no `ARCHITECTURE.md`.
