import type { MikroORM } from '@mikro-orm/postgresql';
import type { WageringReadModel } from '../../application/ports.ts';
import { translateDatabaseError } from './errors.ts';
import { ledgerEntryToDomain, transactionToDomain, walletToDomain } from './mappers.ts';
import { LedgerEntrySchema, WagerTransactionSchema, WalletSchema } from './records.ts';

/** Leituras simples, cada uma num EntityManager descartável (sem cache entre requisições). */
export class MikroOrmReadModel implements WageringReadModel {
  constructor(private readonly orm: MikroORM) {}

  findWallet: WageringReadModel['findWallet'] = (id) =>
    this.read(async (em) => {
      const record = await em.findOne(WalletSchema, { id });
      return record === null ? undefined : walletToDomain(record);
    });

  ledgerPage: WageringReadModel['ledgerPage'] = (walletId, beforeVersion, limit) =>
    this.read(async (em) => {
      // Busca um a mais para saber se existe próxima página.
      const records = await em.find(
        LedgerEntrySchema,
        {
          walletId,
          ...(beforeVersion !== undefined ? { walletVersion: { $lt: beforeVersion } } : {}),
        },
        { orderBy: { walletVersion: 'desc' }, limit: limit + 1 },
      );
      const page = records.slice(0, limit);
      return {
        entries: page.map(ledgerEntryToDomain),
        nextVersion: records.length > limit ? page.at(-1)?.walletVersion : undefined,
      };
    });

  findTransaction: WageringReadModel['findTransaction'] = (id) =>
    this.read(async (em) => {
      const record = await em.findOne(WagerTransactionSchema, { id });
      return record === null ? undefined : transactionToDomain(record);
    });

  findTransactionByExternalId: WageringReadModel['findTransactionByExternalId'] = (
    providerId,
    externalTransactionId,
  ) =>
    this.read(async (em) => {
      const record = await em.findOne(WagerTransactionSchema, {
        providerId,
        externalTransactionId,
      });
      return record === null ? undefined : transactionToDomain(record);
    });

  reconciliationSnapshot: WageringReadModel['reconciliationSnapshot'] = (walletId) =>
    this.read(async (em) => {
      // Um único comando = um único snapshot: saldo e soma são da mesma foto
      // do banco, mesmo com apostas sendo processadas ao mesmo tempo.
      // A soma é feita em NUMERIC pelo PostgreSQL (exata) e volta como texto.
      const rows = await em.execute<
        { currency: string; stored: string; ledger: string; entries: string }[]
      >(
        `select w.currency,
                w.balance::text as stored,
                coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
                  ::numeric(19,2)::text as ledger,
                count(e.id)::text as entries
           from wallets w
           left join wallet_ledger_entries e on e.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        currency: row.currency,
        storedBalance: row.stored,
        ledgerBalance: row.ledger,
        checkedEntries: Number.parseInt(row.entries, 10),
      };
    });

  private async read<T>(
    query: (em: ReturnType<MikroORM['em']['fork']>) => Promise<T>,
  ): Promise<T> {
    try {
      return await query(this.orm.em.fork());
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
