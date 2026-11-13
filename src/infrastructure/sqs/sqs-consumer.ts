import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppLogger, WageringMetrics } from '../../application/ports.ts';
import { crashIfInjected } from '../fault-injection.ts';
import type { MessageHandler } from '../../interfaces/sqs/wager-message-handler.ts';

export interface SqsConsumerOptions {
  queueName: string;
  dlqName: string;
  /** Long polling. Curto o bastante para o desligamento não esperar muito. */
  waitTimeSeconds: number;
  maxMessages: number;
  /** Backoff do retry: base * 2^(recebimentos-1), limitado por max. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

/**
 * Consumidor SQS.
 *
 *   - ack (DeleteMessage) só depois de o handler devolver 'ack', isto é,
 *     depois do commit no banco;
 *   - retry: a mensagem volta à fila com visibilidade crescente; ao atingir o
 *     maxReceiveCount da fila, o próprio SQS a move para a DLQ (redrive);
 *   - dead-letter: vai direto para a DLQ, sem gastar tentativas;
 *   - stop(): para de buscar, termina o que está em andamento e devolve à
 *     fila (visibilidade 0) o que foi recebido e ainda não começou.
 */
export class SqsConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private receiveAbort: AbortController | undefined;
  private queueUrl = '';
  private dlqUrl = '';

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SqsConsumerOptions,
    private readonly handler: MessageHandler,
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.receiveAbort?.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (this.queueUrl === '') await this.resolveQueues();
        const messages = await this.receive();
        // Grupos (wallets) diferentes em paralelo; dentro do grupo, na ordem.
        await Promise.all(this.groupByMessageGroup(messages).map((group) => this.processGroup(group)));
      } catch (error) {
        if (!this.running) break;
        this.logger.error('sqs consumer iteration failed', {
          queue: this.options.queueName,
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(1000);
      }
    }
  }

  private async receive(): Promise<Message[]> {
    this.receiveAbort = new AbortController();
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.receiveAbort.signal },
      );
      return response.Messages ?? [];
    } catch (error) {
      if (!this.running) return []; // long poll interrompido pelo stop()
      throw error;
    }
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (const message of messages) {
      if (!this.running) {
        // Desligando: não começa trabalho novo; devolve para outra instância.
        await this.changeVisibility(message, 0);
        continue;
      }
      await this.processMessage(message);
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
    let decision;
    try {
      decision = await this.handler.handle(message.Body ?? '');
    } catch (error) {
      decision = { action: 'retry' as const, reason: 'HANDLER_CRASHED' };
      this.logger.error('message handler crashed', {
        sqsMessageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      switch (decision.action) {
        case 'ack':
          // O efeito já está confirmado no banco neste ponto.
          crashIfInjected('consumer.before-ack');
          await this.delete(message);
          this.metrics.messageHandled('acked');
          break;
        case 'retry': {
          const delay = Math.min(
            this.options.retryMaxSeconds,
            this.options.retryBaseSeconds * 2 ** Math.min(receiveCount - 1, 20),
          );
          await this.changeVisibility(message, delay);
          this.metrics.messageHandled('retried');
          break;
        }
        case 'dead-letter':
          await this.sendToDlq(message, decision.reason);
          await this.delete(message);
          this.metrics.messageHandled('dead_lettered');
          break;
      }
    } catch (error) {
      // Falhou ao avisar o broker. Nada a desfazer: a mensagem reaparece
      // quando a visibilidade expirar e o inbox/idempotência absorvem.
      this.logger.warn('failed to settle message with broker', {
        sqsMessageId: message.MessageId,
        action: decision.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn('failed to change message visibility', {
        sqsMessageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
        },
      }),
    );
  }

  private groupByMessageGroup(messages: Message[]): Message[][] {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.['MessageGroupId'] ?? message.MessageId ?? '';
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [message]);
      else group.push(message);
    }
    return [...groups.values()];
  }

  private async resolveQueues(): Promise<void> {
    const urlOf = async (name: string): Promise<string> => {
      const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (response.QueueUrl === undefined) throw new Error(`Queue ${name} not found`);
      return response.QueueUrl;
    };
    this.dlqUrl = await urlOf(this.options.dlqName);
    this.queueUrl = await urlOf(this.options.queueName);
  }
}
