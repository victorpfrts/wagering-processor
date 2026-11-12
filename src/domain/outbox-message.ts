import { exponentialBackoffMs, OUTBOX_RETRY_POLICY } from './backoff.ts';
import { InvalidTransactionStateError } from './errors.ts';
import type { IntegrationEvent } from './events/integration-event.ts';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    /** Igual ao eventId: é a chave de deduplicação do consumidor. */
    public readonly id: string,
    public readonly aggregateId: string,
    /** Chave de ordenação na fila (walletId): eventos da mesma wallet saem em ordem. */
    public readonly partitionKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.partitionKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError('Outbox message already published');
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError('Outbox message already published');
    }
    const delay = exponentialBackoffMs(this._attempts, OUTBOX_RETRY_POLICY);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
