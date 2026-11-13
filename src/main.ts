import { createApp } from './bootstrap.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port);

/**
 * Desligamento limpo. Em SIGTERM/SIGINT:
 *   1. o servidor HTTP para de aceitar conexões e termina as em andamento;
 *   2. os workers terminam o que estão fazendo; o consumidor devolve à fila
 *      o que recebeu e não começou;
 *   3. as conexões com o banco são fechadas e o processo sai com código 0.
 * Se algo travar além do prazo, sai com código 1 — nada fica inconsistente,
 * porque todo efeito é transacional e toda entrada é idempotente.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'shutdown deadline exceeded', signal }));
    process.exit(1);
  }, config.shutdownTimeoutMs);
  try {
    await app.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'shutdown failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
