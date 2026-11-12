export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  /** Chave de ordenação na fila; aqui sempre o walletId. */
  partitionKey: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** Dados de contexto que a aplicação fornece ao criar um evento. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly partitionKey: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.partitionKey = props.partitionKey;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
