# ADR-003 — Idempotência persistente por chave + hash de payload

Data: 2026-11-12 · Status: aceito

## Contexto
A entrega é at-least-once. A mesma operação pode chegar várias vezes, em paralelo, por HTTP e por fila. Mesma chave com payload diferente é conflito, não replay. Cache em memória é proibido como garantia.

## Opções
1. **Tabela separada de chaves de idempotência** com a resposta serializada. Genérica, mas duplica o estado que a própria transação já guarda.
2. **A própria `wager_transactions` é o registro de idempotência**: `idempotency_key` única, `payload_hash` e o saldo resultante gravados na linha.

## Decisão
Opção 2.
- `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- `payload_hash` = SHA-256 do JSON canônico (chaves ordenadas, `money.amount` normalizado para 2 casas) de: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header e metadados de transporte ficam de fora.
- Fluxo: trava a wallet (ADR-002) → busca pela chave → se existe e o hash bate, devolve o resultado original com `idempotentReplay: true`; se o hash difere, conflito (409); se não existe, insere.
- O saldo observado no momento fica em `resulting_balance`, para o replay devolver o saldo original e não o atual.
- Os índices únicos são a garantia final: se duas requisições com a mesma chave apontarem wallets diferentes (e portanto locks diferentes), a segunda falha no índice e é tratada como conflito.

## Consequências
- Transações rejeitadas também são persistidas (auditáveis e idempotentes).
- 50 envios paralelos da mesma aposta: 1 processa, 49 esperam o lock e respondem replay.

## Riscos
- Mudar o conjunto de campos do hash quebra replays antigos. Mitigação: algoritmo documentado e versionável.
