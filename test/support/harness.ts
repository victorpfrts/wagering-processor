import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import type { IdGenerator } from '../../src/application/ports.ts';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/process-wager-transaction.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/db/mikro-orm-unit-of-work.ts';
import { buildOrmConfig } from '../../src/infrastructure/db/orm-config.ts';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system.ts';
import { createTestDatabase, seedWallet, type TestDatabase, uuid } from './test-database.ts';

export interface Harness {
  db: TestDatabase;
  orm: MikroORM;
  process: ProcessWagerTransaction;
  /** Outro use case sobre o mesmo banco, com dependências trocadas. */
  processWith(options: { ids?: IdGenerator; lockTimeoutMs?: number }): ProcessWagerTransaction;
  close(): Promise<void>;
}

/** PostgreSQL real + MikroORM real + use case real. Nada é mockado. */
export async function createHarness(): Promise<Harness> {
  const db = await createTestDatabase();
  const orm = await MikroORM.init({
    ...buildOrmConfig(db.url, { poolMax: 20 }),
    debug: false,
    logger: () => {},
  });
  const processWith: Harness['processWith'] = (options) =>
    new ProcessWagerTransaction(
      new MikroOrmUnitOfWork(orm, { lockTimeoutMs: options.lockTimeoutMs ?? 5000 }),
      new SystemClock(),
      options.ids ?? new UuidV7Generator(),
    );
  return {
    db,
    orm,
    process: processWith({}),
    processWith,
    async close() {
      await orm.close(true);
      await db.drop();
    },
  };
}

export const playerOf = (walletId: string): string => `player-${walletId}`;

/** Wallet nova e consistente, com o saldo pedido. */
export const newWallet = (harness: Harness, balance = '100.00'): Promise<string> =>
  seedWallet(harness.db.sql, balance);

export function command(
  walletId: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${uuid()}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: playerOf(walletId),
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    correlationId: 'test-correlation',
    ...overrides,
  };
}

export const brlProps = (amount: string) => ({ amount, currency: 'BRL' });

export interface WalletSnapshot {
  balance: string;
  version: number;
  ledgerBalance: string;
  entries: number;
  debits: number;
  credits: number;
}

export async function snapshot(harness: Harness, walletId: string): Promise<WalletSnapshot> {
  const [row] = await harness.db.sql`
    select w.balance::text as balance,
           w.version,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19,2)::text
             as ledger_balance,
           count(e.id)::int as entries,
           count(e.id) filter (where e.direction = 'DEBIT')::int as debits,
           count(e.id) filter (where e.direction = 'CREDIT')::int as credits
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id = ${walletId}
     group by w.id`;
  return {
    balance: row.balance,
    version: row.version,
    ledgerBalance: row.ledger_balance,
    entries: row.entries,
    debits: row.debits,
    credits: row.credits,
  };
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerConsistent(
  harness: Harness,
  walletId: string,
): Promise<WalletSnapshot> {
  const state = await snapshot(harness, walletId);
  expect(state.ledgerBalance).toBe(state.balance);
  return state;
}

export async function transactionRows(
  harness: Harness,
  walletId: string,
): Promise<TransactionRow[]> {
  const rows = (await harness.db.sql`
    select id, kind, status, failure_code, amount::text as amount,
           resulting_balance::text as resulting_balance, idempotency_key
      from wager_transactions
     where wallet_id = ${walletId} and kind <> 'OPENING'
     order by created_at, id`) as TransactionRow[];
  // cópia em objeto simples: as linhas do driver não são objetos comuns
  return rows.map((row) => ({ ...row }));
}

export interface TransactionRow {
  id: string;
  kind: string;
  status: string;
  failure_code: string | null;
  amount: string;
  resulting_balance: string | null;
  idempotency_key: string;
}

export async function outboxEvents(harness: Harness, walletId: string): Promise<string[]> {
  const rows = await harness.db.sql`
    select event_type from outbox_messages
     where partition_key = ${walletId} order by seq`;
  return rows.map((row: { event_type: string }) => row.event_type);
}
