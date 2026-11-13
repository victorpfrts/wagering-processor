import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.ts';
import { type AppConfig, loadConfig } from '../../src/config.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

export interface HttpApp {
  db: TestDatabase;
  app: INestApplication;
  baseUrl: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
  close(): Promise<void>;
}

/** Sobe a aplicação Nest completa numa porta livre, contra um banco de teste real. */
export async function startHttpApp(overrides: Partial<AppConfig['db']> = {}): Promise<HttpApp> {
  const db = await createTestDatabase();
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    databaseUrl: db.url,
    db: { ...base.db, ...overrides },
    outbox: { ...base.outbox, enabled: false },
    consumer: { ...base.consumer, enabled: false },
    pendingReference: { ...base.pendingReference, enabled: false },
  };
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  return {
    db,
    app,
    baseUrl,
    post: (path, body, headers = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    get: (path) => fetch(`${baseUrl}${path}`),
    async close() {
      await app.close();
      await db.drop();
    },
  };
}
