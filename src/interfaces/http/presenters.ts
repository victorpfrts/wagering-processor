import type { LedgerPageResult } from '../../application/queries.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import type { Wallet } from '../../domain/wallet.ts';

/** Domínio → JSON da API. Dinheiro sempre como { amount: string, currency }. */

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentTransaction(transaction: WagerTransaction) {
  const optional = <T>(key: string, value: T | undefined) =>
    value === undefined ? {} : { [key]: value };
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
    status: transaction.status,
    ...optional('failureCode', transaction.failureCode),
    ...optional('balance', transaction.resultingBalance?.toJSON()),
    ...optional('referenceExternalTransactionId', transaction.referenceExternalTransactionId),
    ...optional('referenceTransactionId', transaction.referenceTransactionId),
    createdAt: transaction.createdAt.toISOString(),
    ...optional('processedAt', transaction.processedAt?.toISOString()),
  };
}

export function presentLedgerPage(page: LedgerPageResult) {
  return {
    items: page.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor ?? null,
  };
}
