import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports.ts';
import type { OutboxMessage } from '../../domain/outbox-message.ts';

/** Limite do SendMessageBatch. */
const SQS_BATCH_LIMIT = 10;

/**
 * Publica na fila FIFO de eventos.
 *
 *   MessageGroupId         = partitionKey (walletId) → ordem por wallet
 *   MessageDeduplicationId = eventId → o SQS descarta reenvios por 5 minutos
 *
 * As duas propriedades são otimização: quem garante "sem perda" é a outbox,
 * e quem garante "sem efeito duplicado" é o consumidor, pelo eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    const failed = new Set<string>();
    if (messages.length === 0) return failed;
    const queueUrl = await this.resolveQueueUrl();

    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((message, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.partitionKey,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }));
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }),
        );
        for (const failure of response.Failed ?? []) {
          const message = chunk[Number(failure.Id)];
          if (message !== undefined) failed.add(message.id);
        }
      } catch {
        // Falha da chamada inteira: o lote todo volta para nova tentativa.
        for (const message of chunk) failed.add(message.id);
      }
    }
    return failed;
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then((response) => {
        if (response.QueueUrl === undefined) throw new Error(`Queue ${this.queueName} not found`);
        return response.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined; // não guarda a falha: tenta de novo na próxima
        throw error;
      });
    return this.queueUrl;
  }
}
