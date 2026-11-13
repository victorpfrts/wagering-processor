import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { NOOP_METRICS } from '../../src/application/ports.ts';
import { WageringQueries } from '../../src/application/queries.ts';
import { MikroOrmReadModel } from '../../src/infrastructure/db/mikro-orm-read-model.ts';
import { type HttpApp, startHttpApp } from '../support/http-app.ts';
import { uuid } from '../support/test-database.ts';

let http: HttpApp;
beforeAll(async () => {
  http = await startHttpApp();
});
afterAll(async () => {
  await http.close();
});

type Json = Record<string, any>;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(balance = '1000.00', playerId = uuid()): Promise<Json> {
  const response = await http.post('/wallets', { playerId, initialBalance: brl(balance) });
  expect(response.status).toBe(201);
  return (await response.json()) as Json;
}

async function bet(wallet: Json, amount: string, extra: Json = {}): Promise<Json> {
  const externalTransactionId = `ext-${uuid()}`;
  const response = await http.post(
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet['playerId'],
      walletId: wallet['id'],
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl(amount),
      ...extra,
    },
    { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
  );
  return { ...((await response.json()) as Json), externalTransactionId, httpStatus: response.status };
}

const getJson = async (path: string) => {
  const response = await http.get(path);
  return { status: response.status, body: (await response.json()) as Json };
};

