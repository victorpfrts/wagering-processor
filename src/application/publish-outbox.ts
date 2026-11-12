import type { OutboxMessage } from '../domain/outbox-message.ts';
import type { AppLogger, Clock, EventPublisher, UnitOfWork, WageringMetrics } from './ports.ts';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

/**
 * Publica eventos pendentes da outbox. Seguro com vários publishers ao mesmo
 * tempo e com o processo morrendo em qualquer ponto:
 *
 *   - as mensagens ficam travadas no banco enquanto são enviadas; se o
 *     processo morre, a transação é desfeita, os locks caem e outra
 *     instância assume;
 *   - published_at só é gravado depois de o broker confirmar. Morrer entre o
 *     envio e o commit reenvia a mensagem: a entrega é at-least-once e o
 *     consumidor deduplica pelo eventId.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
    private readonly batchSize: number,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    const result = await this.unitOfWork.run(async (context) => {
      const now = this.clock.now();
      const batch = await context.outbox.lockDueBatch(now, this.batchSize);
      if (batch.length === 0) return { published: 0, failed: 0 };

      const { sent, failed } = await this.publishInRounds(batch);
      for (const message of sent) message.markPublished(this.clock.now());
      for (const message of failed) message.scheduleRetry(now);
      // Mensagens nem enviadas nem falhas (atrás de uma falha da mesma
      // wallet) ficam intactas e voltam numa próxima execução.
      await context.outbox.saveAll([...sent, ...failed]);

      return { published: sent.length, failed: failed.length };
    });

    if (result.published > 0) this.metrics.outboxPublished(result.published);
    if (result.failed > 0) {
      this.metrics.outboxPublishFailed(result.failed);
      this.logger.warn('outbox publish failed; retry scheduled', { failed: result.failed });
    }
    return result;
  }

  /**
   * Envia em rodadas: cada rodada leva no máximo UMA mensagem por partição
   * (wallet), a mais antiga ainda não enviada. Se ela falha, as seguintes da
   * mesma partição não são enviadas — a ordem por wallet nunca se inverte.
   */
  private async publishInRounds(
    batch: OutboxMessage[],
  ): Promise<{ sent: OutboxMessage[]; failed: OutboxMessage[] }> {
    const pendingByPartition = new Map<string, OutboxMessage[]>();
    for (const message of batch) {
      const queue = pendingByPartition.get(message.partitionKey);
      if (queue === undefined) pendingByPartition.set(message.partitionKey, [message]);
      else queue.push(message);
    }

    const sent: OutboxMessage[] = [];
    const failed: OutboxMessage[] = [];
    while (pendingByPartition.size > 0) {
      const round: OutboxMessage[] = [];
      for (const [partition, queue] of pendingByPartition) {
        const next = queue.shift();
        if (next !== undefined) round.push(next);
        if (queue.length === 0) pendingByPartition.delete(partition);
      }

      const failedIds = await this.publishRound(round);
      for (const message of round) {
        if (failedIds.has(message.id)) {
          failed.push(message);
          pendingByPartition.delete(message.partitionKey); // segura o resto da wallet
        } else {
          sent.push(message);
        }
      }
    }
    return { sent, failed };
  }

  private async publishRound(round: OutboxMessage[]): Promise<Set<string>> {
    try {
      return await this.publisher.publish(round);
    } catch (error) {
      this.logger.error('event publisher unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set(round.map((message) => message.id));
    }
  }
}
