import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { createPino, PinoAppLogger } from '../../src/infrastructure/observability/pino-logger.ts';
import { WagerMessageHandler } from '../../src/interfaces/sqs/wager-message-handler.ts';
import { command, createHarness, type Harness, newWallet, playerOf } from '../support/harness.ts';
import { type HttpApp, startHttpApp } from '../support/http-app.ts';
import { seedWallet, uuid } from '../support/test-database.ts';

type Json = Record<string, any>;

function captureLogs() {
  const lines: Json[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line) as Json);
      }
      done();
    },
  });
  return { lines, logger: new PinoAppLogger(createPino('info', stream)) };
}

describe('logs estruturados', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  test('entrada HTTP: JSON com correlationId, transactionId, walletId e providerId — sem valores', async () => {
    const { lines, logger } = captureLogs();
    const walletId = await newWallet(h, '987.65');
    const process = h.processWith({ logger });

    const result = await process.execute(
      command(walletId, {
        correlationId: 'corr-123',
        money: { amount: '123.45', currency: 'BRL' },
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'wager transaction handled',
      service: 'wagering-processor',
      correlationId: 'corr-123',
      transactionId: result.transactionId,
      walletId,
      providerId: 'provider-a',
      source: 'http',
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(lines[0]?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // nenhum dado financeiro: nem a aposta, nem o saldo anterior, nem o novo
    const raw = JSON.stringify(lines);
    for (const forbidden of ['123.45', '987.65', '864.20', 'amount', 'balance', 'money']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test('entrada por fila: o log carrega também o messageId', async () => {
    const { lines, logger } = captureLogs();
    const walletId = await newWallet(h, '100.00');
    const handler = new WagerMessageHandler(h.processWith({ logger }), logger);
    const externalTransactionId = `ext-${uuid()}`;

    await handler.handle(
      JSON.stringify({
        messageId: 'msg-777',
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: playerOf(walletId),
          walletId,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      }),
    );

    expect(lines[0]).toMatchObject({
      msg: 'wager transaction handled',
      messageId: 'msg-777',
      correlationId: 'msg-777',
      walletId,
      providerId: 'provider-a',
      source: 'queue',
    });
    expect(JSON.stringify(lines)).not.toContain('25.00');
  });

  test('rejeição e falha transitória também são logadas com rastreio', async () => {
    const { lines, logger } = captureLogs();
    const walletId = await newWallet(h, '1.00');
    await h.processWith({ logger }).execute(command(walletId));
    expect(lines[0]).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', walletId });

    const { promise: release, resolve } = Promise.withResolvers<void>();
    const holder = h.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${walletId} for update`;
      await release;
    });
    try {
      await Bun.sleep(50);
      await h
        .processWith({ logger, lockTimeoutMs: 100 })
        .execute(command(walletId, { correlationId: 'corr-lock' }))
        .catch(() => {});
    } finally {
      resolve();
      await holder;
    }
    expect(lines.at(-1)).toMatchObject({
      level: 'warn',
      msg: 'transient failure; nothing was committed',
      correlationId: 'corr-lock',
      reason: 'LOCK_TIMEOUT',
      walletId,
    });
  });

  test('segunda barreira: chaves financeiras são mascaradas mesmo se alguém as logar', () => {
    const { lines, logger } = captureLogs();
    logger.info('oops', {
      walletId: 'w-1',
      money: { amount: '10.00', currency: 'BRL' },
      balance: '99.00',
      payload: { anything: true },
      nested: { amount: '5.00', authorization: 'Bearer secret', keep: 'visible' },
    });
    expect(lines[0]).toMatchObject({
      walletId: 'w-1',
      money: '[REDACTED]',
      balance: '[REDACTED]',
      payload: '[REDACTED]',
      nested: { amount: '[REDACTED]', authorization: '[REDACTED]', keep: 'visible' },
    });
  });
});

describe('GET /metrics', () => {
  let http: HttpApp;
  let metrics = '';
  const value = (pattern: RegExp): number => {
    const line = metrics.split('\n').find((candidate) => pattern.test(candidate));
    return line === undefined ? Number.NaN : Number(line.slice(line.lastIndexOf(' ') + 1));
  };
  const scrape = async () => {
    const response = await http.get('/metrics');
    metrics = await response.text();
    return response;
  };

  beforeAll(async () => {
    http = await startHttpApp({ lockTimeoutMs: 100 });
    const walletId = await seedWallet(http.db.sql, '100.00');
    const submit = (overrides: Json = {}, key?: string) => {
      const externalTransactionId = (overrides['externalTransactionId'] as string) ?? `ext-${uuid()}`;
      return http.post(
        '/wagering/transactions',
        {
          providerId: 'provider-a',
          externalTransactionId,
          playerId: `player-${walletId}`,
          walletId,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
          ...overrides,
        },
        { 'Idempotency-Key': key ?? `provider-a:${externalTransactionId}` },
      );
    };

    await submit({ externalTransactionId: 'bet-1' }); // PROCESSED (saldo 70)
    await submit({ externalTransactionId: 'bet-1' }); // replay
    await submit({ externalTransactionId: 'bet-1', money: { amount: '31.00', currency: 'BRL' } }); // conflito
    await submit({ money: { amount: '500.00', currency: 'BRL' } }); // REJECTED
    await submit({ kind: 'REFUND', referenceExternalTransactionId: 'missing' }); // PENDING_REFERENCE
    await submit({ money: { amount: 'abc', currency: 'BRL' } }); // 400

    // lock disputado → conflito de concorrência
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const holder = http.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${walletId} for update`;
      await release;
    });
    await Bun.sleep(50);
    await submit();
    resolve();
    await holder;

    // divergência na reconciliação
    await http.db.sql`alter table wallets disable trigger wallet_matches_ledger`;
    await http.db.sql`update wallets set balance = balance + 1 where id = ${walletId}`;
    await http.db.sql`alter table wallets enable trigger wallet_matches_ledger`;
    await http.post(`/wallets/${walletId}/reconciliation`, {});
    await http.get(`/wallets/${walletId}`);

    await scrape();
  });
  afterAll(async () => {
    await http.close();
  });

  test('é público e está no formato de exposição do Prometheus', async () => {
    const response = await scrape();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(metrics).toContain('# TYPE wagering_transactions_total counter');
  });

  test('transações por status', () => {
    expect(value(/^wagering_transactions_total\{kind="BET",status="PROCESSED",failure_code="",source="http"\}/)).toBe(1);
    expect(value(/^wagering_transactions_total\{kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS",source="http"\}/)).toBe(1);
    expect(value(/^wagering_transactions_total\{kind="REFUND",status="PENDING_REFERENCE",.*source="http"\}/)).toBe(1);
  });

  test('duplicatas detectadas', () => {
    expect(value(/^wagering_duplicates_total\{type="idempotent_replay"\}/)).toBe(1);
    expect(value(/^wagering_duplicates_total\{type="idempotency_conflict"\}/)).toBe(1);
  });

  test('conflitos de lock', () => {
    expect(value(/^wagering_concurrency_conflicts_total\{reason="LOCK_TIMEOUT"\}/)).toBe(1);
  });

  test('latência de processamento, por desfecho', () => {
    expect(value(/^wagering_processing_duration_seconds_count\{source="http",outcome="processed"\}/)).toBe(1);
    expect(value(/^wagering_processing_duration_seconds_count\{source="http",outcome="replay"\}/)).toBe(1);
    expect(value(/^wagering_processing_duration_seconds_count\{source="http",outcome="transient_failure"\}/)).toBe(1);
    expect(value(/^wagering_processing_duration_seconds_count\{source="http",outcome="invalid"\}/)).toBe(1);
    expect(value(/^wagering_processing_duration_seconds_sum\{source="http",outcome="processed"\}/)).toBeGreaterThan(0);
  });

  test('outbox lag: pendentes e idade do mais antigo (publisher desligado neste teste)', () => {
    // 2 da BET + 1 da rejeição + 1 da pendência
    expect(value(/^wagering_outbox_pending_messages /)).toBe(4);
    expect(value(/^wagering_outbox_lag_seconds /)).toBeGreaterThan(0);
  });

  test('DLQ, retries e reconciliação estão expostos', () => {
    expect(value(/^wagering_dlq_messages /)).toBeGreaterThanOrEqual(0);
    expect(metrics).toContain('# TYPE wagering_messages_total counter');
    expect(metrics).toContain('# TYPE wagering_pending_reference_retries_total counter');
    expect(metrics).toContain('# TYPE wagering_outbox_publish_total counter');
    expect(value(/^wagering_reconciliation_divergences_total /)).toBe(1);
  });

  test('latência HTTP usa o padrão da rota, sem ids nos rótulos', () => {
    expect(value(/^wagering_http_request_duration_seconds_count\{method="POST",route="\/wagering\/transactions",status="200"\}/)).toBe(2);
    expect(value(/^wagering_http_request_duration_seconds_count\{method="POST",route="\/wagering\/transactions",status="503"\}/)).toBe(1);
    expect(value(/^wagering_http_request_duration_seconds_count\{method="GET",route="\/wallets\/:walletId",status="200"\}/)).toBe(1);
    expect(metrics).not.toMatch(/route="\/wallets\/[0-9a-f]{8}-/);
  });

  test('métricas do processo (memória, event loop) também saem', () => {
    expect(metrics).toContain('process_resident_memory_bytes');
  });
});
