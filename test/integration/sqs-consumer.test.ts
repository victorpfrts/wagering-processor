import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type MessageOutcome, NOOP_METRICS } from '../../src/application/ports.ts';
import { SqsConsumer } from '../../src/infrastructure/sqs/sqs-consumer.ts';
import {
  type MessageHandler,
  WagerMessageHandler,
} from '../../src/interfaces/sqs/wager-message-handler.ts';
import {
  brlProps,
  createHarness,
  expectLedgerConsistent,
  type Harness,
  newWallet,
  playerOf,
  snapshot,
  transactionRows,
} from '../support/harness.ts';
import { createSqsClient, createTestQueue, type TestQueue } from '../support/sqs.ts';
import { uuid } from '../support/test-database.ts';

/**
 * PostgreSQL e SQS (LocalStack) reais. Cada teste tem seu par fila + DLQ,
 * com redrive após 3 recebimentos e visibilidade de 2s para os redeliveries
 * acontecerem rápido.
 */
const MAX_RECEIVE_COUNT = 3;
const VISIBILITY_SECONDS = 2;

let h: Harness;
let sqs: SQSClient;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  h = await createHarness();
  sqs = createSqsClient();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  sqs.destroy();
  await h.close();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface Queues {
  main: TestQueue;
  dlq: TestQueue;
}

async function newQueues(): Promise<Queues> {
  const dlq = await createTestQueue(sqs, 'wager-dlq-test');
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.url, AttributeNames: ['QueueArn'] }),
  );
  const main = await createTestQueue(sqs, 'wager-tx-test', {
    VisibilityTimeout: String(VISIBILITY_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: attributes.Attributes?.['QueueArn'],
      maxReceiveCount: String(MAX_RECEIVE_COUNT),
    }),
  });
  cleanups.push(async () => {
    await main.delete();
    await dlq.delete();
  });
  return { main, dlq };
}

interface Running {
  consumer: SqsConsumer;
  outcomes: MessageOutcome[];
}

function startConsumer(
  queues: Queues,
  options: { handler?: MessageHandler; client?: SQSClient } = {},
): Running {
  const outcomes: MessageOutcome[] = [];
  const consumer = new SqsConsumer(
    options.client ?? sqs,
    {
      queueName: queues.main.name,
      dlqName: queues.dlq.name,
      waitTimeSeconds: 1,
      maxMessages: 10,
      retryBaseSeconds: 1,
      retryMaxSeconds: 2,
    },
    options.handler ?? new WagerMessageHandler(h.process, silentLogger),
    silentLogger,
    { ...noopMetrics, messageHandled: (outcome) => outcomes.push(outcome) },
  );
  consumer.start();
  cleanups.push(() => consumer.stop());
  return { consumer, outcomes };
}

const noopMetrics = NOOP_METRICS;

