import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config.ts';

type CheckStatus = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Processo vivo: não toca em dependências. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckStatus> }> {
    const [postgres, sqs] = await Promise.allSettled([
      this.orm.em.fork().execute('select 1'),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.transactionsQueue })),
    ]);
    const checks: Record<string, CheckStatus> = {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (Object.values(checks).includes('down')) {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}