describe('POST /wallets', () => {
  test('201 com o contrato do enunciado; saldo inicial gera OPENING + CREDIT na mesma transação', async () => {
    const playerId = uuid();
    const response = await http.post('/wallets', { playerId, initialBalance: brl('1000.00') });
    const wallet = (await response.json()) as Json;

    expect(response.status).toBe(201);
    expect(wallet).toEqual({
      id: expect.any(String),
      playerId,
      balance: brl('1000.00'),
      version: 1,
    });
    expect(response.headers.get('location')).toBe(`/wallets/${wallet['id']}`);

    const ledger = await getJson(`/wallets/${wallet['id']}/ledger`);
    expect(ledger.body['items']).toMatchObject([
      {
        direction: 'CREDIT',
        money: brl('1000.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1000.00'),
        walletVersion: 1,
      },
    ]);

    const opening = await getJson(
      `/providers/internal/wagering/transactions/${encodeURIComponent(`opening:${wallet['id']}`)}`,
    );
    expect(opening.body).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      transactionId: ledger.body['items'][0].transactionId,
    });

    const events = await http.db.sql`
      select event_type from outbox_messages where partition_key = ${wallet['id']} order by seq`;
    expect(events.map((e: Json) => e['event_type'])).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('saldo inicial zero: versão 1, sem transação, sem lançamento, sem evento', async () => {
    const wallet = await openWallet('0.00');
    expect(wallet).toMatchObject({ balance: brl('0.00'), version: 1 });
    const ledger = await getJson(`/wallets/${wallet['id']}/ledger`);
    expect(ledger.body).toEqual({ items: [], nextCursor: null });
    const [{ count }] =
      await http.db.sql`select count(*)::int as count from outbox_messages where partition_key = ${wallet['id']}`;
    expect(count).toBe(0);
  });

  test('409 para wallet duplicada do mesmo player + moeda; outra moeda é permitida', async () => {
    const playerId = uuid();
    await openWallet('10.00', playerId);
    const duplicate = await http.post('/wallets', { playerId, initialBalance: brl('99.00') });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });

    const usd = await http.post('/wallets', {
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
  });

  test('10 aberturas simultâneas do mesmo player → exatamente uma wallet', async () => {
    const playerId = uuid();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        http.post('/wallets', { playerId, initialBalance: brl('50.00') }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    const [{ wallets, entries }] = await http.db.sql`
      select count(distinct w.id)::int as wallets, count(e.id)::int as entries
        from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
       where w.player_id = ${playerId}`;
    expect({ wallets, entries }).toEqual({ wallets: 1, entries: 1 });
  });

  test.each([
    ['saldo negativo', { playerId: 'p', initialBalance: brl('-1.00') }],
    ['saldo como number', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    ['3 casas decimais', { playerId: 'p', initialBalance: brl('1.005') }],
    ['sem playerId', { initialBalance: brl('1.00') }],
    ['sem saldo inicial', { playerId: 'p' }],
  ])('400: %s', async (_name, payload) => {
    const response = await http.post('/wallets', payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('GET /wallets/:walletId', () => {
  test('200 com saldo e versão atuais', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '30.00');
    const { status, body } = await getJson(`/wallets/${wallet['id']}`);
    expect(status).toBe(200);
    expect(body).toEqual({ ...wallet, balance: brl('70.00'), version: 2 });
  });

  test('404 para wallet inexistente e 400 para id malformado', async () => {
    expect((await getJson(`/wallets/${uuid()}`)).status).toBe(404);
    expect((await getJson('/wallets/not-a-uuid')).status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pagina do mais recente para o mais antigo, sem repetir nem pular', async () => {
    const wallet = await openWallet('100.00');
    for (let i = 0; i < 7; i += 1) await bet(wallet, '1.00');

    const versions: number[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? 'limit=3' : `limit=3&cursor=${cursor}`;
      const page = await getJson(`/wallets/${wallet['id']}/ledger?${query}`);
      expect(page.status).toBe(200);
      sizes.push(page.body['items'].length);
      versions.push(...page.body['items'].map((item: Json) => item['walletVersion']));
      cursor = page.body['nextCursor'];
    } while (cursor !== null);

    expect(sizes).toEqual([3, 3, 2]);
    expect(versions).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test('cursor é estável: lançamentos novos não alteram as páginas seguintes', async () => {
    const wallet = await openWallet('100.00');
    for (let i = 0; i < 4; i += 1) await bet(wallet, '1.00');
    const first = await getJson(`/wallets/${wallet['id']}/ledger?limit=2`);
    expect(first.body['items'].map((i: Json) => i['walletVersion'])).toEqual([5, 4]);

    await bet(wallet, '1.00');
    await bet(wallet, '1.00');

    const second = await getJson(
      `/wallets/${wallet['id']}/ledger?limit=2&cursor=${first.body['nextCursor']}`,
    );
    expect(second.body['items'].map((i: Json) => i['walletVersion'])).toEqual([3, 2]);
  });

  test('cursor é opaco e validado; limit tem teto', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '1.00');
    const page = await getJson(`/wallets/${wallet['id']}/ledger?limit=1`);
    expect(page.body['nextCursor']).toMatch(/^[A-Za-z0-9_-]+$/);

    for (const query of ['cursor=garbage', 'cursor=eyJ2IjotMX0', 'limit=0', 'limit=201', 'limit=abc', 'x=1']) {
      const response = await getJson(`/wallets/${wallet['id']}/ledger?${query}`);
      expect(response.status).toBe(400);
    }
    expect((await getJson(`/wallets/${uuid()}/ledger`)).status).toBe(404);
  });
});

describe('consulta de transações', () => {
  test('por id interno e por (providerId, externalTransactionId)', async () => {
    const wallet = await openWallet('100.00');
    const processed = await bet(wallet, '25.00');
    const rejected = await bet(wallet, '500.00');

    const byId = await getJson(`/wagering/transactions/${processed['transactionId']}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: processed['transactionId'],
      providerId: 'provider-a',
      externalTransactionId: processed['externalTransactionId'],
      walletId: wallet['id'],
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      balance: brl('75.00'),
    });
    expect(byId.body).not.toHaveProperty('failureCode');

    const byExternal = await getJson(
      `/providers/provider-a/wagering/transactions/${rejected['externalTransactionId']}`,
    );
    expect(byExternal.body).toMatchObject({
      transactionId: rejected['transactionId'],
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('75.00'),
    });
  });

  test('404 quando não existe (inclusive id externo de outro provedor) e 400 para id malformado', async () => {
    const wallet = await openWallet('100.00');
    const processed = await bet(wallet, '1.00');
    expect((await getJson(`/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await getJson('/wagering/transactions/abc')).status).toBe(400);
    expect(
      (
        await getJson(
          `/providers/provider-b/wagering/transactions/${processed['externalTransactionId']}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet consistente: contrato do enunciado', async () => {
    const wallet = await openWallet('1000.00');
    await bet(wallet, '25.00');
    const response = await http.post(`/wallets/${wallet['id']}/reconciliation`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet['id'],
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada, logada, contada e NÃO corrigida', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '40.00');
    // Corrompe o saldo por fora da aplicação. O banco normalmente impede:
    // é preciso desligar o trigger de consistência para conseguir.
    await http.db.sql`alter table wallets disable trigger wallet_matches_ledger`;
    await http.db.sql`update wallets set balance = 75.00 where id = ${wallet['id']}`;
    await http.db.sql`alter table wallets enable trigger wallet_matches_ledger`;

    const response = await http.post(`/wallets/${wallet['id']}/reconciliation`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet['id'],
      storedBalance: brl('75.00'),
      calculatedBalance: brl('60.00'),
      difference: brl('15.00'),
      consistent: false,
      checkedEntries: 2,
    });

    // log e métrica, observados pelas portas
    const orm = await MikroORM.init({ ...http.app.get(MikroORM).config.getAll(), logger: () => {} });
    const logs: { message: string; fields: unknown }[] = [];
    let divergences = 0;
    const queries = new WageringQueries(
      new MikroOrmReadModel(orm),
      {
        info: () => {},
        warn: () => {},
        error: (message, fields) => logs.push({ message, fields }),
      },
      { ...NOOP_METRICS, reconciliationDivergence: () => (divergences += 1) },
    );
    const result = await queries.reconcile(wallet['id']);
    await orm.close(true);
    expect(result.consistent).toBe(false);
    expect(divergences).toBe(1);
    expect(logs).toEqual([
      {
        message: 'wallet balance diverges from ledger',
        fields: { walletId: wallet['id'], checkedEntries: 2 },
      },
    ]);

    // nada foi corrigido em silêncio
    expect((await getJson(`/wallets/${wallet['id']}`)).body['balance']).toEqual(brl('75.00'));
  });

  test('saldo menor que o ledger aparece como diferença negativa', async () => {
    const wallet = await openWallet('100.00');
    await http.db.sql`alter table wallets disable trigger wallet_matches_ledger`;
    await http.db.sql`update wallets set balance = 90.00 where id = ${wallet['id']}`;
    await http.db.sql`alter table wallets enable trigger wallet_matches_ledger`;
    const response = await http.post(`/wallets/${wallet['id']}/reconciliation`, {});
    expect(await response.json()).toMatchObject({ difference: brl('-10.00'), consistent: false });
  });

  test('404 para wallet inexistente', async () => {
    const response = await http.post(`/wallets/${uuid()}/reconciliation`, {});
    expect(response.status).toBe(404);
  });
});
