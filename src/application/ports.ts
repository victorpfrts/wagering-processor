import type { IntegrationEvent } from '../domain/events/integration-event.ts';
import type { InboxMessage } from '../domain/inbox-message.ts';
import type { OutboxMessage } from '../domain/outbox-message.ts';
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
  /**
   * Trava (FOR UPDATE SKIP LOCKED) e devolve, em ordem de criação, mensagens
   * pendentes que nenhum outro publisher está tratando. Só entram partições
   * cujo evento mais antigo está vencido e foi travado por esta transação:
   * um evento nunca é entregue antes de outro mais antigo da mesma partição.
   */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Grava attempts, nextAttemptAt e publishedAt de mensagens travadas nesta transação. */
  saveAll(messages: OutboxMessage[]): Promise<void>;
}

/** Destino dos eventos de integração (SQS). */
export interface EventPublisher {
  /**
   * Publica as mensagens e devolve os ids das que falharam. Lançar equivale a
   * falhar todas. Pode entregar a mesma mensagem mais de uma vez.
   */
  publish(messages: OutboxMessage[]): Promise<Set<string>>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
}

/** Repositórios ligados a UMA transação SQL. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Executa `work` dentro de uma única transação SQL: ou tudo é confirmado
 * junto, ou nada é. Traduz erros do banco para erros de aplicação
 * (DuplicateKeyError, TransientInfrastructureError).
 */
export interface UnitOfWork {
  run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** walletVersion do último item quando há mais páginas. */
  nextVersion: number | undefined;
}

export interface ReconciliationSnapshot {
  currency: string;
  /** Saldo materializado, decimal string. */
  storedBalance: string;
  /** Soma dos lançamentos (créditos − débitos), decimal string; pode ser negativa se houver corrupção. */
  ledgerBalance: string;
  checkedEntries: number;
}

/** Leituras fora de transação de escrita. Nunca alteram estado. */
export interface WageringReadModel {
  findWallet(id: string): Promise<Wallet | undefined>;
  /** Do lançamento mais recente para o mais antigo, a partir de `beforeVersion` (exclusivo). */
  ledgerPage(walletId: string, beforeVersion: number | undefined, limit: number): Promise<LedgerPage>;
  findTransaction(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Saldo e soma do ledger lidos no MESMO snapshot do banco. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export type LogFields = Record<string, unknown>;

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Contadores de negócio. A implementação (Prometheus) fica na infraestrutura. */
export interface WageringMetrics {
  reconciliationDivergence(): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  /** Desfecho de uma mensagem consumida da fila. */
  messageHandled(outcome: MessageOutcome): void;
}

export type MessageOutcome = 'acked' | 'retried' | 'dead_lettered';

export const READ_MODEL = Symbol('WageringReadModel');
export const APP_LOGGER = Symbol('AppLogger');
export const METRICS = Symbol('WageringMetrics');
export const EVENT_PUBLISHER = Symbol('EventPublisher');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
