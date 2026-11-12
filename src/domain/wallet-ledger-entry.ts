import { InvalidLedgerEntryError } from './errors.ts';
import type { Money } from './money.ts';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Lançamento imutável: sem campos mutáveis e sem métodos de transição. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    /** Versão da wallet depois deste lançamento; numera a cadeia do ledger. */
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry balances cannot be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balanceBefore ± money must equal balanceAfter');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
