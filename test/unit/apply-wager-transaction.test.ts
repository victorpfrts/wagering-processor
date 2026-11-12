import { describe, expect, test } from 'bun:test';
import { applyWagerTransaction } from '../../src/domain/apply-wager-transaction.ts';
import { REFERENCE_RETRY_POLICY } from '../../src/domain/backoff.ts';
import { FailureCode } from '../../src/domain/failure-code.ts';
import {
  type CreateWagerTransactionProps,
  type WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.ts';
import type { Wallet } from '../../src/domain/wallet.ts';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.ts';
import { brl, makeTransaction, NOW, openWallet, usd } from './helpers.ts';

let entrySeq = 0;
function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
) {
  entrySeq += 1;
  return applyWagerTransaction({
    wallet,
    transaction,
    reference,
    referenceAlreadyReversed,
    ledgerEntryId: `entry-${entrySeq}`,
    now: NOW,
  });
}

/** Cria e aplica uma transação, devolvendo-a já resolvida. */
function processed(wallet: Wallet, props: Partial<CreateWagerTransactionProps> = {}, reference?: WagerTransaction) {
  const tx = makeTransaction(props);
  apply(wallet, tx, reference);
  expect(tx.status).toBe(Status.Processed);
  return tx;
}

const reversal = (kind: Kind, reference: WagerTransaction, amount = '25.00', extra = {}) =>
  makeTransaction({
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference.externalTransactionId,
    ...extra,
  });

function expectRejected(wallet: Wallet, tx: WagerTransaction, code: FailureCode, balance: string) {
  expect(tx.status).toBe(Status.Rejected);
  expect(tx.failureCode).toBe(code);
  expect(wallet.balance.toJSON().amount).toBe(balance);
  expect(tx.resultingBalance?.toJSON().amount).toBe(balance);
}

describe('BET', () => {
  test('debita e gera 1 lançamento DEBIT', () => {
    const wallet = openWallet('100.00');
    const tx = makeTransaction({ money: brl('25.00') });
    const { ledgerEntry } = apply(wallet, tx);
    expect(tx.status).toBe(Status.Processed);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(ledgerEntry?.transactionId).toBe(tx.id);
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(tx.resultingBalance?.toJSON().amount).toBe('75.00');
  });

  test('sem saldo: REJECTED com INSUFFICIENT_FUNDS, sem lançamento e sem tocar na wallet', () => {
    const wallet = openWallet('100.00');
    const tx = makeTransaction({ money: brl('100.01') });
    const { ledgerEntry } = apply(wallet, tx);
    expect(ledgerEntry).toBeUndefined();
    expectRejected(wallet, tx, FailureCode.InsufficientFunds, '100.00');
    expect(wallet.version).toBe(1);
  });

  test('cenário da seção 8: duas apostas de 80 sobre 100, em sequência', () => {
    const wallet = openWallet('100.00');
    const first = makeTransaction({ money: brl('80.00') });
    const second = makeTransaction({ money: brl('80.00') });
    const entries = [apply(wallet, first).ledgerEntry, apply(wallet, second).ledgerEntry];
    expect(first.status).toBe(Status.Processed);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(entries.filter(Boolean)).toHaveLength(1);
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita, com ou sem referência à BET', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const win = makeTransaction({
      kind: Kind.Win,
      money: brl('60.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(wallet, win, bet).ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(win.referenceTransactionId).toBe(bet.id);
    processed(wallet, { kind: Kind.Win, money: brl('5.00') });
    expect(wallet.balance.toJSON().amount).toBe('140.00');
  });

  test('WIN só pode referenciar BET', () => {
    const wallet = openWallet('100.00');
    const otherWin = processed(wallet, { kind: Kind.Win });
    const win = makeTransaction({
      kind: Kind.Win,
      referenceExternalTransactionId: otherWin.externalTransactionId,
    });
    apply(wallet, win, otherWin);
    expectRejected(wallet, win, FailureCode.ReferenceKindNotAllowed, '125.00');
  });

  test('LOSS é PROCESSED sem lançamento e sem mudar saldo nem versão', () => {
    const wallet = openWallet('100.00');
    const loss = makeTransaction({ kind: Kind.Loss, money: brl('0.00') });
    const { ledgerEntry } = apply(wallet, loss);
    expect(loss.status).toBe(Status.Processed);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(loss.resultingBalance?.toJSON().amount).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('credita o valor de uma BET processada', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const refund = reversal(Kind.Refund, bet);
    const { ledgerEntry } = apply(wallet, refund, bet);
    expect(refund.status).toBe(Status.Processed);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('só referencia BET', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, { kind: Kind.Win });
    const refund = reversal(Kind.Refund, win);
    apply(wallet, refund, win);
    expectRejected(wallet, refund, FailureCode.ReferenceKindNotAllowed, '125.00');
  });

  test('uma única vez', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const second = reversal(Kind.Refund, bet);
    apply(wallet, second, bet, true);
    expectRejected(wallet, second, FailureCode.ReferenceAlreadyReversed, '75.00');
  });

  test('valor deve ser igual ao da referência', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const refund = reversal(Kind.Refund, bet, '24.99');
    apply(wallet, refund, bet);
    expectRejected(wallet, refund, FailureCode.ReferenceAmountMismatch, '75.00');
  });

  test('referência REJECTED não pode ser revertida', () => {
    const wallet = openWallet('10.00');
    const bet = makeTransaction({ money: brl('25.00') });
    apply(wallet, bet);
    const refund = reversal(Kind.Refund, bet);
    apply(wallet, refund, bet);
    expectRejected(wallet, refund, FailureCode.ReferenceNotProcessed, '10.00');
  });

  test.each([
    ['rodada', { roundId: 'round-2' }],
    ['player', { playerId: 'player-1', walletId: 'wallet-1', providerId: 'provider-b' }],
  ])('referência de outra %s é REFERENCE_MISMATCH', (_what, extra) => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const refund = reversal(Kind.Refund, bet, '25.00', extra);
    apply(wallet, refund, bet);
    expectRejected(wallet, refund, FailureCode.ReferenceMismatch, '75.00');
  });
});

