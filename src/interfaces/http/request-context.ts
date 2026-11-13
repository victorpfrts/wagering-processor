import type { NextFunction, Request, Response } from 'express';
import type { AppLogger } from '../../application/ports.ts';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.ts';

const CORRELATION_HEADER = 'x-correlation-id';
const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Para toda requisição HTTP:
 *   - garante um correlationId (aceita o do chamador ou gera um) e o devolve
 *     no header de resposta;
 *   - ao terminar, registra um log de acesso e a latência por rota.
 *
 * O log tem método, rota, status e duração. Nunca o corpo.
 */
export function requestContext(logger: AppLogger, metrics: PrometheusMetrics) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : Bun.randomUUIDv7();
    request.headers[CORRELATION_HEADER] = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);

    const startedAt = performance.now();
    response.on('finish', () => {
      const seconds = (performance.now() - startedAt) / 1000;
      // Padrão da rota ("/wallets/:walletId"), não o caminho real: mantém
      // poucas séries de métrica e nenhum id nos rótulos.
      const routePath: unknown = (request.route as { path?: unknown } | undefined)?.path;
      const route = typeof routePath === 'string' ? routePath : 'unmatched';
      metrics.httpRequestObserved(request.method, route, response.statusCode, seconds);
      if (QUIET_PATHS.has(request.path)) return;
      logger.info('http request', {
        correlationId,
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(seconds * 1000),
      });
    });
    next();
  };
}
