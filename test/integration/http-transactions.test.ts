import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type HttpApp, startHttpApp } from '../support/http-app.ts';
import { seedWallet, uuid } from '../support/test-database.ts';

let http: HttpApp;
beforeAll(async () => {
  http = await startHttpApp({ lockTimeoutMs: 200 });
});
afterAll(async () => {
  await http.close();
});

function body(walletId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${uuid()}`,
    playerId: `player-${walletId}`,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (payload: Record<string, unknown>, key?: string) =>
  http.post('/wagering/transactions', payload, {
    'Idempotency-Key': key ?? `${payload['providerId']}:${payload['externalTransactionId']}`,
  });

describe('POST /wagering/transactions', () => {
  test('200: processada; o replay devolve a mesma resposta com idempotentReplay: true', async () => {
    const walletId = await seedWallet(http.db.sql, '1000.00');
    const payload = body(walletId);

    const first = await submit(payload);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(firstBody).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(first.headers.get('x-correlation-id')).toBeTruthy();

    const replay = await submit(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...firstBody, idempotentReplay: true });
  });

  test('202: aceita com processamento pendente (referência ainda não chegou)', async () => {
    const walletId = await seedWallet(http.db.sql);
    const response = await submit(
      body(walletId, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  test('422: rejeição por regra de negócio, com failureCode', async () => {
    const walletId = await seedWallet(http.db.sql, '10.00');
    const response = await submit(body(walletId));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
  });

  test('409: mesma key com payload diferente', async () => {
    const walletId = await seedWallet(http.db.sql);
    const payload = body(walletId);
    await submit(payload);
    const response = await submit({ ...payload, money: { amount: '26.00', currency: 'BRL' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('503 + Retry-After: falha transitória (lock disputado); reenviar depois funciona', async () => {
    const walletId = await seedWallet(http.db.sql);
    const payload = body(walletId);
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const holder = http.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${walletId} for update`;
      await release;
    });
    try {
      await Bun.sleep(50);
      const response = await submit(payload);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toMatchObject({
        code: 'TRANSIENT_FAILURE',
        details: { reason: 'LOCK_TIMEOUT' },
      });
    } finally {
      resolve();
      await holder;
    }
    const retry = await submit(payload);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotentReplay: false });
  });

  describe('400: payload inválido', () => {
    const walletId = uuid();
    test.each([
      ['valor como number', { money: { amount: 25, currency: 'BRL' } }],
      ['valor com 3 casas', { money: { amount: '25.001', currency: 'BRL' } }],
      ['valor negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
      ['notação científica', { money: { amount: '1e3', currency: 'BRL' } }],
      ['moeda inválida', { money: { amount: '1.00', currency: 'real' } }],
      ['kind OPENING', { kind: 'OPENING' }],
      ['kind desconhecido', { kind: 'BONUS' }],
      ['walletId que não é UUID', { walletId: 'abc' }],
      ['campo obrigatório vazio', { roundId: '' }],
      ['campo desconhecido', { bonus: true }],
      ['REFUND sem referência', { kind: 'REFUND' }],
      ['BET com referência', { referenceExternalTransactionId: 'x' }],
    ])('%s', async (_name, overrides) => {
      const response = await submit(body(walletId, overrides));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    test('sem o header Idempotency-Key', async () => {
      const response = await http.post('/wagering/transactions', body(walletId));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'Idempotency-Key header' }],
      });
    });

    test('JSON malformado', async () => {
      const response = await http.post('/wagering/transactions', '{"broken":', {
        'Idempotency-Key': 'k',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    test('nada é gravado para payload inválido', async () => {
      const [{ count }] =
        await http.db.sql`select count(*)::int as count from wager_transactions where wallet_id = ${walletId}`;
      expect(count).toBe(0);
    });
  });

  test('404: rota inexistente usa o mesmo formato de erro', async () => {
    const response = await http.get('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('health/live responde sem autenticação', async () => {
    const response = await http.get('/health/live');
    expect(response.status).toBe(200);
  });
});
