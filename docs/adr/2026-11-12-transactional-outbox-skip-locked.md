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

### Ordem por wallet com vários publishers
`SKIP LOCKED` sozinho não preserva ordem: o publisher A trava os eventos 1 e 2 de uma wallet, o B pega o 3 e pode enviá-lo antes. A regra adotada:
- cada publisher trava apenas as **cabeças** — o evento pendente mais antigo de cada wallet (`NOT EXISTS` um anterior pendente) — com `FOR UPDATE SKIP LOCKED`;
- só quem travou a cabeça busca os demais eventos daquela wallet; para os outros publishers eles não são cabeça e não são selecionados;
- o envio é em rodadas, uma mensagem por wallet por rodada; se uma falha, as seguintes da mesma wallet não são enviadas;
- cabeça em backoff segura a wallet inteira (bloqueio de cabeça de fila, por wallet apenas).

Alternativa testada e descartada: lock consultivo por wallet (`pg_try_advisory_xact_lock`) no `WHERE`. O plano de execução avaliava a função para todas as linhas pendentes antes do `LIMIT`, então um publisher segurava todas as wallets e o outro ficava ocioso — correto, mas sem paralelismo. O teste de dois publishers mostrou o problema.

## Consequências
- Entrega at-least-once: o evento pode sair duas vezes (morreu depois de enviar e antes de marcar). O consumidor deduplica por `eventId`.
- Latência de publicação limitada pelo intervalo do polling; medida pela métrica de outbox lag.

## Riscos
- Evento que nunca publica trava a ordem do seu grupo. Mitigação: backoff, métrica de lag e log de erro por tentativa.
