import { Money } from '../../src/domain/money.ts';
import { computePayloadHash } from '../../src/domain/payload-hash.ts';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction.ts';
import { Wallet } from '../../src/domain/wallet.ts';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(balance),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: NOW,
  }).wallet;
}

let sequence = 0;

export function makeTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  const base = {
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...overrides,
  };
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    idempotencyKey: `${base.providerId}:${base.externalTransactionId}`,
    payloadHash: computePayloadHash(base),
    now: NOW,
    ...base,
  });
}
