import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from '../mikro-orm.config.ts';
import { config } from './config.ts';
import { HealthController } from './health/health.controller.ts';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController],
  providers: [
    {
      provide: SQSClient,
      useFactory: () => new SQSClient({ endpoint: config.sqs.endpoint, region: config.sqs.region }),
    },
  ],
})
export class AppModule {}
