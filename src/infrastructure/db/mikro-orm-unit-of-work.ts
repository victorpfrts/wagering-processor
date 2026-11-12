import { LockMode } from '@mikro-orm/core';
import type { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerRepository,
  OutboxRepository,
  TransactionContext,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports.ts';
import { OutboxMessage } from '../../domain/outbox-message.ts';
import { translateDatabaseError } from './errors.ts';
import {
  ledgerEntryToRecord,
  outboxToRecord,
  transactionMutableFields,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers.ts';
import {
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './records.ts';

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
}

/**
 * Uma chamada a run() = um EntityManager novo (Identity Map limpo) = uma
 * transação SQL via em.transactional(). Os repositórios compartilham esse
 * EntityManager, então tudo que gravam é confirmado ou desfeito junto.
 *
 * Cada escrita faz flush imediato: a ordem dos comandos SQL é a ordem em que
 * o use case chamou (a transação antes do lançamento que a referencia) e um
 * erro de constraint aparece no ponto que o causou.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tx) => {
        // SET LOCAL: vale só para esta transação. Esperar demais por um lock
        // vira falha transitória em vez de requisição pendurada.
        await tx.execute(`select set_config('lock_timeout', ?, true)`, [
          `${this.options.lockTimeoutMs}ms`,
        ]);
        return work(buildContext(tx));
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

function buildContext(em: SqlEntityManager): TransactionContext {
  return {
    wallets: walletRepository(em),
    transactions: transactionRepository(em),
    ledger: ledgerRepository(em),
    outbox: outboxRepository(em),
  };
}

function walletRepository(em: SqlEntityManager): WalletRepository {
  return {
    async lockById(id) {
      const record = await em.findOne(
        WalletSchema,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      return record === null ? undefined : walletToDomain(record);
    },
    async insert(wallet) {
      em.persist(em.create(WalletSchema, walletToRecord(wallet)));
      await em.flush();
    },
    async save(wallet) {
      // Vem do Identity Map: é a mesma linha que lockById travou.
      const record = await em.findOneOrFail(WalletSchema, { id: wallet.id });
      record.balance = wallet.balance.toJSON().amount;
      record.version = wallet.version;
      record.updatedAt = wallet.updatedAt;
      await em.flush();
    },
  };
}

function transactionRepository(em: SqlEntityManager): WagerTransactionRepository {
  const one = async (where: Record<string, unknown>) => {
    const record = await em.findOne(WagerTransactionSchema, where);
    return record === null ? undefined : transactionToDomain(record);
  };
  return {
    findById: (id) => one({ id }),
    findByIdempotencyKey: (idempotencyKey) => one({ idempotencyKey }),
    findByExternalId: (providerId, externalTransactionId) =>
      one({ providerId, externalTransactionId }),
    async hasProcessedReversal(referenceTransactionId) {
      const count = await em.count(WagerTransactionSchema, {
        referenceTransactionId,
        status: 'PROCESSED',
        kind: { $in: ['REFUND', 'ROLLBACK'] },
      });
      return count > 0;
    },
    async insert(transaction) {
      em.persist(em.create(WagerTransactionSchema, transactionToRecord(transaction)));
      await em.flush();
    },
    async save(transaction) {
      const record = await em.findOneOrFail(WagerTransactionSchema, { id: transaction.id });
      Object.assign(record, transactionMutableFields(transaction));
      await em.flush();
    },
  };
}

function ledgerRepository(em: SqlEntityManager): LedgerRepository {
  return {
    async append(entry) {
      em.persist(em.create(LedgerEntrySchema, ledgerEntryToRecord(entry)));
      await em.flush();
    },
  };
}

function outboxRepository(em: SqlEntityManager): OutboxRepository {
  return {
    async enqueue(events) {
      if (events.length === 0) return;
      for (const event of events) {
        em.persist(em.create(OutboxSchema, outboxToRecord(OutboxMessage.enqueue(event))));
      }
      await em.flush();
    },
  };
}
