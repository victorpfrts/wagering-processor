import type { AppLogger } from '../../application/ports.ts';

export interface PollingWorkerOptions {
  name: string;
  /** Espera entre execuções quando não havia trabalho. */
  idleDelayMs: number;
  /** Espera depois de um erro inesperado. */
  errorDelayMs: number;
  /** Executa uma rodada e devolve quantos itens tratou. */
  task: () => Promise<number>;
  logger: AppLogger;
}

/**
 * Laço de trabalho em segundo plano: roda a tarefa, e só descansa quando ela
 * não encontrou nada. stop() espera a rodada em andamento terminar — é o que
 * permite desligar com SIGTERM sem largar trabalho pela metade.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: PollingWorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { name, task, idleDelayMs, errorDelayMs, logger } = this.options;
    while (this.running) {
      let delay = idleDelayMs;
      try {
        const handled = await task();
        if (handled > 0) delay = 0;
      } catch (error) {
        delay = errorDelayMs;
        logger.error('worker iteration failed', {
          worker: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  /** Dorme, mas acorda na hora se stop() for chamado. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const wake = (): void => {
        clearTimeout(timer);
        done();
      };
      this.wake = wake;
      function done(): void {
        resolve();
      }
    });
  }
}
