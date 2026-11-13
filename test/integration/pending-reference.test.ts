import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ProcessWagerTransaction } from '../../src/application/process-wager-transaction.ts';
import { RetryPendingReferences } from '../../src/application/retry-pending-references.ts';
import { REFERENCE_RETRY_POLICY } from '../../src/domain/backoff.ts';
import { MikroOrmReadModel } from '../../src/infrastructure/db/mikro-orm-read-model.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/db/mikro-orm-unit-of-work.ts';
import { NoopMetrics } from '../../src/infrastructure/observability.ts';
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

/** PostgreSQL real; o relógio é controlado para o backoff não custar minutos de teste. */
let h: Harness;
let now: Date;
const clock = { now: () => now };
let process: ProcessWagerTransaction;

beforeAll(async () => {
  h = await createHarness();
  process = h.processWith({ clock });
});
afterAll(async () => {
  await h.close();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function worker(): RetryPendingReferences {
  return new RetryPendingReferences(
    new MikroOrmReadModel(h.orm),
    new MikroOrmUnitOfWork(h.orm, { lockTimeoutMs: 5000 }),
    process,
    clock,
    silentLogger,
    new NoopMetrics(),
    100,
  );
}

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/** Cada teste começa num instante próprio e sem pendências dos anteriores. */
async function freshStart(): Promise<void> {
  now = new Date('2026-07-29T15:00:00.000Z');
  await h.db.sql`
    update wager_transactions
       set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
           next_attempt_at = null, processed_at = now()
     where status = 'PENDING_REFERENCE'`;
}

const reversalOf = (walletId: string, kind: string, reference: string, amount: string) =>
  command(walletId, {
    kind,
    money: brlProps(amount),
    referenceExternalTransactionId: reference,
  });

async function pendingState(walletId: string) {
  const [row] = await h.db.sql`
    select status, reference_attempts, next_attempt_at, failure_code
      from wager_transactions
     where wallet_id = ${walletId} and kind in ('REFUND', 'ROLLBACK')`;
  return { ...row } as {
    status: string;
    reference_attempts: number;
    next_attempt_at: Date | null;
    failure_code: string | null;
  };
}

describe('referência fora de ordem', () => {
  test('REFUND chega antes da BET; quando a BET chega, o worker aplica o REFUND', async () => {
    await freshStart();
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('40.00') });
    const refund = reversalOf(walletId, 'REFUND', bet.externalTransactionId, '40.00');

    expect(await process.execute(refund)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await process.execute(bet)).toMatchObject({ status: 'PROCESSED' });
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '60.00' });

    // ainda não venceu (primeira tentativa em 2s): o worker não toca
    advance(1_999);
    expect(await worker().execute()).toBe(0);
    expect((await pendingState(walletId)).status).toBe('PENDING_REFERENCE');

    advance(1);
    expect(await worker().execute()).toBe(1);

    expect(await pendingState(walletId)).toMatchObject({
      status: 'PROCESSED',
      next_attempt_at: null,
    });
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '100.00',
      debits: 1,
      credits: 2,
    });
    // PendingReference é publicado uma única vez
    expect(await outboxEvents(h, walletId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    // a requisição original, reenviada, devolve o desfecho final
    expect(await process.execute(refund)).toMatchObject({
      status: 'PROCESSED',
      balance: brlProps('100.00'),
      idempotentReplay: true,
    });
    // e nada mais fica pendente
    expect(await worker().execute()).toBe(0);
  });

  test('ROLLBACK chega antes do WIN; depois é aplicado como débito', async () => {
    await freshStart();
    const walletId = await newWallet(h, '100.00');
    const win = command(walletId, { kind: 'WIN', money: brlProps('30.00') });
    const rollback = reversalOf(walletId, 'ROLLBACK', win.externalTransactionId, '30.00');

    await process.execute(rollback);
    await process.execute(win);
    advance(2_000);
    expect(await worker().execute()).toBe(1);

    expect((await pendingState(walletId)).status).toBe('PROCESSED');
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '100.00',
      debits: 1,
      credits: 2,
    });
  });

  test('a referência chega mas não serve: REJECTED com o motivo real', async () => {
    await freshStart();
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('40.00'), roundId: 'another-round' });
    await process.execute(reversalOf(walletId, 'REFUND', bet.externalTransactionId, '40.00'));
    await process.execute(bet);

    advance(2_000);
    await worker().execute();

    expect(await pendingState(walletId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_MISMATCH',
    });
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '60.00', credits: 1 });
  });
});

