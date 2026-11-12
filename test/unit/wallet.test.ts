import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  ValidationError,
} from '../../src/domain/errors.ts';
import { Wallet } from '../../src/domain/wallet.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry.ts';
import { brl, NOW, openWallet, PLAYER_ID, usd, WALLET_ID } from './helpers.ts';

const LATER = new Date(NOW.getTime() + 1000);
const move = (amount: string, id = 'tx-1') => ({
  transactionId: id,
  entryId: `entry-${id}`,
  money: brl(amount),
  now: LATER,
});

describe('Wallet.open', () => {
  test('saldo inicial > 0 nasce na versão 1 com lançamento CREDIT de abertura', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-opening',
      openingEntryId: 'entry-opening',
      now: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('0.00'),
      openingTransactionId: 'tx-opening',
      openingEntryId: 'entry-opening',
      now: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
});

describe('Wallet débito e crédito', () => {
  test('débito reduz o saldo, incrementa a versão e devolve o lançamento correspondente', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(move('80.00'));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito aumenta o saldo e incrementa a versão', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(move('50.00'));
    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('pode debitar até zerar, mas nunca ficar negativo', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
    expect(() => wallet.debit(move('0.01', 'tx-2'))).toThrow(InsufficientFundsError);
  });

  test('débito recusado não altera saldo, versão nem updatedAt', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(NOW);
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit({ ...move('1.00'), money: usd('1.00') })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit({ ...move('1.00'), money: usd('1.00') })).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.version).toBe(1);
  });

  test('movimento de valor zero é rejeitado (versão só muda quando o saldo muda)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(move('0.00'))).toThrow(ValidationError);
    expect(wallet.version).toBe(1);
  });

  test('a soma dos lançamentos reconstrói o saldo', () => {
    const wallet = openWallet('0.00');
    const entries = [
      wallet.credit(move('100.00', 'a')),
      wallet.debit(move('30.00', 'b')),
      wallet.credit(move('12.34', 'c')),
      wallet.debit(move('0.01', 'd')),
    ];
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      brl('0.00'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([2, 3, 4, 5]);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('7.00'),
      version: 9,
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect(wallet.version).toBe(9);
    expect(wallet.balance.toJSON().amount).toBe('7.00');
  });
});

describe('WalletLedgerEntry.create', () => {
  const base = {
    id: 'e1',
    walletId: WALLET_ID,
    transactionId: 't1',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    walletVersion: 2,
    createdAt: NOW,
  };

  test('aceita aritmética correta', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test('rejeita aritmética incorreta', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero e saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('50.00') }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl('60.00'),
        balanceAfter: brl('50.00').subtract(brl('60.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável: não expõe método de transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);
    expect(methods.sort()).toEqual(['constructor', 'isBalanced']);
  });
});
