import { InsufficientFundsError } from './errors.ts';
import { FailureCode } from './failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.ts';
import type { Wallet } from './wallet.ts';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry.ts';

export interface ApplyWagerTransactionInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Transação referenciada, já resolvida por (providerId, referenceExternalTransactionId). */
  reference: WagerTransaction | undefined;
  /** Já existe uma reversão PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
}

export interface ApplyWagerTransactionResult {
  ledgerEntry: WalletLedgerEntry | undefined;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Regras de negócio de BET, WIN, LOSS, REFUND e ROLLBACK, sem I/O.
 *
 * Recebe a wallet já travada pela camada de aplicação e deixa a transação em
 * PROCESSED, REJECTED ou PENDING_REFERENCE. Só devolve lançamento quando o
 * saldo mudou; rejeição nunca toca na wallet.
 */
export function applyWagerTransaction(
  input: ApplyWagerTransactionInput,
): ApplyWagerTransactionResult {
  const { wallet, transaction, reference, now } = input;
  const reject = (code: FailureCode): ApplyWagerTransactionResult => {
    transaction.reject(code, wallet.balance, now);
    return { ledgerEntry: undefined };
  };

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletNotFound);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (transaction.referenceExternalTransactionId !== undefined) {
    const blocked = checkReference(input);
    if (blocked === 'wait') {
      if (transaction.hasExhaustedReferenceAttempts()) {
        return reject(
          reference === undefined
            ? FailureCode.ReferenceNotFound
            : FailureCode.ReferenceNotProcessed,
        );
      }
      transaction.markPendingReference(now);
      return { ledgerEntry: undefined };
    }
    if (blocked !== undefined) {
      return reject(blocked);
    }
  }

  const direction = transaction.ledgerDirectionFor(reference);
  let ledgerEntry: WalletLedgerEntry | undefined;
  if (direction !== undefined) {
    const movement = {
      transactionId: transaction.id,
      entryId: input.ledgerEntryId,
      money: transaction.money,
      now,
    };
    if (direction === LedgerDirection.Credit) {
      ledgerEntry = wallet.credit(movement);
    } else {
      try {
        ledgerEntry = wallet.debit(movement);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        // Aposta sem saldo e reversão que estouraria o saldo são situações
        // operacionalmente diferentes: códigos distintos.
        return reject(
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalWouldOverdraw,
        );
      }
    }
  }

  transaction.markProcessed(reference?.id, wallet.balance, now);
  return { ledgerEntry };
}

/** undefined = referência válida; 'wait' = ainda não dá para decidir. */
function checkReference(input: ApplyWagerTransactionInput): FailureCode | 'wait' | undefined {
  const { transaction, reference } = input;
  if (reference === undefined) {
    return 'wait';
  }
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.roundId !== transaction.roundId ||
    reference.money.currency !== transaction.money.currency
  ) {
    return FailureCode.ReferenceMismatch;
  }
  const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
  if (!allowedKinds.includes(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  if (!reference.isTerminal()) {
    return 'wait';
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (transaction.requiresReference()) {
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    if (input.referenceAlreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }
  return undefined;
}