describe('ROLLBACK', () => {
  test('de BET credita', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const rollback = reversal(Kind.Rollback, bet);
    expect(apply(wallet, rollback, bet).ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('de WIN debita', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, { kind: Kind.Win });
    const rollback = reversal(Kind.Rollback, win);
    expect(apply(wallet, rollback, win).ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('de REFUND debita', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const refund = processed(wallet, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }, bet);
    const rollback = reversal(Kind.Rollback, refund);
    expect(apply(wallet, rollback, refund).ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('75.00');
  });

  test('não referencia LOSS nem outro ROLLBACK', () => {
    const wallet = openWallet('100.00');
    const loss = processed(wallet, { kind: Kind.Loss });
    const rollback = reversal(Kind.Rollback, loss);
    apply(wallet, rollback, loss);
    expectRejected(wallet, rollback, FailureCode.ReferenceKindNotAllowed, '100.00');
  });

  test('que deixaria saldo negativo é rejeitado com código próprio', () => {
    const wallet = openWallet('0.00');
    const win = processed(wallet, { kind: Kind.Win, money: brl('50.00') });
    processed(wallet, { kind: Kind.Bet, money: brl('40.00') });
    const rollback = reversal(Kind.Rollback, win, '50.00');
    const { ledgerEntry } = apply(wallet, rollback, win);
    expect(ledgerEntry).toBeUndefined();
    expectRejected(wallet, rollback, FailureCode.ReversalWouldOverdraw, '10.00');
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
  });

  test('uma única vez', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet);
    const rollback = reversal(Kind.Rollback, bet);
    apply(wallet, rollback, bet, true);
    expectRejected(wallet, rollback, FailureCode.ReferenceAlreadyReversed, '75.00');
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente → PENDING_REFERENCE, sem tocar na wallet', () => {
    const wallet = openWallet('100.00');
    const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'not-yet' });
    const { ledgerEntry } = apply(wallet, refund);
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.nextAttemptAt).toBeDefined();
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('quando a referência chega, a pendente é aplicada', () => {
    const wallet = openWallet('100.00');
    const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'late-bet' });
    apply(wallet, refund);
    const bet = processed(wallet, { externalTransactionId: 'late-bet' });
    apply(wallet, refund, bet);
    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('referência ainda não resolvida mantém a dependente pendente', () => {
    const wallet = openWallet('100.00');
    const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-x' });
    apply(wallet, refund);
    const rollback = reversal(Kind.Rollback, refund);
    apply(wallet, rollback, refund);
    expect(rollback.status).toBe(Status.PendingReference);
  });

  test('esgotadas as tentativas → REJECTED com REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet('100.00');
    const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'never' });
    apply(wallet, refund);
    for (let attempt = 1; attempt < REFERENCE_RETRY_POLICY.maxAttempts; attempt += 1) {
      apply(wallet, refund);
      expect(refund.status).toBe(Status.PendingReference);
    }
    apply(wallet, refund);
    expectRejected(wallet, refund, FailureCode.ReferenceNotFound, '100.00');
  });
});

describe('wallet e moeda', () => {
  test('moeda diferente da wallet → CURRENCY_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const tx = makeTransaction({ money: usd('1.00') });
    apply(wallet, tx);
    expectRejected(wallet, tx, FailureCode.CurrencyMismatch, '100.00');
  });

  test('wallet de outro player → WALLET_NOT_FOUND', () => {
    const wallet = openWallet('100.00');
    const tx = makeTransaction({ playerId: 'intruder' });
    apply(wallet, tx);
    expectRejected(wallet, tx, FailureCode.WalletNotFound, '100.00');
  });
});
