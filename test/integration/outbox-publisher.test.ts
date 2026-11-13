import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { type Clock, type EventPublisher, NOOP_METRICS } from '../../src/application/ports.ts';
import { PublishOutbox } from '../../src/application/publish-outbox.ts';
import type { OutboxMessage } from '../../src/domain/outbox-message.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/db/mikro-orm-unit-of-work.ts';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher.ts';
import { brlProps, command, createHarness, type Harness, newWallet } from '../support/harness.ts';
import { createSqsClient, createTestQueue, type TestQueue } from '../support/sqs.ts';

/** PostgreSQL e SQS (LocalStack) reais. Os "defeitos" são injetados em volta do publisher real. */
let h: Harness;
let sqs: SQSClient;
const queues: TestQueue[] = [];

beforeAll(async () => {
  h = await createHarness();
  sqs = createSqsClient();
});
afterAll(async () => {
  await Promise.all(queues.map((queue) => queue.delete()));
  sqs.destroy();
  await h.close();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function newQueue(): Promise<TestQueue> {
  const queue = await createTestQueue(sqs, 'wager-events-test');
  queues.push(queue);
  return queue;
}

/** Publisher real, registrando cada id enviado (para detectar envio em dobro). */
function recording(inner: EventPublisher) {
  const sentIds: string[] = [];
  const publisher: EventPublisher = {
    async publish(messages) {
      const failed = await inner.publish(messages);
      for (const message of messages) if (!failed.has(message.id)) sentIds.push(message.id);
      return failed;
    },
  };
  return { publisher, sentIds };
}

function outboxPublisher(publisher: EventPublisher, options: { clock?: Clock; batchSize?: number } = {}) {
  return new PublishOutbox(
    new MikroOrmUnitOfWork(h.orm, { lockTimeoutMs: 5000 }),
    publisher,
    options.clock ?? { now: () => new Date() },
    silentLogger,
    NOOP_METRICS,
    options.batchSize ?? 100,
  );
}

async function runUntilEmpty(publisher: PublishOutbox): Promise<number> {
  let total = 0;
  for (;;) {
    const { published, failed } = await publisher.execute();
    total += published;
    if (published === 0 && failed === 0) return total;
  }
}

interface OutboxRow {
  id: string;
  event_type: string;
  attempts: number;
  published: boolean;
  next_attempt_at: Date | null;
}

async function outboxRows(walletIds: string[]): Promise<OutboxRow[]> {
  const rows = await h.db.sql`
    select id, event_type, attempts, published_at is not null as published, next_attempt_at
      from outbox_messages where partition_key in ${h.db.sql(walletIds)} order by seq`;
  return rows.map((row: OutboxRow) => ({ ...row }));
}

/** Tira do caminho os eventos pendentes deixados por outros testes deste arquivo. */
async function settleEverything(): Promise<void> {
  await h.db.sql`update outbox_messages set published_at = now() where published_at is null`;
}

describe('publicação da outbox', () => {
  test('publica depois do commit, na ordem, e marca como publicado', async () => {
    await settleEverything();
    const queue = await newQueue();
    const walletId = await newWallet(h, '100.00');
    await h.process.execute(command(walletId, { money: brlProps('25.00') }));
    const before = await outboxRows([walletId]);
    expect(before.map((row) => row.published)).toEqual([false, false]);

    const publisher = outboxPublisher(new SqsEventPublisher(sqs, queue.name));
    expect(await publisher.execute()).toEqual({ published: 2, failed: 0 });

    const received = await queue.drain();
    expect(received.map((m) => m.body['eventType'])).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(received.every((m) => m.groupId === walletId)).toBe(true);
    expect(received[1]?.body).toMatchObject({
      eventId: before[1]?.id,
      version: 1,
      correlationId: 'test-correlation',
      data: { walletId, balanceAfter: brlProps('75.00'), walletVersion: 2 },
    });

    expect((await outboxRows([walletId])).every((row) => row.published)).toBe(true);
    expect(await publisher.execute()).toEqual({ published: 0, failed: 0 });
    expect(await queue.drain()).toHaveLength(0);
  });

  test('transação desfeita não deixa evento para publicar', async () => {
    await settleEverything();
    const walletId = await newWallet(h, '100.00');
    let calls = 0;
    const failing = h.processWith({
      ids: {
        next() {
          calls += 1;
          if (calls === 5) throw new Error('crash before commit');
          return Bun.randomUUIDv7();
        },
      },
    });
    await expect(failing.execute(command(walletId))).rejects.toThrow('crash before commit');
    expect(await outboxRows([walletId])).toHaveLength(0);
  });
});

describe('publishers concorrentes sobre a mesma outbox', () => {
  test('dois publishers: cada evento sai uma vez e a ordem por wallet é preservada', async () => {
    await settleEverything();
    const queue = await newQueue();
    const walletIds = await Promise.all(Array.from({ length: 12 }, () => newWallet(h, '1000.00')));
    // 12 wallets × 8 apostas = 96 transações = 192 eventos
    await Promise.all(
      walletIds.map(async (walletId) => {
        for (let i = 0; i < 8; i += 1) {
          await h.process.execute(command(walletId, { money: brlProps('1.00') }));
        }
      }),
    );

    const a = recording(new SqsEventPublisher(sqs, queue.name));
    const b = recording(new SqsEventPublisher(sqs, queue.name));
    const [publishedByA, publishedByB] = await Promise.all([
      runUntilEmpty(outboxPublisher(a.publisher, { batchSize: 7 })),
      runUntilEmpty(outboxPublisher(b.publisher, { batchSize: 7 })),
    ]);

    // nenhum evento perdido, nenhum enviado duas vezes
    const sentIds = [...a.sentIds, ...b.sentIds];
    expect(publishedByA + publishedByB).toBe(192);
    expect(sentIds).toHaveLength(192);
    expect(new Set(sentIds).size).toBe(192);
    // os dois trabalharam de verdade
    expect(a.sentIds.length).toBeGreaterThan(0);
    expect(b.sentIds.length).toBeGreaterThan(0);
    expect((await outboxRows(walletIds)).every((row) => row.published)).toBe(true);

    // ordem por wallet: as versões chegam estritamente crescentes
    const received = await queue.drain();
    expect(received).toHaveLength(192);
    for (const walletId of walletIds) {
      const versions = received
        .filter((m) => m.groupId === walletId && m.body['eventType'] === 'WalletBalanceChanged')
        .map((m) => m.body['data'].walletVersion);
      expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });
});

describe('falhas de publicação', () => {
  test('falha de um evento agenda nova tentativa e segura os seguintes da mesma wallet', async () => {
    await settleEverything();
    const queue = await newQueue();
    const blocked = await newWallet(h, '100.00');
    const healthy = await newWallet(h, '100.00');
    await h.process.execute(command(blocked, { money: brlProps('1.00') }));
    await h.process.execute(command(blocked, { money: brlProps('2.00') }));
    await h.process.execute(command(healthy, { money: brlProps('3.00') }));
    const firstOfBlocked = (await outboxRows([blocked]))[0]?.id as string;

    let brokerRejects = true;
    const real = new SqsEventPublisher(sqs, queue.name);
    const flaky: EventPublisher = {
      async publish(messages: OutboxMessage[]) {
        const failed = await real.publish(messages.filter((m) => !(brokerRejects && m.id === firstOfBlocked)));
        if (brokerRejects && messages.some((m) => m.id === firstOfBlocked)) failed.add(firstOfBlocked);
        return failed;
      },
    };
    let now = new Date('2026-07-29T15:00:00.000Z');
    const publisher = outboxPublisher(flaky, { clock: { now: () => now } });

    expect(await publisher.execute()).toEqual({ published: 2, failed: 1 });
    const afterFailure = await outboxRows([blocked]);
    expect(afterFailure.map((row) => row.published)).toEqual([false, false, false, false]);
    expect(afterFailure.map((row) => row.attempts)).toEqual([1, 0, 0, 0]);
    expect(afterFailure[0]?.next_attempt_at?.toISOString()).toBe('2026-07-29T15:00:01.000Z');
    // a wallet saudável não foi afetada
    expect((await queue.drain()).every((m) => m.groupId === healthy)).toBe(true);

    // antes do horário da nova tentativa, nada da wallet bloqueada sai
    expect(await publisher.execute()).toEqual({ published: 0, failed: 0 });

    // broker volta e o relógio passa do backoff: tudo sai, na ordem original
    brokerRejects = false;
    now = new Date('2026-07-29T15:00:01.500Z');
    expect(await publisher.execute()).toEqual({ published: 4, failed: 0 });
    const received = await queue.drain();
    expect(received.map((m) => m.body['data'].walletVersion ?? 'tx')).toEqual(['tx', 2, 'tx', 3]);
    expect(received[0]?.body['eventId']).toBe(firstOfBlocked);
  });

  test('SQS indisponível: nada se perde, o backoff cresce e tudo sai quando o broker volta', async () => {
    await settleEverything();
    const queue = await newQueue();
    const walletId = await newWallet(h, '100.00');
    await h.process.execute(command(walletId, { money: brlProps('10.00') }));

    const deadSqs = createSqsClient('http://localhost:9');
    let now = new Date('2026-07-29T15:00:00.000Z');
    const clock = { now: () => now };
    const offline = outboxPublisher(new SqsEventPublisher(deadSqs, queue.name), { clock });

    expect(await offline.execute()).toEqual({ published: 0, failed: 1 });
    now = new Date(now.getTime() + 1000);
    expect(await offline.execute()).toEqual({ published: 0, failed: 1 });
    deadSqs.destroy();

    const pending = await outboxRows([walletId]);
    expect(pending.map((row) => [row.published, row.attempts])).toEqual([
      [false, 2],
      [false, 0],
    ]);

    now = new Date(now.getTime() + 2000);
    const online = outboxPublisher(new SqsEventPublisher(sqs, queue.name), { clock });
    expect(await online.execute()).toEqual({ published: 2, failed: 0 });
    expect(await queue.drain()).toHaveLength(2);
  });

  test('processo morre depois do envio e antes do commit: outra instância reenvia, sem duplicar', async () => {
    await settleEverything();
    const queue = await newQueue();
    const walletId = await newWallet(h, '100.00');
    await h.process.execute(command(walletId, { money: brlProps('10.00') }));

    // "Instância 1": envia ao SQS de verdade e morre antes do commit que
    // marcaria os eventos como publicados (a transação é desfeita, como num kill -9).
    const real = new SqsEventPublisher(sqs, queue.name);
    const unitOfWork = new MikroOrmUnitOfWork(h.orm, { lockTimeoutMs: 5000 });
    const crashed = new PublishOutbox(
      {
        run: (work) =>
          unitOfWork.run(async (context) => {
            await work(context);
            throw new Error('process killed before commit');
          }),
      },
      real,
      { now: () => new Date() },
      silentLogger,
      NOOP_METRICS,
      100,
    );
    await expect(crashed.execute()).rejects.toThrow('process killed before commit');
    expect((await outboxRows([walletId])).map((row) => row.published)).toEqual([false, false]);

    // "Instância 2" assume: reenvia os mesmos eventos.
    const survivor = outboxPublisher(real);
    expect(await survivor.execute()).toEqual({ published: 2, failed: 0 });
    expect((await outboxRows([walletId])).every((row) => row.published)).toBe(true);

    // O consumidor recebe cada eventId uma única vez: o SQS FIFO descartou o
    // reenvio pelo MessageDeduplicationId. E mesmo que não descartasse, o
    // eventId é a chave para o consumidor deduplicar.
    const received = await queue.drain();
    const eventIds = received.map((m) => m.body['eventId']);
    expect(eventIds).toHaveLength(2);
    expect(new Set(eventIds).size).toBe(2);
  });
});
