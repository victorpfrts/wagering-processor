import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await NestFactory.create(AppModule.register(config));
app.enableShutdownHooks();
await app.listen(config.port);
