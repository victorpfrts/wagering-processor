export interface AppConfig {
  port: number;
  databaseUrl: string;
  db: {
    poolMax: number;
    /** Espera máxima por um lock de linha antes de devolver falha transitória. */
    lockTimeoutMs: number;
  };
  sqs: {
    endpoint: string;
    region: string;
    transactionsQueue: string;
    dlqQueue: string;
    eventsQueue: string;
  };
}

type Env = Record<string, string | undefined>;

function text(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: integer(env, 'PORT', 3000),
    databaseUrl: text(env, 'DATABASE_URL', 'postgres://wagering:wagering@localhost:5433/wagering'),
    db: {
      poolMax: integer(env, 'DB_POOL_MAX', 10),
      lockTimeoutMs: integer(env, 'DB_LOCK_TIMEOUT_MS', 3000),
    },
    sqs: {
      endpoint: text(env, 'SQS_ENDPOINT', 'http://localhost:4566'),
      region: text(env, 'AWS_REGION', 'us-east-1'),
      transactionsQueue: text(env, 'SQS_TRANSACTIONS_QUEUE', 'wager-transactions.fifo'),
      dlqQueue: text(env, 'SQS_DLQ_QUEUE', 'wager-transactions-dlq.fifo'),
      eventsQueue: text(env, 'SQS_EVENTS_QUEUE', 'wager-events.fifo'),
    },
  };
}

export const APP_CONFIG = Symbol('AppConfig');
