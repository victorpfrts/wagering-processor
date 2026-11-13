import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors.ts';
import { InvalidMoneyError, ValidationError } from '../../src/domain/errors.ts';
import {
  brlProps,
  command,
  createHarness,
  expectLedgerConsistent,
  type Harness,
  newWallet,
  outboxEvents,
  snapshot,
  transactionRows,
} from '../support/harness.ts';
import { uuid } from '../support/test-database.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('BET', () => {
  test('debita, grava lançamento, transação e eventos na mesma transação', async () => {
    const walletId = await newWallet(h, '1000.00');
    const result = await h.process.execute(command(walletId, { money: brlProps('25.00') }));

    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: brlProps('975.00'),
      idempotentReplay: false,
    });
    expect(result.failureCode).toBeUndefined();

    const state = await expectLedgerConsistent(h, walletId);
    expect(state).toMatchObject({ balance: '975.00', version: 2, debits: 1 });
    expect(await transactionRows(h, walletId)).toMatchObject([
      { id: result.transactionId, status: 'PROCESSED', resulting_balance: '975.00' },
    ]);
    expect(await outboxEvents(h, walletId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('sem saldo: REJECTED auditável, sem lançamento e sem mexer na wallet', async () => {
    const walletId = await newWallet(h, '10.00');
    const result = await h.process.execute(command(walletId, { money: brlProps('10.01') }));

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brlProps('10.00'),
    });
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '10.00', version: 1, debits: 0 });
    expect(await transactionRows(h, walletId)).toMatchObject([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await outboxEvents(h, walletId)).toEqual(['WagerTransactionRejected']);
  });

  test('valores acima de 2^53 atravessam ORM e banco sem perder centavos', async () => {
    const walletId = await newWallet(h, '90071992547409.93');
    const result = await h.process.execute(command(walletId, { money: brlProps('0.01') }));
    expect(result.balance).toEqual(brlProps('90071992547409.92'));
    await expectLedgerConsistent(h, walletId);
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original, com o saldo daquele momento', async () => {
    const walletId = await newWallet(h, '100.00');
    const first = command(walletId, { money: brlProps('30.00') });
    const original = await h.process.execute(first);
    await h.process.execute(command(walletId, { money: brlProps('50.00') }));

    const replay = await h.process.execute(first);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual(brlProps('70.00')); // não os 20.00 atuais
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '20.00', debits: 2 });
    expect(await outboxEvents(h, walletId)).toHaveLength(4); // replay não gera evento
  });

  test('replay de transação rejeitada continua rejeitada', async () => {
    const walletId = await newWallet(h, '5.00');
    const bet = command(walletId, { money: brlProps('6.00') });
    const original = await h.process.execute(bet);
    const replay = await h.process.execute(bet);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(await transactionRows(h, walletId)).toHaveLength(1);
  });

  test('"25.5" e "25.50" são o mesmo payload', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('25.50') });
    await h.process.execute(bet);
    const replay = await h.process.execute({ ...bet, money: brlProps('25.5') });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma key com payload diferente é conflito, não replay, e nada muda', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('10.00') });
    await h.process.execute(bet);

    await expect(h.process.execute({ ...bet, money: brlProps('11.00') })).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expect(h.process.execute({ ...bet, roundId: 'other-round' })).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    expect(await transactionRows(h, walletId)).toHaveLength(1);
  });

  test('a mesma key em provedores diferentes não colide: são operações independentes', async () => {
    const walletId = await newWallet(h, '100.00');
    const fromA = command(walletId, {
      providerId: 'provider-a',
      idempotencyKey: 'shared-key',
      money: brlProps('10.00'),
    });
    const fromB = command(walletId, {
      providerId: 'provider-b',
      idempotencyKey: 'shared-key',
      money: brlProps('20.00'),
    });

    const a = await h.process.execute(fromA);
    const b = await h.process.execute(fromB);

    expect(a).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(b).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(b.transactionId).not.toBe(a.transactionId);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '70.00', debits: 2 });
    // cada provedor recebe de volta o resultado da SUA operação
    expect(await h.process.execute(fromA)).toEqual({ ...a, idempotentReplay: true });
    expect(await h.process.execute(fromB)).toEqual({ ...b, idempotentReplay: true });
  });

  test('mesmo id externo sob outra key é conflito', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId);
    await h.process.execute(bet);
    await expect(
      h.process.execute({ ...bet, idempotencyKey: 'another-key' }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '90.00' });
  });
});

