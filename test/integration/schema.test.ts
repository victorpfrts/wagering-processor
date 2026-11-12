import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertEntry,
  insertTransaction,
  insertWalletRow,
  seedMovement,
  seedWallet,
  type TestDatabase,
  uuid,
} from '../support/test-database.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const violates = (promise: Promise<unknown>, pattern: RegExp) =>
  expect(promise).rejects.toThrow(pattern);

describe('migrations', () => {
  test('são reversíveis: down remove tudo e up recria', async () => {
    const scratch = await createTestDatabase();
    try {
      const tables = async () =>
        (
          await scratch.sql`
            select table_name from information_schema.tables
             where table_schema = 'public' and table_name <> 'schema_migrations'
             order by 1`
        ).map((r: { table_name: string }) => r.table_name);
      const functions = async () =>
        (
          await scratch.sql`
            select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'`
        ).length;

      const expected = [
        'inbox_messages',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ];
      expect(await tables()).toEqual(expected);
      await scratch.migrate('down');
      expect(await tables()).toEqual([]);
      expect(await functions()).toBe(0);
      await scratch.migrate('up');
      expect(await tables()).toEqual(expected);
    } finally {
      await scratch.drop();
    }
  });
});

describe('wallets', () => {
  test('uma wallet por playerId + currency', async () => {
    await insertWalletRow(db.sql, { playerId: 'dup-player' });
    await violates(
      insertWalletRow(db.sql, { playerId: 'dup-player' }),
      /wallets_player_currency_unique/,
    );
    // mesma pessoa, outra moeda: permitido
    await insertWalletRow(db.sql, { playerId: 'dup-player', currency: 'USD' });
  });

  test('saldo negativo é recusado pelo banco', async () => {
    const walletId = await seedWallet(db.sql, '10.00');
    await violates(
      db.sql`update wallets set balance = balance - 10.01 where id = ${walletId}`,
      /wallets_balance_non_negative/,
    );
  });

  test('versão começa em 1 e moeda é ISO-4217', async () => {
    await violates(insertWalletRow(db.sql, { version: 0 }), /wallets_version_positive/);
    await violates(insertWalletRow(db.sql, { currency: 'brl' }), /wallets_currency_format/);
  });

  test('NUMERIC preserva valores acima de 2^53 e volta como string', async () => {
    const walletId = await seedWallet(db.sql, '90071992547409.93');
    const [row] = await db.sql`select balance from wallets where id = ${walletId}`;
    expect(row.balance).toBe('90071992547409.93');
  });
});

