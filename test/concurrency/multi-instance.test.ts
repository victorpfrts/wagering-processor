import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type Instance, startInstance } from '../support/instances.ts';
import { createSqsClient, createTestQueue, type TestQueue } from '../support/sqs.ts';
import { createTestDatabase, type TestDatabase, uuid } from '../support/test-database.ts';

/**
 * Processos reais. Cada teste sobe instâncias de verdade da aplicação
 * (`bun src/main.ts`), todas no mesmo PostgreSQL e nas mesmas filas SQS, e
 * fala com elas só por HTTP e SQS — como um provedor faria.
 */
type Json = Record<string, any>;

let db: TestDatabase;
let sqs: SQSClient;
let queues: { main: TestQueue; dlq: TestQueue; events: TestQueue };
const running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = createSqsClient();
});
afterAll(async () => {
  sqs.destroy();
  await db.drop();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.kill()));
  await Promise.all(Object.values(queues).map((queue) => queue.delete()));
});

async function newQueues(): Promise<void> {
  const dlq = await createTestQueue(sqs, 'mi-dlq');
  const arn = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.url, AttributeNames: ['QueueArn'] }),
  );
  const main = await createTestQueue(sqs, 'mi-tx', {
    VisibilityTimeout: '2',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: arn.Attributes?.['QueueArn'],
      maxReceiveCount: '5',
    }),
  });
  const events = await createTestQueue(sqs, 'mi-events');
  queues = { main, dlq, events };
}

async function start(count: number, env: Record<string, string> = {}): Promise<Instance[]> {
  const started = await Promise.all(
    Array.from({ length: count }, () =>
      startInstance({
        databaseUrl: db.url,
        transactionsQueue: queues.main.name,
        dlqQueue: queues.dlq.name,
        eventsQueue: queues.events.name,
        env,
      }),
    ),
  );
  running.push(...started);
  return started;
}

async function post(instance: Instance, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${instance.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function openWallet(instance: Instance, balance: string): Promise<Json> {
  const { status, body } = await post(instance, '/wallets', {
    playerId: `player-${uuid()}`,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  expect(status).toBe(201);
  return body;
}

function betBody(wallet: Json, amount: string, externalTransactionId = `ext-${uuid()}`) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet['playerId'],
    walletId: wallet['id'],
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

const submit = (instance: Instance, body: Json) =>
  post(instance, '/wagering/transactions', body, {
    'Idempotency-Key': `${body['providerId']}:${body['externalTransactionId']}`,
  });

async function sendToQueue(body: Json, messageId = `msg-${uuid()}`): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.main.url,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: { ...body, idempotencyKey: `${body['providerId']}:${body['externalTransactionId']}` },
      }),
      MessageGroupId: body['walletId'],
      MessageDeduplicationId: uuid(),
    }),
  );
}

async function walletState(walletId: string) {
  const [row] = await db.sql`
    select w.balance::text as balance, w.version,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
             ::numeric(19,2)::text as ledger,
           count(e.id) filter (where e.direction = 'DEBIT')::int as debits
      from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id = ${walletId} group by w.id`;
  return { ...row } as { balance: string; version: number; ledger: string; debits: number };
}

/** Invariante final: saldo == ledger, conferida também pelo endpoint de reconciliação. */
async function expectConsistent(instance: Instance, walletId: string) {
  const state = await walletState(walletId);
  expect(state.ledger).toBe(state.balance);
  const { body } = await post(instance, `/wallets/${walletId}/reconciliation`, {});
  expect(body).toMatchObject({ consistent: true, difference: { amount: '0.00' } });
  return state;
}

async function until(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(100);
  }
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

const pendingOutbox = async (): Promise<number> => {
  const [{ count }] =
    await db.sql`select count(*)::int as count from outbox_messages where published_at is null`;
  return count;
};

