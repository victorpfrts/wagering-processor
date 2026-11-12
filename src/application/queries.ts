import { ValidationError } from '../domain/errors.ts';
import { Money, type MoneyProps } from '../domain/money.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { NotFoundError } from './errors.ts';
import type { AppLogger, WageringMetrics, WageringReadModel } from './ports.ts';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Cursor opaco: base64url de {"v": walletVersion}. O ledger é append-only e
 * a versão é única e crescente por wallet, então a paginação por "versão
 * menor que X" nunca repete nem pula item, mesmo com lançamentos novos
 * chegando durante a navegação.
 */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const version = (parsed as { v?: unknown }).v;
    if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 1) {
      return version;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError('Invalid cursor');
}

/** Aceita sinal: a soma do ledger só é negativa se houver corrupção — e é aí que precisamos enxergá-la. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class WageringQueries {
  constructor(
    private readonly readModel: WageringReadModel,
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.readModel.findWallet(walletId);
    if (wallet === undefined) throw new NotFoundError('Wallet not found');
    return wallet;
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number = LEDGER_DEFAULT_LIMIT,
  ): Promise<LedgerPageResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new ValidationError(`limit must be between 1 and ${LEDGER_MAX_LIMIT}`);
    }
    const beforeVersion = cursor === undefined ? undefined : decodeLedgerCursor(cursor);
    await this.getWallet(walletId);
    const page = await this.readModel.ledgerPage(walletId, beforeVersion, limit);
    return {
      entries: page.entries,
      nextCursor: page.nextVersion === undefined ? undefined : encodeLedgerCursor(page.nextVersion),
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.readModel.findTransaction(transactionId);
    if (transaction === undefined) throw new NotFoundError('Transaction not found');
    return transaction;
  }

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.readModel.findTransactionByExternalId(
      providerId,
      externalTransactionId,
    );
    if (transaction === undefined) throw new NotFoundError('Transaction not found');
    return transaction;
  }

  /**
   * Compara o saldo materializado com o reconstruído pelo ledger. Divergência
   * NÃO é corrigida: é logada, contada em métrica e sinalizada na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.readModel.reconciliationSnapshot(walletId);
    if (snapshot === undefined) throw new NotFoundError('Wallet not found');

    const stored = signedMoney(snapshot.storedBalance, snapshot.currency);
    const calculated = signedMoney(snapshot.ledgerBalance, snapshot.currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet balance diverges from ledger', {
        walletId,
        checkedEntries: snapshot.checkedEntries,
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
