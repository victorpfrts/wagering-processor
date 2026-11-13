import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { buildOrmConfig } from '../../src/infrastructure/db/orm-config.ts';

const ADMIN_URL =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://wagering:wagering@localhost:5433/postgres';

export interface TestDatabase {
  url: string;
  sql: SQL;
  migrate(direction: 'up' | 'down'): Promise<void>;
  drop(): Promise<void>;
}

/**
 * Cria um banco PostgreSQL real e exclusivo para o arquivo de teste, já
 * migrado. Isolamento por banco: os testes não dependem de limpeza de tabelas
 * (o ledger nem permite TRUNCATE).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database ${name}`);

  const target = new URL(ADMIN_URL);
  target.pathname = `/${name}`;
  const url = target.toString();

  const migrate = async (direction: 'up' | 'down'): Promise<void> => {
    const orm = await MikroORM.init({ ...buildOrmConfig(url), debug: false, logger: () => {} });
    try {
      await (direction === 'up' ? orm.migrator.up() : orm.migrator.down());
    } finally {
      await orm.close(true);
    }
  };
  await migrate('up');

  const sql = new SQL(url, { max: 10 });
  return {
    url,
    sql,
    migrate,
    async drop() {
      await sql.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    },
  };
}

type Queryable = SQL;

export const uuid = (): string => Bun.randomUUIDv7();
const NOW = '2026-07-29T15:00:00Z';

export interface TxRow {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  walletId: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  resultingBalance?: string | null;
  processedAt?: string | null;
  nextAttemptAt?: string | null;
}

/** INSERT cru em wager_transactions; por padrão uma BET PROCESSED válida. */
export async function insertTransaction(sql: Queryable, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const externalId = row.externalId ?? `ext-${id}`;
  const providerId = row.providerId ?? 'provider-a';
  const status = row.status ?? 'PROCESSED';
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
  const resultingBalance =
    row.resultingBalance !== undefined ? row.resultingBalance : status === 'PROCESSED' ? '0.00' : null;
  await sql`
    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
      player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, reference_transaction_id, status, failure_code,
      resulting_balance, resulting_balance_currency, next_attempt_at, created_at, processed_at
    ) values (
      ${id}, ${providerId}, ${externalId}, ${row.idempotencyKey ?? `${providerId}:${externalId}`},
      'hash', ${row.walletId}, 'player', 'round-1', 'game', ${row.kind ?? 'BET'},
      ${row.amount ?? '10.00'}, 'BRL',
      ${row.referenceExternalId ?? null}, ${row.referenceTransactionId ?? null}, ${status},
      ${row.failureCode ?? null}, ${resultingBalance}, ${resultingBalance === null ? null : 'BRL'},
      ${row.nextAttemptAt ?? null}, ${NOW},
      ${row.processedAt !== undefined ? row.processedAt : terminal ? NOW : null}
    )`;
  return id;
}

export interface EntryRow {
  walletId: string;
  transactionId: string;
  direction?: string;
  amount: string;
  before: string;
  after: string;
  version: number;
  currency?: string;
}

export async function insertEntry(sql: Queryable, row: EntryRow): Promise<string> {
  const id = uuid();
  await sql`
    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency,
      balance_before, balance_after, wallet_version, created_at
    ) values (
      ${id}, ${row.walletId}, ${row.transactionId}, ${row.direction ?? 'CREDIT'}, ${row.amount},
      ${row.currency ?? 'BRL'}, ${row.before}, ${row.after}, ${row.version}, ${NOW}
    )`;
  return id;
}

export async function insertWalletRow(
  sql: Queryable,
  row: { id?: string; playerId?: string; currency?: string; balance?: string; version?: number },
): Promise<string> {
  const id = row.id ?? uuid();
  await sql`
    insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
    values (${id}, ${row.playerId ?? `player-${id}`}, ${row.currency ?? 'BRL'},
            ${row.balance ?? '0.00'}, ${row.version ?? 1}, ${NOW}, ${NOW})`;
  return id;
}

/** Wallet consistente: saldo inicial + transação OPENING + lançamento, na mesma transação. */
export async function seedWallet(sql: SQL, balance = '100.00'): Promise<string> {
  const walletId = uuid();
  await sql.begin(async (tx) => {
    await insertWalletRow(tx, { id: walletId, balance });
    if (!/^0+(\.0+)?$/.test(balance)) {
      const txId = await insertTransaction(tx, {
        walletId,
        kind: 'OPENING',
        amount: balance,
        resultingBalance: balance,
      });
      await insertEntry(tx, {
        walletId,
        transactionId: txId,
        amount: balance,
        before: '0.00',
        after: balance,
        version: 1,
      });
    }
  });
  return walletId;
}

/** Movimenta a wallet de forma consistente (saldo + lançamento). */
export async function seedMovement(
  sql: SQL,
  walletId: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
  tx: Partial<TxRow> = {},
): Promise<string> {
  let transactionId = '';
  await sql.begin(async (trx) => {
    const [wallet] = await trx`select balance, version from wallets where id = ${walletId} for update`;
    const [{ after }] = await trx`
      select (${wallet.balance}::numeric ${direction === 'CREDIT' ? trx`+` : trx`-`} ${amount}::numeric)::text as after`;
    transactionId = await insertTransaction(trx, {
      walletId,
      amount,
      kind: direction === 'DEBIT' ? 'BET' : 'WIN',
      resultingBalance: after,
      ...tx,
    });
    await insertEntry(trx, {
      walletId,
      transactionId,
      direction,
      amount,
      before: wallet.balance,
      after,
      version: wallet.version + 1,
    });
    await trx`update wallets set balance = ${after}, version = version + 1 where id = ${walletId}`;
  });
  return transactionId;
}
