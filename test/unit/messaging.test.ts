import { describe, expect, test } from 'bun:test';
import { applyWagerTransaction } from '../../src/domain/apply-wager-transaction.ts';
import { exponentialBackoffMs } from '../../src/domain/backoff.ts';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../src/domain/events/wager-transaction-events.ts';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed.ts';
import { FailureCode } from '../../src/domain/failure-code.ts';
import { InboxMessage } from '../../src/domain/inbox-message.ts';
import { OutboxMessage } from '../../src/domain/outbox-message.ts';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction.ts';
import { brl, makeTransaction, NOW, openWallet, WALLET_ID } from './helpers.ts';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: NOW };

function runBet(amount: string) {
  const wallet = openWallet('100.00');
  const transaction = makeTransaction({ money: brl(amount) });
  const { ledgerEntry } = applyWagerTransaction({
    wallet,
    transaction,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: 'entry-1',
    now: NOW,
  });
  return { wallet, transaction, ledgerEntry };
}

describe('eventos de integração', () => {
  test('WalletBalanceChanged: tipo e versão no tipo, data só com MoneyProps', () => {
    const { wallet, ledgerEntry } = runBet('25.00');
    const event = WalletBalanceChanged.from(wallet, ledgerEntry!, { ...ctx, causationId: 'msg-1' });
    const json = JSON.parse(JSON.stringify(event));
    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: ledgerEntry!.transactionId,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('WagerTransactionProcessed carrega o saldo observado; sem causationId a chave é omitida', () => {
    const { transaction } = runBet('25.00');
    const json = WagerTransactionProcessed.from(transaction, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe(transaction.id);
    expect(json.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect('causationId' in json).toBe(false);
    expect(() => WagerTransactionRejected.from(transaction, ctx)).toThrow(ValidationError);
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const { transaction } = runBet('500.00');
    const json = WagerTransactionRejected.from(transaction, ctx).toJSON();
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(JSON.parse(JSON.stringify(json)).data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(() => WagerTransactionProcessed.from(transaction, ctx)).toThrow(ValidationError);
  });

  test('WagerTransactionPendingReference carrega a referência e a próxima tentativa', () => {
    const transaction = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'b-1' });
    transaction.markPendingReference(NOW);
    const event = WagerTransactionPendingReference.from(transaction, ctx);
    expect(event.partitionKey).toBe(WALLET_ID);
    expect(event.toJSON().data.referenceExternalTransactionId).toBe('b-1');
    expect(event.toJSON().data.nextAttemptAt).toBe('2026-07-29T15:00:02.000Z');
  });

  test('data do evento é congelada', () => {
    const { transaction } = runBet('25.00');
    const event = WagerTransactionProcessed.from(transaction, ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const enqueue = () => OutboxMessage.enqueue(WagerTransactionProcessed.from(runBet('25.00').transaction, ctx));

  test('enqueue guarda o envelope serializado e nasce pendente e vencida', () => {
    const message = enqueue();
    expect(message.id).toBe('evt-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.partitionKey).toBe(WALLET_ID);
    expect(message.payload['eventId']).toBe('evt-1');
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  test('scheduleRetry incrementa attempts e aplica backoff 1s, 2s, 4s', () => {
    const message = enqueue();
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      message.scheduleRetry(NOW);
      delays.push((message.nextAttemptAt?.getTime() ?? 0) - NOW.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(message.attempts).toBe(3);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 4000))).toBe(true);
  });

  test('markPublished encerra: não é mais pendente nem aceita nova transição', () => {
    const message = enqueue();
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvalidTransactionStateError);
  });

  test('backoff respeita o teto', () => {
    expect(exponentialBackoffMs(0, { baseMs: 1000, maxMs: 60000 })).toBe(1000);
    expect(exponentialBackoffMs(10, { baseMs: 1000, maxMs: 60000 })).toBe(60000);
    expect(exponentialBackoffMs(5000, { baseMs: 1000, maxMs: 60000 })).toBe(60000);
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed, uma única vez', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'abc',
      now: NOW,
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.matchesPayload('abc')).toBe(true);
    expect(message.matchesPayload('xyz')).toBe(false);
    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});
