import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  APP_LOGGER,
  type AppLogger,
  METRICS,
  type WageringMetrics,
} from '../../application/ports.ts';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction.ts';
import { PublishOutbox } from '../../application/publish-outbox.ts';
import { APP_CONFIG, type AppConfig } from '../../config.ts';
import { WagerMessageHandler } from '../../interfaces/sqs/wager-message-handler.ts';
import { SqsConsumer } from '../sqs/sqs-consumer.ts';
import { PollingWorker } from './polling-worker.ts';

/** Liga os workers em segundo plano ao ciclo de vida da aplicação. */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: { start(): void; stop(): Promise<void> }[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: WageringMetrics,
    private readonly sqs: SQSClient,
    private readonly publishOutbox: PublishOutbox,
    private readonly processWagerTransaction: ProcessWagerTransaction,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.outbox.enabled) {
      this.workers.push(
        new PollingWorker({
          name: 'outbox-publisher',
          idleDelayMs: this.config.outbox.pollIntervalMs,
          errorDelayMs: this.config.outbox.pollIntervalMs * 4,
          logger: this.logger,
          task: async () => {
            const { published, failed } = await this.publishOutbox.execute();
            // Com falha, descansa: o backoff das mensagens cuida do resto.
            return failed > 0 ? 0 : published;
          },
        }),
      );
    }
    if (this.config.consumer.enabled) {
      this.workers.push(
        new SqsConsumer(
          this.sqs,
          {
            queueName: this.config.sqs.transactionsQueue,
            dlqName: this.config.sqs.dlqQueue,
            waitTimeSeconds: this.config.consumer.waitTimeSeconds,
            maxMessages: this.config.consumer.maxMessages,
            retryBaseSeconds: this.config.consumer.retryBaseSeconds,
            retryMaxSeconds: this.config.consumer.retryMaxSeconds,
          },
          new WagerMessageHandler(this.processWagerTransaction, this.logger),
          this.logger,
          this.metrics,
        ),
      );
    }
    for (const worker of this.workers) worker.start();
  }

  /**
   * SIGTERM: cada worker termina o que está em andamento antes de parar; o
   * consumidor devolve à fila o que recebeu e não começou.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}
