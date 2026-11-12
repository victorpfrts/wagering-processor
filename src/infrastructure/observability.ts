import type { AppLogger, LogFields, WageringMetrics } from '../application/ports.ts';

/** Log estruturado mínimo (JSON por linha). Substituído por pino na fase de observabilidade. */
export class JsonConsoleLogger implements AppLogger {
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: string, msg: string, fields: LogFields = {}): void {
    console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }));
  }
}

export class NoopMetrics implements WageringMetrics {
  reconciliationDivergence(): void {}
}
