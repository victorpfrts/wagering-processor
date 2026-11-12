import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports.ts';
import { PublishOutbox } from '../../application/publish-outbox.ts';
import { APP_CONFIG, type AppConfig } from '../../config.ts';
import { PollingWorker } from './polling-worker.ts';

/** Liga os workers em segundo plano ao ciclo de vida da aplicação. */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: PollingWorker[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    private readonly publishOutbox: PublishOutbox,
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
    for (const worker of this.workers) worker.start();
  }

  /** SIGTERM: cada worker termina a rodada em andamento antes de parar. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}
