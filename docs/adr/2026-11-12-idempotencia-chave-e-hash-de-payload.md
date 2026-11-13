# ADR-003 — Idempotência persistente por chave + hash de payload

Data: 2026-11-12 · Status: aceito

## Contexto
A entrega é at-least-once. A mesma operação pode chegar várias vezes, em paralelo, por HTTP e por fila. Mesma chave com payload diferente é conflito, não replay. Cache em memória é proibido como garantia.

## Opções
1. **Tabela separada de chaves de idempotência** com a resposta serializada. Genérica, mas duplica o estado que a própria transação já guarda.
2. **A própria `wager_transactions` é o registro de idempotência**: `idempotency_key` única, `payload_hash` e o saldo resultante gravados na linha.

## Decisão
Opção 2.
- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- `payload_hash` = SHA-256 do JSON canônico (chaves ordenadas, `money.amount` normalizado para 2 casas) de: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header e metadados de transporte ficam de fora.
- Fluxo: trava a wallet (ADR-002) → busca pela chave → se existe e o hash bate, devolve o resultado original com `idempotentReplay: true`; se o hash difere, conflito (409); se não existe, insere.
- O saldo observado no momento fica em `resulting_balance`, para o replay devolver o saldo original e não o atual.
- Os índices únicos são a garantia final: se duas requisições com a mesma chave apontarem wallets diferentes (e portanto locks diferentes), a segunda falha no índice e é tratada como conflito.

## Consequências
- Transações rejeitadas também são persistidas (auditáveis e idempotentes).
- 50 envios paralelos da mesma aposta: 1 processa, 49 esperam o lock e respondem replay.

## Corrida sem wallet para travar
Quando a wallet não existe não há linha para travar, então duas requisições com a mesma chave rodam de fato em paralelo. Dois mecanismos cobrem o caso:
- o índice único barra o segundo `INSERT`; o repositório traduz para `DuplicateKeyError` e o use case reexecuta (até 3 vezes), encontrando o registro;
- as duas buscas de idempotência (por chave e por id externo) podem enxergar estados diferentes do banco, porque a outra transação pode confirmar entre elas. A decisão replay × conflito é tomada pela **chave gravada na linha encontrada**, não por qual busca a encontrou. Esse defeito apareceu no teste de 20 envios paralelos para wallet inexistente.

## Revisão de 2026-11-13: chave escopada por provedor
A primeira versão tinha `UNIQUE (idempotency_key)`, global. Um code review apontou que dois provedores com a mesma chave colidiam, e que um podia ocupar a chave de outro. A chave passou a ser única por provedor, numa segunda migration, e a busca passou a filtrar por `(provider_id, idempotency_key)`. Regra geral: toda chave fornecida pelo cliente é escopada por quem a forneceu.

## Riscos
- Mudar o conjunto de campos do hash quebra replays antigos. Mitigação: algoritmo documentado e versionável.
