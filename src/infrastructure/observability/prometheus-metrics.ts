import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { OutboxLag, WageringMetrics } from '../../application/ports.ts';

/** Medidas lidas na hora da coleta (scrape). Falha de leitura não derruba o /metrics. */
export interface MetricProbes {
  outboxLag(): Promise<OutboxLag>;
  dlqDepth(): Promise<number>;
}

const PROBE_TIMEOUT_MS = 2_000;

async function probe<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS)),
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Métricas no formato Prometheus, num registro próprio (sem estado global).
 *
 *   transações por status   wagering_transactions_total
 *   duplicatas detectadas   wagering_duplicates_total
 *   retries                 wagering_messages_total{outcome="retried"},
 *                           wagering_pending_reference_retries_total,
 *                           wagering_outbox_publish_total{result="failed"}
 *   mensagens em DLQ        wagering_messages_total{outcome="dead_lettered"}, wagering_dlq_messages
 *   conflitos de lock       wagering_concurrency_conflicts_total
 *   outbox lag              wagering_outbox_lag_seconds, wagering_outbox_pending_messages
 *   latência                wagering_processing_duration_seconds, wagering_http_request_duration_seconds
 */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions that reached an outcome, by kind, status and failure code',
    labelNames: ['kind', 'status', 'failure_code', 'source'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicates detected: idempotent replays, idempotency conflicts and message redeliveries',
    labelNames: ['type'],
    registers: [this.registry],
  });

  private readonly conflicts = new Counter({
    name: 'wagering_concurrency_conflicts_total',
    help: 'Concurrency conflicts: lock timeouts, deadlocks and unique-index races',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Time to process a wager transaction, from receipt to commit or failure',
    labelNames: ['source', 'outcome'],
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly http = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP request duration by method, route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly messages = new Counter({
    name: 'wagering_messages_total',
    help: 'Queue messages by outcome: acked, retried or dead_lettered',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  private readonly outboxPublish = new Counter({
    name: 'wagering_outbox_publish_total',
    help: 'Outbox messages by publish result',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly pendingReference = new Counter({
    name: 'wagering_pending_reference_retries_total',
    help: 'Retries of transactions waiting for their reference, by resulting status',
    labelNames: ['status'],
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance differs from the ledger',
    registers: [this.registry],
  });

  constructor(probes: MetricProbes) {
    collectDefaultMetrics({ register: this.registry });

    const pending = new Gauge({
      name: 'wagering_outbox_pending_messages',
      help: 'Outbox messages not yet published',
      registers: [this.registry],
    });
    new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox message',
      registers: [this.registry],
      // Uma leitura por coleta alimenta os dois gauges da outbox.
      async collect() {
        const lag = await probe(() => probes.outboxLag());
        if (lag === undefined) return;
        this.set(lag.oldestPendingSeconds);
        pending.set(lag.pendingMessages);
      },
    });
    new Gauge({
      name: 'wagering_dlq_messages',
      help: 'Messages currently sitting in the dead-letter queue',
      registers: [this.registry],
      async collect() {
        const depth = await probe(() => probes.dlqDepth());
        if (depth !== undefined) this.set(depth);
      },
    });
  }

  transactionResolved(labels: Parameters<WageringMetrics['transactionResolved']>[0]): void {
    this.transactions.inc({
      kind: labels.kind,
      status: labels.status,
      failure_code: labels.failureCode ?? '',
      source: labels.source,
    });
  }

  duplicateDetected(type: string): void {
    this.duplicates.inc({ type });
  }

  concurrencyConflict(reason: string): void {
    this.conflicts.inc({ reason });
  }

  processingObserved(source: string, outcome: string, seconds: number): void {
    this.processing.observe({ source, outcome }, seconds);
  }

  httpRequestObserved(method: string, route: string, status: number, seconds: number): void {
    this.http.observe({ method, route, status: String(status) }, seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  outboxPublished(count: number): void {
    this.outboxPublish.inc({ result: 'published' }, count);
  }

  outboxPublishFailed(count: number): void {
    this.outboxPublish.inc({ result: 'failed' }, count);
  }

  messageHandled(outcome: string): void {
    this.messages.inc({ outcome });
  }

  pendingReferenceRetried(status: string): void {
    this.pendingReference.inc({ status });
  }
}