function wagerMessage(walletId: string, overrides: Record<string, unknown> = {}, messageId = `msg-${uuid()}`) {
  const externalTransactionId = `ext-${uuid()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: playerOf(walletId),
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brlProps('25.00'),
      ...overrides,
    },
  };
}

/** Cada envio é uma entrega distinta para o SQS, mesmo com corpo repetido. */
async function send(queues: Queues, body: unknown, groupId = 'group'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.main.url,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(50);
  }
}

async function inboxCount(messageId: string): Promise<number> {
  const [{ count }] =
    await h.db.sql`select count(*)::int as count from inbox_messages where message_id = ${messageId}`;
  return count;
}

async function queueDepth(queue: TestQueue): Promise<number> {
  const response = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? 0) +
    Number(response.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0)
  );
}

async function readDlq(queue: TestQueue) {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  return (response.Messages ?? []).map((message) => ({
    body: message.Body ?? '',
    reason: message.MessageAttributes?.['failureReason']?.StringValue,
  }));
}

describe('consumo de wager-transactions', () => {
  test('processa pelo mesmo use case do HTTP, grava inbox e só então faz ack', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const message = wagerMessage(walletId);
    const { outcomes } = startConsumer(queues);

    await send(queues, message, walletId);
    await until(() => outcomes.length === 1);

    expect(outcomes).toEqual(['acked']);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await queueDepth(queues.main)).toBe(0);
    const [event] = await h.db.sql`
      select payload from outbox_messages where partition_key = ${walletId} order by seq limit 1`;
    expect(event.payload).toMatchObject({
      correlationId: message.messageId,
      causationId: message.messageId,
    });
  });

  test('erro de negócio é terminal: REJECTED gravado, ack, nada na DLQ', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '10.00');
    const { outcomes } = startConsumer(queues);

    await send(queues, wagerMessage(walletId), walletId);
    await until(() => outcomes.length === 1);

    expect(outcomes).toEqual(['acked']);
    expect(await transactionRows(h, walletId)).toMatchObject([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await queueDepth(queues.dlq)).toBe(0);
  });

  test('REFUND entregue antes da BET fica PENDING_REFERENCE e é confirmado', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const { outcomes } = startConsumer(queues);

    await send(
      queues,
      wagerMessage(walletId, { kind: 'REFUND', referenceExternalTransactionId: 'bet-later' }),
      walletId,
    );
    await until(() => outcomes.length === 1);

    expect(outcomes).toEqual(['acked']);
    expect(await transactionRows(h, walletId)).toMatchObject([{ status: 'PENDING_REFERENCE' }]);
  });
});

describe('redelivery e duplicatas', () => {
  test('a mesma mensagem entregue 5 vezes produz um único débito', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const message = wagerMessage(walletId);
    const { outcomes } = startConsumer(queues);

    for (let i = 0; i < 5; i += 1) await send(queues, message, walletId);
    await until(() => outcomes.length === 5);

    expect(outcomes.every((outcome) => outcome === 'acked')).toBe(true);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await transactionRows(h, walletId)).toHaveLength(1);
  });

  test('provedor reenvia a operação em OUTRA mensagem: replay pela idempotency key', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const first = wagerMessage(walletId);
    const resend = { ...first, messageId: `msg-${uuid()}` };
    const { outcomes } = startConsumer(queues);

    await send(queues, first, walletId);
    await send(queues, resend, walletId);
    await until(() => outcomes.length === 2);

    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await inboxCount(first.messageId)).toBe(1);
    expect(await inboxCount(resend.messageId)).toBe(1);
  });

  test('worker morre depois do commit e antes do ack: o redelivery não duplica o efeito', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const message = wagerMessage(walletId);

    // Do ponto de vista do broker, "morrer antes do ack" é: o DeleteMessage
    // nunca chega. O primeiro ack é descartado; o commit já aconteceu.
    let acksDropped = 0;
    const flakyClient = new Proxy(sqs, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver);
        return (command: unknown, ...rest: unknown[]) => {
          if (command instanceof DeleteMessageCommand && acksDropped === 0) {
            acksDropped += 1;
            return Promise.reject(new Error('process died before ack'));
          }
          return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
        };
      },
    });
    const { outcomes } = startConsumer(queues, { client: flakyClient });

    await send(queues, message, walletId);
    await until(() => acksDropped === 1);
    // o efeito já está confirmado, mas a mensagem continua na fila
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await queueDepth(queues.main)).toBe(1);

    // a visibilidade expira, a mensagem volta e é reconhecida pelo inbox
    await until(() => outcomes.length === 1);
    expect(outcomes).toEqual(['acked']);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await transactionRows(h, walletId)).toHaveLength(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await queueDepth(queues.main)).toBe(0);
  });
});

describe('falhas permanentes → DLQ direto', () => {
  test.each([
    ['JSON malformado', () => '{"broken":', 'MALFORMED_JSON'],
    ['schema inválido', () => ({ messageId: 'm', type: 'Other', data: {} }), 'INVALID_MESSAGE_SCHEMA'],
    ['kind OPENING', (w: string) => wagerMessage(w, { kind: 'OPENING' }), 'INVALID_MESSAGE_SCHEMA'],
    ['valor com 3 casas', (w: string) => wagerMessage(w, { money: brlProps('1.001') }), 'VALIDATION_ERROR'],
    ['valor como number', (w: string) => wagerMessage(w, { money: { amount: 5, currency: 'BRL' } }), 'INVALID_MESSAGE_SCHEMA'],
  ])('%s', async (_name, build, reason) => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const { outcomes } = startConsumer(queues);

    await send(queues, build(walletId), walletId);
    await until(() => outcomes.length === 1);

    expect(outcomes).toEqual(['dead_lettered']);
    expect(await readDlq(queues.dlq)).toMatchObject([{ reason }]);
    expect(await queueDepth(queues.main)).toBe(0);
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '100.00', version: 1 });
  });

  test('mesmo messageId com conteúdo diferente não é redelivery: DLQ, sem segundo efeito', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const original = wagerMessage(walletId);
    const tampered = { ...wagerMessage(walletId, { money: brlProps('99.00') }), messageId: original.messageId };
    const { outcomes } = startConsumer(queues);

    await send(queues, original, walletId);
    await send(queues, tampered, walletId);
    await until(() => outcomes.length === 2);

    expect(outcomes).toEqual(['acked', 'dead_lettered']);
    expect(await readDlq(queues.dlq)).toMatchObject([{ reason: 'MESSAGE_ID_REUSED' }]);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
  });

  test('mesma idempotency key com payload diferente: DLQ para auditoria', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const original = wagerMessage(walletId);
    const conflicting = {
      ...original,
      messageId: `msg-${uuid()}`,
      data: { ...original.data, money: brlProps('26.00') },
    };
    const { outcomes } = startConsumer(queues);

    await send(queues, original, walletId);
    await send(queues, conflicting, walletId);
    await until(() => outcomes.length === 2);

    expect(outcomes).toEqual(['acked', 'dead_lettered']);
    expect(await readDlq(queues.dlq)).toMatchObject([{ reason: 'IDEMPOTENCY_CONFLICT' }]);
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
  });
});

describe('falhas transitórias → retry com backoff → DLQ pelo limite', () => {
  test('lock disputado: a mensagem volta à fila e é processada quando o lock é liberado', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const holder = h.db.sql.begin(async (tx) => {
      await tx`select 1 from wallets where id = ${walletId} for update`;
      await release;
    });
    const impatient = new WagerMessageHandler(h.processWith({ lockTimeoutMs: 100 }), silentLogger);
    const { outcomes } = startConsumer(queues, { handler: impatient });

    try {
      await send(queues, wagerMessage(walletId), walletId);
      await until(() => outcomes.includes('retried'));
      expect(await transactionRows(h, walletId)).toHaveLength(0);
    } finally {
      resolve();
      await holder;
    }

    await until(() => outcomes.includes('acked'));
    expect(outcomes.at(-1)).toBe('acked');
    expect(outcomes.slice(0, -1).every((outcome) => outcome === 'retried')).toBe(true);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
  });

  test(`falha que persiste: após ${MAX_RECEIVE_COUNT} recebimentos o SQS move para a DLQ`, async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const message = wagerMessage(walletId);
    let attempts = 0;
    const alwaysFailing: MessageHandler = {
      handle() {
        attempts += 1;
        return Promise.resolve({ action: 'retry', reason: 'UNAVAILABLE' });
      },
    };
    const { outcomes } = startConsumer(queues, { handler: alwaysFailing });

    await send(queues, message, walletId);
    await until(async () => (await queueDepth(queues.dlq)) === 1, 30_000);

    expect(attempts).toBe(MAX_RECEIVE_COUNT);
    expect(outcomes).toEqual(['retried', 'retried', 'retried']);
    const [dead] = await readDlq(queues.dlq);
    expect(JSON.parse(dead?.body ?? '{}')).toMatchObject({ messageId: message.messageId });
    expect(await queueDepth(queues.main)).toBe(0);
  }, 40_000);

  test('erro inesperado do handler é tratado como transitório (não perde a mensagem)', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const real = new WagerMessageHandler(h.process, silentLogger);
    let crashes = 0;
    const crashingOnce: MessageHandler = {
      handle(body) {
        if (crashes === 0) {
          crashes += 1;
          throw new Error('unexpected bug');
        }
        return real.handle(body);
      },
    };
    const { outcomes } = startConsumer(queues, { handler: crashingOnce });

    await send(queues, wagerMessage(walletId), walletId);
    await until(() => outcomes.includes('acked'));

    expect(outcomes).toEqual(['retried', 'acked']);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '75.00', debits: 1 });
  });
});

describe('desligamento (SIGTERM)', () => {
  test('conclui a mensagem em andamento e devolve à fila as que não começaram', async () => {
    const queues = await newQueues();
    const walletId = await newWallet(h, '100.00');
    const real = new WagerMessageHandler(h.process, silentLogger);
    const { promise: firstStarted, resolve: markStarted } = Promise.withResolvers<void>();
    const { promise: mayFinish, resolve: letFinish } = Promise.withResolvers<void>();
    let handledByA = 0;
    const slow: MessageHandler = {
      async handle(body) {
        handledByA += 1;
        markStarted();
        await mayFinish; // mensagem "em andamento" quando o SIGTERM chega
        return real.handle(body);
      },
    };

    // duas mensagens da mesma wallet, já na fila quando o consumidor A sobe
    await send(queues, wagerMessage(walletId, { money: brlProps('10.00') }), walletId);
    await send(queues, wagerMessage(walletId, { money: brlProps('20.00') }), walletId);
    const a = startConsumer(queues, { handler: slow });
    await firstStarted;

    const stopped = a.consumer.stop();
    let stopResolved = false;
    void stopped.then(() => (stopResolved = true));
    await Bun.sleep(200);
    expect(stopResolved).toBe(false); // espera o trabalho em andamento

    letFinish();
    await stopped;
    expect(handledByA).toBe(1);
    expect(a.outcomes).toEqual(['acked']);
    expect(await snapshot(h, walletId)).toMatchObject({ balance: '90.00', debits: 1 });

    // a segunda foi devolvida com visibilidade 0: outra instância pega na hora
    const b = startConsumer(queues);
    const startedAt = Date.now();
    await until(() => b.outcomes.length === 1);
    expect(Date.now() - startedAt).toBeLessThan(VISIBILITY_SECONDS * 1000);
    expect(await expectLedgerConsistent(h, walletId)).toMatchObject({ balance: '70.00', debits: 2 });
    expect(await queueDepth(queues.main)).toBe(0);
  });

  test('stop() com a fila vazia interrompe o long polling sem esperar o tempo todo', async () => {
    const queues = await newQueues();
    const consumer = new SqsConsumer(
      sqs,
      {
        queueName: queues.main.name,
        dlqName: queues.dlq.name,
        waitTimeSeconds: 10,
        maxMessages: 10,
        retryBaseSeconds: 1,
        retryMaxSeconds: 2,
      },
      new WagerMessageHandler(h.process, silentLogger),
      silentLogger,
      noopMetrics,
    );
    consumer.start();
    await Bun.sleep(300);
    const startedAt = Date.now();
    await consumer.stop();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

