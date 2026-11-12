import type { FailureCode } from '../../domain/failure-code.ts';
import { Money } from '../../domain/money.ts';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.ts';
import { Wallet } from '../../domain/wallet.ts';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type {
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records.ts';

/**
 * Money ↔ banco: NUMERIC(19,2) + CHAR(3). O driver entrega NUMERIC como
 * string e é assim que ele entra em Money.from — nenhum number no caminho.
 */
const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const amountOf = (value: Money): string => value.toJSON().amount;
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

// ------------------------------------------------------------------ wallet

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: amountOf(wallet.balance),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

// ------------------------------------------------------------- transaction

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(record.processedAt),
    resultingBalance:
      record.resultingBalance === null || record.resultingBalanceCurrency === null
        ? undefined
        : money(record.resultingBalance, record.resultingBalanceCurrency),
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: orUndefined(record.nextAttemptAt),
  });
}

/** Campos que mudam ao longo da vida da transação (as transições). */
export function transactionMutableFields(transaction: WagerTransaction) {
  const balance = transaction.resultingBalance;
  return {
    status: transaction.status as string,
    referenceTransactionId: orNull(transaction.referenceTransactionId),
    failureCode: orNull<string>(transaction.failureCode),
    resultingBalance: balance === undefined ? null : amountOf(balance),
    resultingBalanceCurrency: balance === undefined ? null : balance.currency,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: orNull(transaction.nextAttemptAt),
    processedAt: orNull(transaction.processedAt),
  } satisfies Partial<WagerTransactionRecord>;
}

export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: amountOf(transaction.money),
    currency: transaction.money.currency,
    referenceExternalTransactionId: orNull(transaction.referenceExternalTransactionId),
    createdAt: transaction.createdAt,
    ...transactionMutableFields(transaction),
  };
}

// ------------------------------------------------------------------ ledger

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: amountOf(entry.money),
    currency: entry.money.currency,
    balanceBefore: amountOf(entry.balanceBefore),
    balanceAfter: amountOf(entry.balanceAfter),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

// ------------------------------------------------------------------ outbox

export function outboxToRecord(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    partitionKey: message.partitionKey,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: orNull(message.nextAttemptAt),
    publishedAt: orNull(message.publishedAt),
  };
}
