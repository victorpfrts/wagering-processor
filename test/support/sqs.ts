import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const SQS_ENDPOINT = process.env['SQS_ENDPOINT'] ?? 'http://localhost:4566';

export function createSqsClient(endpoint = SQS_ENDPOINT): SQSClient {
  return new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
}

export interface ReceivedMessage {
  body: Record<string, any>;
  groupId: string | undefined;
  receiveCount: number;
}

export interface TestQueue {
  name: string;
  url: string;
  /** Lê e apaga tudo que estiver na fila, na ordem de entrega. */
  drain(): Promise<ReceivedMessage[]>;
  delete(): Promise<void>;
}

/** Fila FIFO real no LocalStack, exclusiva do teste. */
export async function createTestQueue(
  sqs: SQSClient,
  prefix: string,
  attributes: Record<string, string> = {},
): Promise<TestQueue> {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '30', ...attributes },
    }),
  );
  const url = created.QueueUrl as string;

  return {
    name,
    url,
    async drain() {
      const received: ReceivedMessage[] = [];
      for (let emptyReads = 0; emptyReads < 2; ) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            AttributeNames: ['All'],
          }),
        );
        const messages = response.Messages ?? [];
        if (messages.length === 0) {
          emptyReads += 1;
          continue;
        }
        emptyReads = 0;
        for (const message of messages) {
          received.push({
            body: JSON.parse(message.Body ?? '{}') as Record<string, any>,
            groupId: message.Attributes?.['MessageGroupId'],
            receiveCount: Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1'),
          });
        }
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: url,
            Entries: messages.map((message, index) => ({
              Id: String(index),
              ReceiptHandle: message.ReceiptHandle as string,
            })),
          }),
        );
      }
      return received;
    },
    async delete() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    },
  };
}
