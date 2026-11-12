import type { IntegrationEvent } from '../domain/events/integration-event.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface WalletRepository {
  /** Carrega a wallet travando a linha (FOR UPDATE) até o fim da transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo, versão e updatedAt de uma wallet travada nesta transação. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persiste a transição de uma transação não terminal carregada nesta transação. */
  save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  enqueue(events: IntegrationEvent<unknown>[]): Promise<void>;
}

/** Repositórios ligados a UMA transação SQL. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Executa `work` dentro de uma única transação SQL: ou tudo é confirmado
 * junto, ou nada é. Traduz erros do banco para erros de aplicação
 * (DuplicateKeyError, TransientInfrastructureError).
 */
export interface UnitOfWork {
  run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