describe('três instâncias simultâneas', () => {
  test('a mesma aposta, 60 vezes, espalhada pelas três → um único débito', async () => {
    await newQueues();
    const instances = await start(3);
    const wallet = await openWallet(instances[0] as Instance, '100.00');
    const body = betBody(wallet, '30.00');

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => submit(instances[i % 3] as Instance, body)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => !r.body['idempotentReplay'])).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body['transactionId'])).size).toBe(1);
    expect(await expectConsistent(instances[1] as Instance, wallet['id'])).toMatchObject({
      balance: '70.00',
      debits: 1,
    });
  }, 60_000);

  test('cenário obrigatório em 25 wallets: duas apostas de 80 sobre 100, cada uma numa instância', async () => {
    await newQueues();
    const instances = await start(3);
    const wallets = await Promise.all(
      Array.from({ length: 25 }, () => openWallet(instances[0] as Instance, '100.00')),
    );

    const outcomes = await Promise.all(
      wallets.map((wallet, i) =>
        Promise.all([
          submit(instances[i % 3] as Instance, betBody(wallet, '80.00')),
          submit(instances[(i + 1) % 3] as Instance, betBody(wallet, '80.00')),
        ]),
      ),
    );

    for (const [index, pair] of outcomes.entries()) {
      expect(pair.map((r) => r.status).sort()).toEqual([200, 422]);
      const rejected = pair.find((r) => r.status === 422);
      expect(rejected?.body['failureCode']).toBe('INSUFFICIENT_FUNDS');
      expect(
        await expectConsistent(instances[2] as Instance, (wallets[index] as Json)['id']),
      ).toMatchObject({ balance: '20.00', debits: 1 });
    }
  }, 60_000);

  test('wallet quente: 150 apostas de 1.00 sobre saldo 100, pelas três instâncias → exatamente 100 passam', async () => {
    await newQueues();
    const instances = await start(3);
    const wallet = await openWallet(instances[0] as Instance, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        submit(instances[i % 3] as Instance, betBody(wallet, '1.00')),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(100);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(50);
    expect(await expectConsistent(instances[0] as Instance, wallet['id'])).toMatchObject({
      balance: '0.00',
      version: 101,
      debits: 100,
    });
  }, 60_000);

  test('fila consumida por três instâncias, com cada mensagem entregue 3 vezes → um efeito por mensagem; eventos publicados uma vez', async () => {
    await newQueues();
    const instances = await start(3);
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () => openWallet(instances[0] as Instance, '1000.00')),
    );

    // 8 wallets × 10 apostas de 5.00, cada mensagem enviada 3 vezes
    for (const wallet of wallets) {
      for (let i = 0; i < 10; i += 1) {
        const body = betBody(wallet, '5.00');
        const messageId = `msg-${uuid()}`;
        await Promise.all([sendToQueue(body, messageId), sendToQueue(body, messageId), sendToQueue(body, messageId)]);
      }
    }

    await until(async () => (await queueDepth(queues.main)) === 0);
    await until(async () => (await pendingOutbox()) === 0);

    for (const wallet of wallets) {
      expect(await expectConsistent(instances[0] as Instance, wallet['id'])).toMatchObject({
        balance: '950.00',
        debits: 10,
        version: 11,
      });
    }
    expect(await queueDepth(queues.dlq)).toBe(0);

    // três publishers: cada evento chega uma vez, e em ordem dentro da wallet
    // (o banco é compartilhado pelo arquivo: considera só as wallets deste teste)
    const ownWallets = new Set(wallets.map((wallet) => wallet['id'] as string));
    const received = (await queues.events.drain()).filter((m) => ownWallets.has(m.groupId ?? ''));
    const eventIds = received.map((m) => m.body['eventId']);
    const [{ total }] = await db.sql`
      select count(*)::int as total from outbox_messages
       where partition_key in ${db.sql(wallets.map((wallet) => wallet['id']))}`;
    expect(new Set(eventIds).size).toBe(total);
    expect(eventIds).toHaveLength(total);
    for (const wallet of wallets) {
      const versions = received
        .filter((m) => m.groupId === wallet['id'] && m.body['eventType'] === 'WalletBalanceChanged')
        .map((m) => m.body['data'].walletVersion);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
  }, 90_000);
});

describe('processo morto (kill -9)', () => {
  test('worker morre depois do commit e antes do ack → outra instância recebe de novo e não duplica', async () => {
    await newQueues();
    // A instância que vai morrer é a única consumindo no início.
    const [doomed] = await start(1, { FAULT_INJECTION: 'consumer.before-ack' });
    const wallet = await openWallet(doomed as Instance, '100.00');

    const messageId = `msg-${uuid()}`;
    await sendToQueue(betBody(wallet, '40.00'), messageId);
    const death = await (doomed as Instance).exited();
    expect(death.signal).toBe('SIGKILL');

    // O commit aconteceu; o ack não. A mensagem continua na fila.
    expect(await walletState(wallet['id'])).toMatchObject({ balance: '60.00', debits: 1 });
    expect(await queueDepth(queues.main)).toBe(1);

    const [survivor] = await start(1);
    await until(async () => (await queueDepth(queues.main)) === 0);

    expect(await expectConsistent(survivor as Instance, wallet['id'])).toMatchObject({
      balance: '60.00',
      debits: 1,
      version: 2,
    });
    const [{ transactions, inbox }] = await db.sql`
      select (select count(*)::int from wager_transactions where wallet_id = ${wallet['id']} and kind = 'BET') as transactions,
             (select count(*)::int from inbox_messages where message_id = ${messageId}) as inbox`;
    expect({ transactions, inbox }).toEqual({ transactions: 1, inbox: 1 });
    expect(await queueDepth(queues.dlq)).toBe(0);
  }, 60_000);

  test('commit confirmado, processo morre antes de publicar → outra instância publica o evento', async () => {
    await newQueues();
    // Sem publisher: garante que o evento ainda não saiu quando o processo morre.
    const [doomed] = await start(1, { OUTBOX_ENABLED: 'false' });
    const wallet = await openWallet(doomed as Instance, '100.00');
    const { status } = await submit(doomed as Instance, betBody(wallet, '25.00'));
    expect(status).toBe(200);
    expect(await pendingOutbox()).toBe(4);

    await (doomed as Instance).kill();
    expect(await queues.events.drain()).toHaveLength(0);

    await start(1);
    await until(async () => (await pendingOutbox()) === 0);

    const received = (await queues.events.drain()).filter((m) => m.groupId === wallet['id']);
    expect(received.map((m) => m.body['eventType'])).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(new Set(received.map((m) => m.body['eventId'])).size).toBe(4);
  }, 60_000);
});

