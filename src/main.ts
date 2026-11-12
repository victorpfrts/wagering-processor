import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { config } from './config.ts';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(config.port);
