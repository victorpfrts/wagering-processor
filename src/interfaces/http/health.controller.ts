import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config.ts';
import { Public } from './auth.ts';

type CheckStatus = 'up' | 'down';

@Public()
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

  /**
   * PostgreSQL e SQS alcançáveis. Cada verificação tem prazo: uma dependência
   * que não responde conta como fora do ar, em vez de pendurar a sonda (e uma
   * conexão do pool) indefinidamente.
   */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckStatus> }> {
    const [postgres, sqs] = await Promise.allSettled([
      this.withDeadline(this.orm.em.fork().execute('select 1')),
      this.withDeadline(
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.transactionsQueue })),
      ),
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

  private withDeadline<T>(check: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('readiness check timed out')),
        this.config.readinessTimeoutMs,
      );
    });
    // Se o prazo vencer primeiro, a rejeição tardia da verificação é ignorada.
    check.catch(() => {});
    return Promise.race([check, deadline]).finally(() => clearTimeout(timer));
  }
}
