import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { OpenWallet } from './application/open-wallet.ts';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  EVENT_PUBLISHER,
  type EventPublisher,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  READ_MODEL,
  UNIT_OF_WORK,
  type UnitOfWork,
  type WageringMetrics,
  type WageringReadModel,
} from './application/ports.ts';
import { ProcessWagerTransaction } from './application/process-wager-transaction.ts';
import { PublishOutbox } from './application/publish-outbox.ts';
import { WageringQueries } from './application/queries.ts';
import { RetryPendingReferences } from './application/retry-pending-references.ts';
import { APP_CONFIG, type AppConfig, loadConfig } from './config.ts';
import { MikroOrmReadModel } from './infrastructure/db/mikro-orm-read-model.ts';
import { MikroOrmUnitOfWork } from './infrastructure/db/mikro-orm-unit-of-work.ts';
import { buildOrmConfig } from './infrastructure/db/orm-config.ts';
import { JsonConsoleLogger, NoopMetrics } from './infrastructure/observability.ts';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher.ts';
import { SystemClock, UuidV7Generator } from './infrastructure/system.ts';
import { WorkersService } from './infrastructure/workers/workers.service.ts';
import {
  AnonymousProviderIdentity,
  PROVIDER_IDENTITY,
  ProviderAuthGuard,
} from './interfaces/http/auth.ts';
import { HealthController } from './interfaces/http/health.controller.ts';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter.ts';
import { WageringController } from './interfaces/http/wagering.controller.ts';
import { WalletsController } from './interfaces/http/wallets.controller.ts';

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
      controllers: [HealthController, WageringController, WalletsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        // Autenticação: guard global + porta no-op (ver interfaces/http/auth.ts).
        { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_LOGGER, useClass: JsonConsoleLogger },
        { provide: METRICS, useClass: NoopMetrics },
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
          provide: EVENT_PUBLISHER,
          inject: [SQSClient],
          useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, config.sqs.eventsQueue),
        },
        {
          provide: PublishOutbox,
          inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_LOGGER, METRICS],
          useFactory: (
            unitOfWork: UnitOfWork,
            publisher: EventPublisher,
            clock: Clock,
            logger: AppLogger,
            metrics: WageringMetrics,
          ) =>
            new PublishOutbox(
              unitOfWork,
              publisher,
              clock,
              logger,
              metrics,
              config.outbox.batchSize,
            ),
        },
        {
          provide: RetryPendingReferences,
          inject: [READ_MODEL, UNIT_OF_WORK, ProcessWagerTransaction, CLOCK, APP_LOGGER, METRICS],
          useFactory: (
            readModel: WageringReadModel,
            unitOfWork: UnitOfWork,
            processor: ProcessWagerTransaction,
            clock: Clock,
            logger: AppLogger,
            metrics: WageringMetrics,
          ) =>
            new RetryPendingReferences(
              readModel,
              unitOfWork,
              processor,
              clock,
              logger,
              metrics,
              config.pendingReference.batchSize,
            ),
        },
        WorkersService,
        {
          provide: READ_MODEL,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmReadModel(orm),
        },
        {
          provide: OpenWallet,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new OpenWallet(unitOfWork, clock, ids),
        },
        {
          provide: WageringQueries,
          inject: [READ_MODEL, APP_LOGGER, METRICS],
          useFactory: (readModel: WageringReadModel, logger: AppLogger, metrics: WageringMetrics) =>
            new WageringQueries(readModel, logger, metrics),
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
