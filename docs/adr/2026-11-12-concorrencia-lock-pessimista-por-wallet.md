# ADR-002 — Lock pessimista por wallet

Data: 2026-11-12 · Status: aceito

## Contexto
Várias instâncias podem tocar a mesma wallet ao mesmo tempo. Não pode haver lost update, saldo negativo nem lock global. A unidade de concorrência é a `walletId`.

## Opções
1. **Optimistic locking (`version`) com retry limitado.** Sem bloqueio; ótimo quando conflito é raro. Em wallet quente gera muitos retries e, esgotado o limite, falha transitória para o provedor.
2. **Update atômico condicionado** (`UPDATE ... SET balance = balance - x WHERE balance >= x RETURNING`). Simples e rápido para BET, mas REFUND/ROLLBACK precisam ler e validar a referência de forma serializada com a alteração do saldo.
3. **Lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet) no início da transação.

## Decisão
Opção 3. Toda operação financeira abre a transação, trava a linha da wallet e só então lê idempotência, referência e saldo. Há um único lock por transação e ele é sempre o primeiro, então não há ordem de locks a inverter (sem deadlock entre operações).

Complementos:
- `SET LOCAL lock_timeout` curto: espera longa vira erro transitório (HTTP 503 / retry na fila) e conta na métrica de conflitos de lock.
- `CHECK (balance >= 0)` no schema como rede de segurança: mesmo com bug na aplicação o banco recusa saldo negativo.
- `version` continua existindo e incrementa a cada mudança de saldo; serve de número de sequência do ledger (`UNIQUE (wallet_id, wallet_version)`).

## Consequências
- Operações da mesma wallet são serializadas: a vazão por wallet é limitada pelo tempo da transação. Wallets diferentes seguem em paralelo.
- A transação precisa ser curta: nenhuma chamada de rede (SQS) dentro dela.

## Riscos
- Transação presa segurando o lock. Mitigação: `lock_timeout`, `statement_timeout` e `idle_in_transaction_session_timeout`.
