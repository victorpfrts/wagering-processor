import { describe, expect, test } from 'bun:test';
import { REFERENCE_RETRY_POLICY } from '../../src/domain/backoff.ts';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors.ts';
import { FailureCode } from '../../src/domain/failure-code.ts';
import { canonicalJson, computePayloadHash } from '../../src/domain/payload-hash.ts';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.ts';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.ts';
import { brl, makeTransaction, NOW, PLAYER_ID, WALLET_ID } from './helpers.ts';

describe('WagerTransaction.create', () => {
  test('nasce em PENDING', () => {
    const tx = makeTransaction();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expect(() => makeTransaction({ kind })).toThrow(ValidationError);
    expect(() => makeTransaction({ kind, referenceExternalTransactionId: ' ' })).toThrow(
      ValidationError,
    );
    expect(makeTransaction({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(
      true,
    );
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => makeTransaction({ kind: Kind.Opening })).toThrow(ValidationError);
  });

  test('BET não aceita referência; ninguém referencia a si mesmo', () => {
    expect(() => makeTransaction({ referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
    expect(() =>
      makeTransaction({
        kind: Kind.Refund,
        externalTransactionId: 'same',
        referenceExternalTransactionId: 'same',
      }),
    ).toThrow(ValidationError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => makeTransaction({ money: brl('0.00') })).toThrow(ValidationError);
    expect(() => makeTransaction({ kind: Kind.Win, money: brl('0.00') })).toThrow(ValidationError);
    expect(makeTransaction({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('campos de identificação são obrigatórios', () => {
    expect(() => makeTransaction({ roundId: '' })).toThrow(ValidationError);
    expect(() => makeTransaction({ providerId: '  ' })).toThrow(ValidationError);
  });

  test('opening nasce PROCESSED com o saldo de abertura', () => {
    const tx = WagerTransaction.opening({
      id: 'tx-o',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      money: brl('10.00'),
      now: NOW,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultingBalance?.toJSON().amount).toBe('10.00');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction transições', () => {
  test('PENDING → PROCESSED guarda referência, saldo observado e instante', () => {
    const tx = makeTransaction();
    tx.markProcessed('ref-id', brl('75.00'), NOW);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.resultingBalance?.toJSON().amount).toBe('75.00');
    expect(tx.processedAt).toEqual(NOW);
  });

  test('PENDING → REJECTED guarda o failureCode', () => {
    const tx = makeTransaction();
    tx.reject(FailureCode.InsufficientFunds, brl('1.00'), NOW);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING → FAILED', () => {
    const tx = makeTransaction();
    tx.fail(FailureCode.InternalError, NOW);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING_REFERENCE agenda com backoff exponencial 2s, 4s, 8s...', () => {
    const tx = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      tx.markPendingReference(NOW);
      delays.push((tx.nextAttemptAt?.getTime() ?? 0) - NOW.getTime());
    }
    expect(tx.status).toBe(Status.PendingReference);
    expect(delays).toEqual([2000, 4000, 8000, 16000]);
    expect(tx.referenceAttempts).toBe(3);
  });

  test('esgota na tentativa de número maxAttempts', () => {
    const tx = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(tx.hasExhaustedReferenceAttempts()).toBe(false);
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts - 1; i += 1) {
      tx.markPendingReference(NOW);
      expect(tx.hasExhaustedReferenceAttempts()).toBe(false);
    }
    tx.markPendingReference(NOW);
    expect(tx.hasExhaustedReferenceAttempts()).toBe(true);
  });

  test('PENDING_REFERENCE → PROCESSED limpa o agendamento', () => {
    const tx = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(NOW);
    tx.markProcessed('bet-id', brl('1.00'), NOW);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, brl('1.00'), NOW)],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, undefined, NOW)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, NOW)],
  ])('estado terminal %s não transiciona mais', (_name, settle) => {
    const tx = makeTransaction();
    settle(tx);
    expect(() => tx.markProcessed(undefined, brl('1.00'), NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, undefined, NOW)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.InternalError, NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  const bet = makeTransaction({ kind: Kind.Bet });
  const win = makeTransaction({ kind: Kind.Win });
  const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
  const rollback = makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' });

  test('direções fixas', () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(makeTransaction({ kind: Kind.Loss }).ledgerDirectionFor()).toBeUndefined();
  });

  test('ROLLBACK é o inverso da referência', () => {
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(ValidationError);
  });
});

describe('payload hash e idempotency key', () => {
  const payload = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
  };

  test('JSON canônico ordena chaves em todos os níveis e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined, x: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"x":null,"z":1}]},"b":1}',
    );
  });

  test('é SHA-256 em hex e independe da ordem das chaves e da escala do valor', () => {
    const hash = computePayloadHash(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as typeof payload;
    expect(computePayloadHash(reordered)).toBe(hash);
    expect(computePayloadHash({ ...payload, money: brl('25') })).toBe(hash);
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(hash);
  });

  test.each([
    ['money', { money: brl('25.01') }],
    ['kind', { kind: Kind.Win }],
    ['walletId', { walletId: 'other' }],
    ['roundId', { roundId: 'other' }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('mudar %s muda o hash', (_field, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });

  test('mesma idempotency key com payload divergente é detectada como conflito', () => {
    const stored = makeTransaction({ externalTransactionId: 'transaction-123', roundId: 'round-987' });
    const replay = computePayloadHash({ ...payload });
    const divergent = computePayloadHash({ ...payload, money: brl('26.00') });
    expect(stored.idempotencyKey).toBe('provider-a:transaction-123');
    expect(stored.matchesPayload(replay)).toBe(true);
    expect(stored.matchesPayload(divergent)).toBe(false);
  });
});
