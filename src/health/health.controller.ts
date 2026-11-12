import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../config.ts';

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'up'> }> {
    const [postgres, sqs] = await Promise.allSettled([
      this.orm.em.getConnection().execute('select 1'),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.transactionsQueue })),
    ]);
    const checks = {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (checks.postgres === 'down' || checks.sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks: checks as Record<string, 'up'> };
  }
}
