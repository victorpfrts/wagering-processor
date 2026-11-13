import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppLogger, LogFields } from '../../application/ports.ts';

/**
 * Chaves que nunca devem aparecer em log, mesmo que alguém as passe por
 * engano: valores financeiros, corpos de requisição/mensagem e credenciais.
 * O código já não as envia; isto é a segunda barreira.
 */
const REDACTED_PATHS = [
  'money',
  'amount',
  'balance',
  'initialBalance',
  'payload',
  'body',
  'authorization',
  '*.money',
  '*.amount',
  '*.balance',
  '*.initialBalance',
  '*.payload',
  '*.body',
  '*.authorization',
];

export function createPino(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'wagering-processor', pid: process.pid },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}

/** Logs estruturados: uma linha JSON por evento, com os campos de rastreio. */
export class PinoAppLogger implements AppLogger {
  constructor(private readonly pino: Logger) {}

  info(message: string, fields: LogFields = {}): void {
    this.pino.info(fields, message);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.pino.warn(fields, message);
  }

  error(message: string, fields: LogFields = {}): void {
    this.pino.error(fields, message);
  }
}

/** Faz os logs internos do NestJS saírem no mesmo formato JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly pino: Logger) {}

  log(message: unknown, context?: string): void {
    this.pino.info({ context }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.pino.warn({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.pino.error({ context, stack }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.pino.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.pino.trace({ context }, String(message));
  }
}
