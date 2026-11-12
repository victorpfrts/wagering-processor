import { createHash } from 'node:crypto';
import type { Money } from './money.ts';
import type { WagerTransactionKind } from './wager-transaction.ts';

/** Subconjunto de campos de negócio que entra no hash. Header e transporte ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/** JSON determinístico: chaves ordenadas em todos os níveis, `undefined` omitido. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * SHA-256 (hex) do JSON canônico do payload de negócio. `money` entra já
 * normalizado ("25.5" e "25.50" produzem o mesmo hash).
 */
export function computePayloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