describe('saldo materializado × ledger (conferido no commit)', () => {
  test('alterar o saldo sem lançamento falha', async () => {
    const walletId = await seedWallet(db.sql, '100.00');
    await violates(
      db.sql`update wallets set balance = 150.00, version = version + 1 where id = ${walletId}`,
      /diverges from ledger/,
    );
    const [row] = await db.sql`select balance from wallets where id = ${walletId}`;
    expect(row.balance).toBe('100.00');
  });

  test('lançamento sem atualizar o saldo falha', async () => {
    const walletId = await seedWallet(db.sql, '100.00');
    const attempt = db.sql.begin(async (tx) => {
      const txId = await insertTransaction(tx, { walletId, kind: 'WIN' });
      await insertEntry(tx, {
        walletId,
        transactionId: txId,
        amount: '10.00',
        before: '100.00',
        after: '110.00',
        version: 2,
      });
    });
    await violates(attempt, /diverges from ledger/);
    const [{ count }] =
      await db.sql`select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(count).toBe(1);
  });

  test('wallet aberta com saldo e sem lançamento de abertura falha', async () => {
    await violates(insertWalletRow(db.sql, { balance: '50.00' }), /without ledger entries/);
  });

  test('wallet zerada na versão 1 não precisa de lançamento', async () => {
    const walletId = await insertWalletRow(db.sql, { balance: '0.00' });
    await seedMovement(db.sql, walletId, 'CREDIT', '5.00');
    const [row] = await db.sql`select balance, version from wallets where id = ${walletId}`;
    expect(row).toMatchObject({ balance: '5.00', version: 2 });
  });
});

describe('wallet_ledger_entries', () => {
  test('é append-only: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const walletId = await seedWallet(db.sql, '100.00');
    await violates(
      db.sql`update wallet_ledger_entries set amount = 1 where wallet_id = ${walletId}`,
      /append-only/,
    );
    await violates(
      db.sql`delete from wallet_ledger_entries where wallet_id = ${walletId}`,
      /append-only/,
    );
    await violates(db.sql`truncate wallet_ledger_entries`, /append-only/);
  });

  const entryFor = async (overrides: Record<string, unknown>) => {
    const walletId = await seedWallet(db.sql, '100.00');
    return db.sql.begin(async (tx) => {
      const txId = await insertTransaction(tx, { walletId });
      await insertEntry(tx, {
        walletId,
        transactionId: txId,
        direction: 'DEBIT',
        amount: '10.00',
        before: '100.00',
        after: '90.00',
        version: 2,
        ...overrides,
      });
    });
  };

  test('aritmética do lançamento é conferida', async () => {
    await violates(entryFor({ after: '91.00' }), /ledger_arithmetic/);
    await violates(entryFor({ direction: 'CREDIT' }), /ledger_arithmetic/);
  });

  test('valor deve ser positivo e saldos não negativos', async () => {
    await violates(entryFor({ amount: '0.00', after: '100.00' }), /ledger_amount_positive/);
    await violates(entryFor({ amount: '150.00', after: '-50.00' }), /ledger_balances_non_negative/);
  });

  test('lançamento precisa continuar a cadeia (versão e saldo anterior)', async () => {
    await violates(entryFor({ before: '90.00', after: '80.00' }), /does not continue the chain/);
    await violates(entryFor({ version: 3 }), /does not continue the chain/);
    await violates(entryFor({ version: 1 }), /does not continue the chain/);
  });

  test('moeda do lançamento deve ser a da wallet', async () => {
    await violates(entryFor({ currency: 'USD' }), /differs from wallet currency/);
  });

  test('no máximo um lançamento por transação por wallet', async () => {
    const walletId = await seedWallet(db.sql, '100.00');
    const txId = await seedMovement(db.sql, walletId, 'DEBIT', '10.00');
    await violates(
      insertEntry(db.sql, {
        walletId,
        transactionId: txId,
        direction: 'DEBIT',
        amount: '10.00',
        before: '90.00',
        after: '80.00',
        version: 3,
      }),
      /ledger_one_entry_per_transaction/,
    );
  });

  test('lançamento exige wallet e transação existentes', async () => {
    const walletId = await seedWallet(db.sql, '100.00');
    await violates(
      insertEntry(db.sql, {
        walletId,
        transactionId: uuid(),
        amount: '1.00',
        before: '100.00',
        after: '101.00',
        version: 2,
      }),
      /foreign key/,
    );
  });
});

describe('wager_transactions', () => {
  test('idempotency key é única', async () => {
    const walletId = await seedWallet(db.sql);
    await insertTransaction(db.sql, { walletId, idempotencyKey: 'key-1', externalId: 'a' });
    await violates(
      insertTransaction(db.sql, { walletId, idempotencyKey: 'key-1', externalId: 'b' }),
      /wager_tx_idempotency_key_unique/,
    );
  });

  test('(providerId, externalTransactionId) é único, mesmo com outra key', async () => {
    const walletId = await seedWallet(db.sql);
    await insertTransaction(db.sql, { walletId, externalId: 'same', idempotencyKey: 'k-a' });
    await violates(
      insertTransaction(db.sql, { walletId, externalId: 'same', idempotencyKey: 'k-b' }),
      /wager_tx_provider_external_unique/,
    );
    // outro provedor pode reutilizar o id externo
    await insertTransaction(db.sql, { walletId, externalId: 'same', providerId: 'provider-b' });
  });

  test('50 inserts paralelos da mesma key: exatamente um vence', async () => {
    const walletId = await seedWallet(db.sql);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        insertTransaction(db.sql, { walletId, idempotencyKey: 'race-key', externalId: 'race' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('regras de referência e de valor por tipo', async () => {
    const walletId = await seedWallet(db.sql);
    await violates(insertTransaction(db.sql, { walletId, kind: 'REFUND' }), /wager_tx_reference_required/);
    await violates(insertTransaction(db.sql, { walletId, kind: 'ROLLBACK' }), /wager_tx_reference_required/);
    await violates(
      insertTransaction(db.sql, { walletId, kind: 'BET', referenceExternalId: 'x' }),
      /wager_tx_reference_forbidden/,
    );
    await violates(insertTransaction(db.sql, { walletId, amount: '0.00' }), /wager_tx_amount_valid/);
    await violates(insertTransaction(db.sql, { walletId, amount: '-1.00' }), /wager_tx_amount_valid/);
    await insertTransaction(db.sql, { walletId, kind: 'LOSS', amount: '0.00' });
  });

  test('tipo e status fora da lista são recusados', async () => {
    const walletId = await seedWallet(db.sql);
    await violates(insertTransaction(db.sql, { walletId, kind: 'BONUS' }), /wager_tx_kind_valid/);
    await violates(insertTransaction(db.sql, { walletId, status: 'DONE' }), /wager_tx_status_valid/);
  });

  test('coerência entre status e colunas de resultado', async () => {
    const walletId = await seedWallet(db.sql);
    await violates(
      insertTransaction(db.sql, { walletId, status: 'REJECTED' }),
      /wager_tx_failure_code_iff_failed/,
    );
    await violates(
      insertTransaction(db.sql, { walletId, failureCode: 'INSUFFICIENT_FUNDS' }),
      /wager_tx_failure_code_iff_failed/,
    );
    await violates(
      insertTransaction(db.sql, { walletId, processedAt: null }),
      /wager_tx_processed_at_iff_terminal/,
    );
    await violates(
      insertTransaction(db.sql, { walletId, resultingBalance: null }),
      /wager_tx_processed_has_balance/,
    );
    await violates(
      insertTransaction(db.sql, {
        walletId,
        kind: 'REFUND',
        referenceExternalId: 'x',
        status: 'PENDING_REFERENCE',
      }),
      /wager_tx_next_attempt_iff_pending_reference/,
    );
  });

  test('estado terminal não muda e transação não é apagada', async () => {
    const walletId = await seedWallet(db.sql);
    for (const [status, failureCode] of [
      ['PROCESSED', null],
      ['REJECTED', 'INSUFFICIENT_FUNDS'],
      ['FAILED', 'INTERNAL_ERROR'],
    ] as const) {
      const id = await insertTransaction(db.sql, { walletId, status, failureCode });
      await violates(
        db.sql`update wager_transactions set amount = 999 where id = ${id}`,
        /terminal state/,
      );
      await violates(db.sql`delete from wager_transactions where id = ${id}`, /cannot be deleted/);
    }
  });

  test('PENDING_REFERENCE pode evoluir para um estado terminal', async () => {
    const walletId = await seedWallet(db.sql);
    const id = await insertTransaction(db.sql, {
      walletId,
      kind: 'REFUND',
      referenceExternalId: 'later',
      status: 'PENDING_REFERENCE',
      nextAttemptAt: '2026-07-29T15:00:02Z',
    });
    await db.sql`
      update wager_transactions
         set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
             next_attempt_at = null, processed_at = now()
       where id = ${id}`;
    const [row] = await db.sql`select status from wager_transactions where id = ${id}`;
    expect(row.status).toBe('REJECTED');
  });

  test('uma referência só pode ter uma reversão PROCESSED (REFUND ou ROLLBACK)', async () => {
    const walletId = await seedWallet(db.sql);
    const betId = await insertTransaction(db.sql, { walletId, externalId: 'bet-rev' });
    const reversal = (kind: string, status = 'PROCESSED', failureCode: string | null = null) =>
      insertTransaction(db.sql, {
        walletId,
        kind,
        status,
        failureCode,
        referenceExternalId: 'bet-rev',
        referenceTransactionId: betId,
      });
    await reversal('REFUND');
    await violates(reversal('REFUND'), /wager_tx_single_reversal/);
    await violates(reversal('ROLLBACK'), /wager_tx_single_reversal/);
    // tentativas rejeitadas continuam auditáveis e não ocupam a vaga
    await reversal('ROLLBACK', 'REJECTED', 'REFERENCE_ALREADY_REVERSED');
    // WIN apontando para a mesma BET não é reversão
    await insertTransaction(db.sql, {
      walletId,
      kind: 'WIN',
      referenceExternalId: 'bet-rev',
      referenceTransactionId: betId,
    });
  });
});

describe('inbox e outbox', () => {
  test('inbox deduplica por (consumerName, messageId)', async () => {
    const insert = (consumer: string) =>
      db.sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
             values (${consumer}, 'msg-1', 'h', now())`;
    await insert('wager-transactions');
    await violates(insert('wager-transactions'), /inbox_messages_pk/);
    await insert('another-consumer');
  });

  test('outbox nasce pendente e o id do evento é único', async () => {
    const id = uuid();
    const insert = () =>
      db.sql`insert into outbox_messages (id, aggregate_id, partition_key, event_type, payload, occurred_at)
             values (${id}, 'agg', 'wallet', 'WalletBalanceChanged', ${{ a: 1 }}, now())`;
    await insert();
    await violates(insert(), /outbox_messages_pkey/);
    const [row] = await db.sql`select attempts, published_at, payload from outbox_messages where id = ${id}`;
    expect(row).toMatchObject({ attempts: 0, published_at: null, payload: { a: 1 } });
  });
});
