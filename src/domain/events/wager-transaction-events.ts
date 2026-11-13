import { ValidationError } from '../errors.ts';
import type { FailureCode } from '../failure-code.ts';
import type { MoneyProps } from '../money.ts';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction.ts';
import { type EventContext, IntegrationEvent } from './integration-event.ts';

interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function summarize(transaction: WagerTransaction): TransactionSummary {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function envelope(transaction: WagerTransaction, ctx: EventContext) {
  return {
    eventId: ctx.eventId,
    aggregateId: transaction.id,
    partitionKey: transaction.walletId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

export interface WagerTransactionProcessedData extends TransactionSummary {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const { resultingBalance, processedAt, referenceTransactionId } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      resultingBalance === undefined ||
      processedAt === undefined
    ) {
      throw new ValidationError('Transaction is not processed');
    }
    return new WagerTransactionProcessed({
      ...envelope(transaction, ctx),
      data: {
        ...summarize(transaction),
        ...(referenceTransactionId !== undefined ? { referenceTransactionId } : {}),
        balance: resultingBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: FailureCode;
  balance?: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const { failureCode, processedAt, resultingBalance } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined ||
      processedAt === undefined
    ) {
      throw new ValidationError('Transaction is not rejected');
    }
    return new WagerTransactionRejected({
      ...envelope(transaction, ctx),
      data: {
        ...summarize(transaction),
        failureCode,
        ...(resultingBalance !== undefined ? { balance: resultingBalance.toJSON() } : {}),
        rejectedAt: processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Publicado uma vez, quando a transação entra em PENDING_REFERENCE. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextAttemptAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextAttemptAt === undefined
    ) {
      throw new ValidationError('Transaction is not waiting for a reference');
    }
    return new WagerTransactionPendingReference({
      ...envelope(transaction, ctx),
      data: {
        ...summarize(transaction),
        referenceExternalTransactionId,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionFailedData extends TransactionSummary {
  failureCode: FailureCode;
  failedAt: string;
}

/** Falha permanente de infraestrutura: a operação não foi aplicada e não será. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    const { failureCode, processedAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Failed ||
      failureCode === undefined ||
      processedAt === undefined
    ) {
      throw new ValidationError('Transaction is not failed');
    }
    return new WagerTransactionFailed({
      ...envelope(transaction, ctx),
      data: {
        ...summarize(transaction),
        failureCode,
        failedAt: processedAt.toISOString(),
      },
    });
  }
}
