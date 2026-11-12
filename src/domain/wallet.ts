import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from './errors.ts';
import { Money } from './money.ts';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação interna OPENING e id do lançamento; usados só se o saldo inicial for > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface MovementProps {
  transactionId: string;
  entryId: string;
  money: Money;
  now: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já na versão 1. Saldo inicial > 0 devolve também o
   * lançamento CREDIT de abertura, para que saldo e ledger nasçam consistentes.
   */
  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError('Initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientFundsError se o débito deixaria o saldo negativo. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  /** Único ponto que altera saldo: sempre produz o lançamento correspondente. */
  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.now,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.now;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new ValidationError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