describe('reinício do serviço', () => {
  test('três instâncias mortas no meio da carga; após reiniciar e reenviar, o estado final é exato', async () => {
    await newQueues();
    let instances = await start(3);
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWallet(instances[0] as Instance, '1000.00')),
    );
    // por wallet: 30 apostas de 10.00 por HTTP + 10 apostas de 5.00 pela fila
    const httpBets = wallets.flatMap((wallet) =>
      Array.from({ length: 30 }, () => betBody(wallet, '10.00')),
    );
    const queueBets = wallets.flatMap((wallet) =>
      Array.from({ length: 10 }, () => betBody(wallet, '5.00')),
    );
    await Promise.all(queueBets.map((body) => sendToQueue(body)));

    // dispara a carga e mata tudo com ela em andamento
    let answeredSoFar = 0;
    const firstPass = Promise.allSettled(
      httpBets.map((body, i) =>
        submit(instances[i % 3] as Instance, body).then((response) => {
          answeredSoFar += 1;
          return response;
        }),
      ),
    );
    // espera uma parte das respostas chegar e derruba as três de uma vez
    while (answeredSoFar < 80) await Bun.sleep(1);
    await Promise.all(instances.map((instance) => instance.kill()));
    const settled = await firstPass;
    const answered = settled.filter((s) => s.status === 'fulfilled').length;
    const interrupted = settled.length - answered;
    console.log(`restart test: ${answered} answered, ${interrupted} interrupted by kill -9`);
    running.splice(0);

    // o banco, sozinho, já está consistente logo após a queda
    for (const wallet of wallets) {
      const state = await walletState(wallet['id']);
      expect(state.ledger).toBe(state.balance);
    }

    // reinício: o provedor reenvia TUDO com as mesmas chaves
    instances = await start(3);
    const secondPass = await Promise.all(
      httpBets.map((body, i) => submit(instances[(i + 1) % 3] as Instance, body)),
    );
    expect(secondPass.every((r) => r.status === 200)).toBe(true);
    await until(async () => (await queueDepth(queues.main)) === 0, 60_000);
    await until(async () => (await pendingOutbox()) === 0, 60_000);

    // estado final exato: 1000 − 30×10 − 10×5 = 650, sem nenhuma duplicata
    for (const wallet of wallets) {
      expect(await expectConsistent(instances[0] as Instance, wallet['id'])).toMatchObject({
        balance: '650.00',
        debits: 40,
        version: 41,
      });
    }
    const [{ transactions, distinct_keys }] = await db.sql`
      select count(*)::int as transactions, count(distinct idempotency_key)::int as distinct_keys
        from wager_transactions
       where kind = 'BET' and status = 'PROCESSED'
         and wallet_id in ${db.sql(wallets.map((wallet) => wallet['id']))}`;
    expect({ transactions, distinct_keys }).toEqual({ transactions: 400, distinct_keys: 400 });
    expect(await queueDepth(queues.dlq)).toBe(0);

    // nenhum evento confirmado foi perdido
    const ownWallets = new Set(wallets.map((wallet) => wallet['id'] as string));
    const received = (await queues.events.drain()).filter((m) => ownWallets.has(m.groupId ?? ''));
    const [{ total }] = await db.sql`
      select count(*)::int as total from outbox_messages
       where partition_key in ${db.sql(wallets.map((wallet) => wallet['id']))}`;
    expect(new Set(received.map((m) => m.body['eventId'])).size).toBe(total);
    expect(total).toBe(10 * (2 + 40 * 2)); // abertura + 40 apostas, 2 eventos cada
    expect(interrupted).toBeGreaterThan(0);
  }, 180_000);

  test('SIGTERM: a instância termina sozinha, com código 0', async () => {
    await newQueues();
    const [instance] = await start(1);
    const wallet = await openWallet(instance as Instance, '100.00');
    await submit(instance as Instance, betBody(wallet, '10.00'));
    const startedAt = Date.now();
    const exitCode = await (instance as Instance).stop();
    running.splice(0);
    expect(exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 60_000);
});
