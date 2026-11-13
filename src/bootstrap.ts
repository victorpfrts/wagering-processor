import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { APP_LOGGER, type AppLogger, METRICS } from './application/ports.ts';
import type { AppConfig } from './config.ts';
import { createPino, PinoNestLogger } from './infrastructure/observability/pino-logger.ts';
import type { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics.ts';
import { requestContext } from './interfaces/http/request-context.ts';

/** Monta a aplicação exatamente como em produção; usado pelo main e pelos testes. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), {
    logger: new PinoNestLogger(createPino(config.logLevel)),
  });
  app.use(requestContext(app.get<AppLogger>(APP_LOGGER), app.get<PrometheusMetrics>(METRICS)));
  // SIGTERM/SIGINT → onApplicationShutdown: workers terminam o que está em
  // andamento e as conexões são fechadas.
  app.enableShutdownHooks();
  return app;
}
