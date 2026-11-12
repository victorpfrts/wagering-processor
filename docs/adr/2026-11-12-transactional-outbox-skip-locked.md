# ADR-005 — Transactional outbox com `FOR UPDATE SKIP LOCKED`

Data: 2026-11-12 · Status: aceito

## Contexto
Nenhum evento pode sair antes do commit nem ser perdido depois dele. Vários publishers rodam ao mesmo tempo e o processo pode morrer entre o commit e a publicação.

## Opções
1. **Publicar logo após o commit, em memória.** Simples; perde o evento se o processo morre.
2. **CDC (Debezium) lendo o WAL.** Robusto e sem polling; infraestrutura pesada para o escopo.
3. **Tabela `outbox_messages` + worker por polling** com `FOR UPDATE SKIP LOCKED`.

## Decisão
Opção 3.
- O evento é gravado na mesma transação SQL da alteração financeira (e do inbox, quando a entrada é SQS).
- O publisher abre uma transação, seleciona um lote de pendentes vencidos com `FOR UPDATE SKIP LOCKED`, envia ao SQS (`wager-events.fifo`, `MessageGroupId = walletId`, `MessageDeduplicationId = eventId`) e marca `published_at`. Falha de envio: `attempts + 1` e `next_attempt_at` com backoff exponencial.
- Se o processo morre com o lote travado, o banco solta os locks e outra instância assume.

## Consequências
- Entrega at-least-once: o evento pode sair duas vezes (morreu depois de enviar e antes de marcar). O consumidor deduplica por `eventId`.
- Latência de publicação limitada pelo intervalo do polling; medida pela métrica de outbox lag.

## Riscos
- Evento que nunca publica trava a ordem do seu grupo. Mitigação: backoff, métrica de lag e log de erro por tentativa.
