import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

export interface InstanceOptions {
  databaseUrl: string;
  transactionsQueue: string;
  dlqQueue: string;
  eventsQueue: string;
  env?: Record<string, string>;
}

export interface Instance {
  name: string;
  baseUrl: string;
  process: Subprocess;
  logFile: string;
  /** kill -9: sem desligamento limpo. */
  kill(): Promise<void>;
  /** SIGTERM: desligamento limpo; devolve o código de saída. */
  stop(): Promise<number | null>;
  /** Espera o processo terminar sozinho. */
  exited(): Promise<{ exitCode: number | null; signal: string | null }>;
}

const PROJECT_ROOT = join(import.meta.dir, '..', '..');

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

let counter = 0;

/**
 * Sobe um PROCESSO real da aplicação (`bun src/main.ts`), igual ao que roda
 * em produção, apontando para o banco e as filas do teste.
 */
export async function startInstance(options: InstanceOptions): Promise<Instance> {
  counter += 1;
  const name = `instance-${counter}`;
  const port = await freePort();
  const logFile = join(tmpdir(), `wagering-${process.pid}-${name}.log`);
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: options.databaseUrl,
      SQS_TRANSACTIONS_QUEUE: options.transactionsQueue,
      SQS_DLQ_QUEUE: options.dlqQueue,
      SQS_EVENTS_QUEUE: options.eventsQueue,
      LOG_LEVEL: 'warn',
      OUTBOX_POLL_INTERVAL_MS: '100',
      CONSUMER_WAIT_TIME_SECONDS: '1',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      CONSUMER_RETRY_MAX_SECONDS: '2',
      ...options.env,
    },
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
  });

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited during startup; see ${logFile}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) break;
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline) throw new Error(`${name} did not become ready; see ${logFile}`);
    await Bun.sleep(50);
  }

  const exited = async () => {
    await child.exited;
    return { exitCode: child.exitCode, signal: child.signalCode as string | null };
  };
  return {
    name,
    baseUrl,
    process: child,
    logFile,
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
    async stop() {
      child.kill('SIGTERM');
      await child.exited;
      return child.exitCode;
    },
    exited,
  };
}