describe('WIN, LOSS e reversões', () => {
  test('LOSS é PROCESSED sem lançamento e publica só WagerTransactionProcessed', async () => {
    const walletId = await newWallet(h, '100.00');
    const result = await h.process.execute(
      command(walletId, { kind: 'LOSS', money: brlProps('0.00') }),
    );
    expect(result).toMatchObject({ status: 'PROCESSED', balance: brlProps('100.00') });
    expect(await snapshot(h, walletId)).toMatchObject({ version: 1, entries: 1 });
    expect(await outboxEvents(h, walletId)).toEqual(['WagerTransactionProcessed']);
  });

  test('BET → WIN → REFUND da BET → ROLLBACK do WIN', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('40.00') });
    const win = command(walletId, {
      kind: 'WIN',
      money: brlProps('70.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await h.process.execute(bet);
    await h.process.execute(win);
    const refund = await h.process.execute(
      command(walletId, {
        kind: 'REFUND',
        money: brlProps('40.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const rollback = await h.process.execute(
      command(walletId, {
        kind: 'ROLLBACK',
        money: brlProps('70.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: brlProps('170.00') });
    expect(rollback).toMatchObject({ status: 'PROCESSED', balance: brlProps('100.00') });
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({
      balance: '100.00',
      version: 5,
      debits: 2,
      credits: 3,
    });
  });

  test('a mesma BET não é revertida duas vezes (REFUND e depois ROLLBACK)', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('40.00') });
    await h.process.execute(bet);
    const reversal = (kind: string) =>
      h.process.execute(
        command(walletId, {
          kind,
          money: brlProps('40.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
    expect(await reversal('REFUND')).toMatchObject({ status: 'PROCESSED' });
    expect(await reversal('REFUND')).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await reversal('ROLLBACK')).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '100.00', credits: 2 });
  });

  test('ROLLBACK que deixaria saldo negativo é rejeitado com código próprio', async () => {
    const walletId = await newWallet(h, '0.00');
    const win = command(walletId, { kind: 'WIN', money: brlProps('50.00') });
    await h.process.execute(win);
    await h.process.execute(command(walletId, { money: brlProps('30.00') }));
    const rollback = await h.process.execute(
      command(walletId, {
        kind: 'ROLLBACK',
        money: brlProps('50.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rollback).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
      balance: brlProps('20.00'),
    });
    await expectLedgerConsistent(h, walletId);
  });

  test('REFUND antes da BET fica PENDING_REFERENCE e o replay também', async () => {
    const walletId = await newWallet(h, '100.00');
    const refund = command(walletId, {
      kind: 'REFUND',
      money: brlProps('10.00'),
      referenceExternalTransactionId: 'bet-that-did-not-arrive',
    });
    const result = await h.process.execute(refund);
    expect(result).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(result.balance).toBeUndefined();
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1 });
    expect(await outboxEvents(h, walletId)).toEqual(['WagerTransactionPendingReference']);
    expect(await h.process.execute(refund)).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
    });
  });
});

describe('wallet e moeda', () => {
  test('wallet inexistente: REJECTED persistido com WALLET_NOT_FOUND, e replay', async () => {
    const walletId = uuid();
    const bet = command(walletId);
    const result = await h.process.execute(bet);
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });
    expect(result.balance).toBeUndefined();
    expect(await h.process.execute(bet)).toEqual({ ...result, idempotentReplay: true });
    expect(await transactionRows(h, walletId)).toHaveLength(1);
  });

  test('wallet de outro player também é WALLET_NOT_FOUND', async () => {
    const walletId = await newWallet(h, '100.00');
    const result = await h.process.execute(command(walletId, { playerId: 'intruder' }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1 });
  });

  test('moeda diferente da wallet: CURRENCY_MISMATCH', async () => {
    const walletId = await newWallet(h, '100.00');
    const result = await h.process.execute(
      command(walletId, { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: brlProps('100.00'),
    });
  });
});

describe('payload inválido não chega ao banco', () => {
  test.each([
    ['valor com 3 casas', { money: brlProps('1.001') }, InvalidMoneyError],
    ['valor negativo', { money: brlProps('-1.00') }, InvalidMoneyError],
    ['BET de valor zero', { money: brlProps('0.00') }, ValidationError],
    ['kind OPENING', { kind: 'OPENING' }, ValidationError],
    ['kind desconhecido', { kind: 'BONUS' }, ValidationError],
    ['REFUND sem referência', { kind: 'REFUND' }, ValidationError],
    ['key vazia', { idempotencyKey: ' ' }, ValidationError],
  ])('%s', async (_name, overrides, errorType) => {
    const walletId = await newWallet(h, '100.00');
    await expect(h.process.execute(command(walletId, overrides))).rejects.toThrow(errorType);
    expect(await transactionRows(h, walletId)).toHaveLength(0);
  });
});

describe('atomicidade', () => {
  test('falha depois do débito e antes do commit desfaz tudo; a nova tentativa processa', async () => {
    const walletId = await newWallet(h, '100.00');
    const bet = command(walletId, { money: brlProps('60.00') });

    // Gerador que quebra na 5ª chamada: transação e lançamento já foram
    // gravados e o saldo já foi alterado quando o erro acontece.
    let calls = 0;
    const failing = h.processWith({
      ids: {
        next() {
          calls += 1;
          if (calls === 5) throw new Error('simulated crash before commit');
          return uuid();
        },
      },
    });

    await expect(failing.execute(bet)).rejects.toThrow('simulated crash before commit');
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1, debits: 0 });
    expect(await transactionRows(h, walletId)).toHaveLength(0);
    expect(await outboxEvents(h, walletId)).toHaveLength(0);

    const retry = await h.process.execute(bet);
    expect(retry).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '40.00', debits: 1 });
  });
});
