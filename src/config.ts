export interface AppConfig {
  port: number;
  logLevel: string;
  /** Prazo para o desligamento limpo antes de forçar a saída. */
  shutdownTimeoutMs: number;
  databaseUrl: string;
  db: {
    poolMax: number;
    /** Espera máxima por um lock de linha antes de devolver falha transitória. */
    lockTimeoutMs: number;
  };
  outbox: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
  };
  pendingReference: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
  };
  consumer: {
    enabled: boolean;
    waitTimeSeconds: number;
    maxMessages: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
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

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: integer(env, 'PORT', 3000),
    logLevel: text(env, 'LOG_LEVEL', 'info'),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 25_000),
    databaseUrl: text(env, 'DATABASE_URL', 'postgres://wagering:wagering@localhost:5433/wagering'),
    db: {
      poolMax: integer(env, 'DB_POOL_MAX', 10),
      lockTimeoutMs: integer(env, 'DB_LOCK_TIMEOUT_MS', 3000),
    },
    outbox: {
      enabled: flag(env, 'OUTBOX_ENABLED', true),
      pollIntervalMs: integer(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: integer(env, 'OUTBOX_BATCH_SIZE', 100),
    },
    pendingReference: {
      enabled: flag(env, 'PENDING_REFERENCE_ENABLED', true),
      pollIntervalMs: integer(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1000),
      batchSize: integer(env, 'PENDING_REFERENCE_BATCH_SIZE', 50),
    },
    consumer: {
      enabled: flag(env, 'CONSUMER_ENABLED', true),
      waitTimeSeconds: integer(env, 'CONSUMER_WAIT_TIME_SECONDS', 5),
      maxMessages: integer(env, 'CONSUMER_MAX_MESSAGES', 10),
      retryBaseSeconds: integer(env, 'CONSUMER_RETRY_BASE_SECONDS', 2),
      retryMaxSeconds: integer(env, 'CONSUMER_RETRY_MAX_SECONDS', 60),
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
