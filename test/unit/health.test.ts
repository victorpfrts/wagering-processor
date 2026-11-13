import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../../src/config.ts';
import { HealthController } from '../../src/interfaces/http/health.controller.ts';

const never = new Promise<never>(() => {});
const config = { ...loadConfig({}), readinessTimeoutMs: 100 };

function controller(database: Promise<unknown>, queue: Promise<unknown>): HealthController {
  const orm = { em: { fork: () => ({ execute: () => database }) } } as unknown as MikroORM;
  const sqs = { send: () => queue } as unknown as SQSClient;
  return new HealthController(orm, sqs, config);
}

async function checksOf(health: HealthController): Promise<unknown> {
  try {
    return (await health.ready()).checks;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    return ((error as ServiceUnavailableException).getResponse() as { checks: unknown }).checks;
  }
}

describe('GET /health/ready', () => {
  test('dependências respondendo: pronto', async () => {
    const health = controller(Promise.resolve([]), Promise.resolve({}));
    expect(await health.ready()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('banco que não responde conta como fora do ar, dentro do prazo', async () => {
    const startedAt = Date.now();
    expect(await checksOf(controller(never, Promise.resolve({})))).toEqual({
      postgres: 'down',
      sqs: 'up',
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test('fila que não responde ou que falha conta como fora do ar', async () => {
    expect(await checksOf(controller(Promise.resolve([]), never))).toEqual({
      postgres: 'up',
      sqs: 'down',
    });
    expect(
      await checksOf(controller(Promise.resolve([]), Promise.reject(new Error('refused')))),
    ).toEqual({ postgres: 'up', sqs: 'down' });
  });

  test('live não depende de nada', () => {
    expect(controller(never, never).live()).toEqual({ status: 'ok' });
  });
});