describe('backoff e limite de tentativas', () => {
  test('referência nunca chega: 2s, 4s, 8s, 16s, 32s, 64s e então REFERENCE_NOT_FOUND', async () => {
    await freshStart();
    const walletId = await newWallet(h, '100.00');
    const start = now.getTime();
    await process.execute(reversalOf(walletId, 'REFUND', 'never-arrives', '10.00'));

    const waits: number[] = [];
    for (let attempt = 1; ; attempt += 1) {
      const state = await pendingState(walletId);
      if (state.status !== 'PENDING_REFERENCE') break;
      const next = state.next_attempt_at as Date;
      waits.push((next.getTime() - now.getTime()) / 1000);
      expect(state.reference_attempts).toBe(attempt - 1);

      // um instante antes do horário nada acontece
      now = new Date(next.getTime() - 1);
      expect(await worker().execute()).toBe(0);
      now = next;
      expect(await worker().execute()).toBe(1);
    }

    expect(waits).toEqual([2, 4, 8, 16, 32, 64]);
    expect(waits).toHaveLength(REFERENCE_RETRY_POLICY.maxAttempts);
    expect((now.getTime() - start) / 1000).toBe(126); // ~2 minutos no total

    expect(await pendingState(walletId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      next_attempt_at: null,
    });
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1 });
    expect(await outboxEvents(h, walletId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    const [rejected] = await h.db.sql`
      select payload from outbox_messages
       where partition_key = ${walletId} and event_type = 'WagerTransactionRejected'`;
    expect(rejected.payload.data).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND' });
  });
});

describe('várias instâncias do worker', () => {
  test('três workers sobre as mesmas pendências: cada uma é resolvida uma única vez', async () => {
    await freshStart();
    const walletIds = await Promise.all(Array.from({ length: 10 }, () => newWallet(h, '100.00')));
    for (const walletId of walletIds) {
      const first = command(walletId, { money: brlProps('10.00') });
      const second = command(walletId, { money: brlProps('20.00') });
      await process.execute(reversalOf(walletId, 'REFUND', first.externalTransactionId, '10.00'));
      await process.execute(reversalOf(walletId, 'REFUND', second.externalTransactionId, '20.00'));
      await process.execute(first);
      await process.execute(second);
    }

    advance(2_000);
    const handled = await Promise.all([worker().execute(), worker().execute(), worker().execute()]);

    // 20 pendências, nenhuma tratada duas vezes
    expect(handled.reduce((sum, n) => sum + n, 0)).toBe(20);
    for (const walletId of walletIds) {
      expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
        balance: '100.00',
        debits: 2,
        credits: 3,
        version: 5,
      });
      const rows = await transactionRows(h, walletId);
      expect(rows.filter((row) => row.kind === 'REFUND' && row.status === 'PROCESSED')).toHaveLength(2);
    }
  });

  test('wallet travada: a pendência fica para a próxima rodada e as outras seguem', async () => {
    await freshStart();
    const blocked = await newWallet(h, '100.00');
    const free = await newWallet(h, '100.00');
    for (const walletId of [blocked, free]) {
      const bet = command(walletId, { money: brlProps('10.00') });
      await process.execute(reversalOf(walletId, 'REFUND', bet.externalTransactionId, '10.00'));
      await process.execute(bet);
    }
    advance(2_000);

    const { promise: release, resolve } = Promise.withResolvers<void>();
    const holder = h.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${blocked} for update`;
      await release;
    });
    const impatient = new RetryPendingReferences(
      new MikroOrmReadModel(h.orm),
      new MikroOrmUnitOfWork(h.orm, { lockTimeoutMs: 100 }),
      process,
      clock,
      silentLogger,
      new NoopMetrics(),
      100,
    );
    try {
      await Bun.sleep(50);
      expect(await impatient.execute()).toBe(1);
      expect((await pendingState(free)).status).toBe('PROCESSED');
      expect((await pendingState(blocked)).status).toBe('PENDING_REFERENCE');
    } finally {
      resolve();
      await holder;
    }

    expect(await impatient.execute()).toBe(1);
    expect((await pendingState(blocked)).status).toBe('PROCESSED');
    await expectLedgerConsistent(h, blocked);
  });
});
