import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  UNIT_OF_WORK,
  type UnitOfWork,
} from './application/ports.ts';
import { ProcessWagerTransaction } from './application/process-wager-transaction.ts';
import { APP_CONFIG, type AppConfig, loadConfig } from './config.ts';
import { MikroOrmUnitOfWork } from './infrastructure/db/mikro-orm-unit-of-work.ts';
import { buildOrmConfig } from './infrastructure/db/orm-config.ts';
import { SystemClock, UuidV7Generator } from './infrastructure/system.ts';
import { HealthController } from './interfaces/http/health.controller.ts';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter.ts';
import { WageringController } from './interfaces/http/wagering.controller.ts';

/**
 * Composition root: o único lugar que conhece ao mesmo tempo as portas da
 * aplicação e os adaptadores de infraestrutura.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRoot({
          ...buildOrmConfig(config.databaseUrl, { poolMax: config.db.poolMax }),
          registerRequestContext: false,
        }),
      ],
      controllers: [HealthController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        {
          provide: SQSClient,
          useFactory: () =>
            new SQSClient({ endpoint: config.sqs.endpoint, region: config.sqs.region }),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) =>
            new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.db.lockTimeoutMs }),
        },
        {
          provide: ProcessWagerTransaction,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new ProcessWagerTransaction(unitOfWork, clock, ids),
        },
      ],
    };
  }
}
