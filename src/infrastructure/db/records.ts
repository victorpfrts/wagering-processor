import { EntitySchema } from '@mikro-orm/core';

/**
 * Registros de persistência: objetos simples que espelham as tabelas.
 * O domínio não conhece estes tipos; a conversão fica em mappers.ts.
 * Valores monetários são NUMERIC no banco e string aqui — nunca number.
 */

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string' },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'Date' },
    updatedAt: { type: 'Date' },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultingBalance: string | null;
  resultingBalanceCurrency: string | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultingBalance: { type: 'decimal', precision: 19, scale: 2, nullable: true },
    resultingBalanceCurrency: { type: 'string', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', nullable: true },
    createdAt: { type: 'Date' },
    processedAt: { type: 'Date', nullable: true },
  },
});

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    balanceBefore: { type: 'decimal', precision: 19, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 19, scale: 2 },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'Date' },
  },
});

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    partitionKey: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', nullable: true },
    publishedAt: { type: 'Date', nullable: true },
  },
});

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { type: 'Date' },
    processedAt: { type: 'Date', nullable: true },
  },
});

export const entitySchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxSchema,
  InboxSchema,
];
