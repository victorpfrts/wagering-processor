import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
} from '../../src/application/errors.ts';
import type { WagerTransactionResult } from '../../src/application/process-wager-transaction.ts';
import {
  brlProps,
  command,
  createHarness,
  expectLedgerConsistent,
  type Harness,
  newWallet,
  outboxEvents,
  snapshot,
  transactionRows,
} from '../support/harness.ts';
import { uuid } from '../support/test-database.ts';

/**
 * Paralelismo real: as chamadas saem juntas e disputam conexões diferentes
 * do pool contra um PostgreSQL de verdade. Nada aqui é sequencial ou mockado.
 * (Vários PROCESSOS disputando o mesmo banco ficam em multi-instance.test.ts.)
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const count = (results: WagerTransactionResult[], predicate: (r: WagerTransactionResult) => boolean) =>
  results.filter(predicate).length;

describe('mesma aposta repetida', () => {
  test('50 envios paralelos da mesma aposta → um único débito', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('30.00') });

    const results = await Promise.all(Array.from({ length: 50 }, () => h.process.execute(bet)));

    expect(count(results, (r) => !r.idempotentReplay)).toBe(1);
    expect(count(results, (r) => r.idempotentReplay)).toBe(49);
    // todos recebem exatamente a mesma resposta
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '70.00')).toBe(true);

    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '70.00',
      version: 2,
      debits: 1,
    });
    expect(await transactionRows(h, walletId)).toHaveLength(1);
    expect(await outboxEvents(h, walletId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('mesma key com dois payloads em paralelo → um vence, o outro é conflito', async () => {
    const walletId = await newWallet(h, '100.00');
    const a = command(walletId, { money: brlProps('10.00') });
    const b = { ...a, money: brlProps('20.00') };

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => h.process.execute(i % 2 === 0 ? a : b)),
    );
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((s) => s.reason instanceof IdempotencyConflictError)).toBe(true);
    const state = await expectLedgerConsistent(h, walletId);
    expect(state.debits).toBe(1);
    expect(['90.00', '80.00']).toContain(state.balance);
  });

  test('wallet inexistente, 20 envios paralelos → uma única transação REJECTED', async () => {
    // Sem wallet não há linha para travar: quem decide é o índice único.
    const walletId = uuid();
    const bet = command(walletId);
    const results = await Promise.all(Array.from({ length: 20 }, () => h.process.execute(bet)));

    expect(results.every((r) => r.failureCode === 'WALLET_NOT_FOUND')).toBe(true);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await transactionRows(h, walletId)).toHaveLength(1);
  });
});

describe('disputa de saldo na mesma wallet', () => {
  test('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const walletId = await newWallet(h, '100.00');

    const results = await Promise.all([
      h.process.execute(command(walletId, { money: brlProps('80.00') })),
      h.process.execute(command(walletId, { money: brlProps('80.00') })),
    ]);

    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(1);
    expect(count(results, (r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(1);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '20.00',
      debits: 1,
    });

    // nenhum retry duplica o débito
    const rows = await transactionRows(h, walletId);
    const replays = await Promise.all(
      rows.map((row) =>
        h.process.execute(
          command(walletId, {
            money: brlProps('80.00'),
            externalTransactionId: row.idempotency_key.replace('provider-a:', ''),
          }),
        ),
      ),
    );
    expect(replays.every((r) => r.idempotentReplay)).toBe(true);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '20.00', debits: 1 });
  });

  test('wallet quente: 100 apostas de 1.00 sobre saldo 60 → exatamente 60 passam', async () => {
    const walletId = await newWallet(h, '60.00');

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        h.process.execute(command(walletId, { money: brlProps('1.00') })),
      ),
    );

    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(60);
    expect(count(results, (r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(40);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '0.00',
      version: 61,
      debits: 60,
    });
    // cada saldo intermediário foi observado por exatamente uma aposta: sem lost update
    const observed = results.filter((r) => r.status === 'PROCESSED').map((r) => r.balance?.amount);
    expect(new Set(observed).size).toBe(60);
  });

  test('créditos e débitos misturados mantêm saldo == ledger', async () => {
    const walletId = await newWallet(h, '50.00');
    const operations = Array.from({ length: 80 }, (_, i) =>
      i % 3 === 0
        ? command(walletId, { kind: 'WIN', money: brlProps('7.25') })
        : command(walletId, { money: brlProps('4.10') }),
    );

    const results = await Promise.all(operations.map((op) => h.process.execute(op)));

    const state = await expectLedgerConsistent(h, walletId);
    const wins = 27;
    const acceptedBets = count(results, (r) => r.status === 'PROCESSED') - wins;
    expect(state.credits).toBe(wins + 1); // + abertura
    expect(state.debits).toBe(acceptedBets);
    expect(state.version).toBe(1 + wins + acceptedBets);
    const expectedCents = 5000 + wins * 725 - acceptedBets * 410;
    expect(state.balance).toBe((expectedCents / 100).toFixed(2));
  });

  test('REFUND e ROLLBACK simultâneos da mesma BET → só uma reversão', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('40.00') });
    await h.process.execute(bet);
    const reversal = (kind: string) =>
      command(walletId, {
        kind,
        money: brlProps('40.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.process.execute(reversal(i % 2 === 0 ? 'REFUND' : 'ROLLBACK')),
      ),
    );

    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(1);
    expect(count(results, (r) => r.failureCode === 'REFERENCE_ALREADY_REVERSED')).toBe(9);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '100.00', credits: 2 });
  });
});

describe('wallets distintas', () => {
  test('30 wallets processadas em paralelo não interferem entre si', async () => {
    const walletIds = await Promise.all(Array.from({ length: 30 }, () => newWallet(h, '100.00')));

    const results = await Promise.all(
      walletIds.flatMap((walletId) =>
        Array.from({ length: 5 }, () =>
          h.process.execute(command(walletId, { money: brlProps('30.00') })),
        ),
      ),
    );

    // 100 / 30 → 3 apostas passam e 2 são rejeitadas, em cada wallet
    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(90);
    expect(count(results, (r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(60);
    for (const walletId of walletIds) {
      expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
        balance: '10.00',
        version: 4,
        debits: 3,
      });
    }
  });

  test('o lock é por wallet: uma wallet travada não atrasa as outras', async () => {
    const blocked = await newWallet(h, '100.00');
    const free = await newWallet(h, '100.00');
    const { promise: release, resolve } = Promise.withResolvers<void>();

    const holder = h.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${blocked} for update`;
      await release;
    });
    try {
      await Bun.sleep(50);
      const result = await h
        .processWith({ lockTimeoutMs: 200 })
        .execute(command(free, { money: brlProps('10.00') }));
      expect(result).toMatchObject({ status: 'PROCESSED' });
    } finally {
      resolve();
      await holder;
    }
  });
});

describe('lock disputado além do limite', () => {
  test('vira falha transitória, nada é gravado e a nova tentativa processa', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('10.00') });
    const { promise: release, resolve } = Promise.withResolvers<void>();

    const holder = h.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${walletId} for update`;
      await release;
    });
    try {
      await Bun.sleep(50);
      const attempt = h.processWith({ lockTimeoutMs: 150 }).execute(bet);
      await expect(attempt).rejects.toThrow(TransientInfrastructureError);
      await expect(attempt).rejects.toMatchObject({ reason: 'LOCK_TIMEOUT' });
    } finally {
      resolve();
      await holder;
    }

    expect(await transactionRows(h, walletId)).toHaveLength(0);
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1 });

    const retry = await h.process.execute(bet);
    expect(retry).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    await expectLedgerConsistent(h, walletId);
  });
});
