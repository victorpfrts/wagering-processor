import {
  DuplicateKeyError,
  TransientInfrastructureError,
  type TransientReason,
} from '../../application/errors.ts';

/** SQLSTATE → motivo. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const TRANSIENT_SQLSTATES: Record<string, TransientReason> = {
  '55P03': 'LOCK_TIMEOUT', // lock_not_available (lock_timeout estourou)
  '40P01': 'DEADLOCK', // deadlock_detected
  '40001': 'DEADLOCK', // serialization_failure
  '57014': 'UNAVAILABLE', // query_canceled (statement_timeout)
  '57P01': 'UNAVAILABLE', // admin_shutdown
  '57P02': 'UNAVAILABLE', // crash_shutdown
  '57P03': 'UNAVAILABLE', // cannot_connect_now
  '53300': 'UNAVAILABLE', // too_many_connections
};

const NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface DatabaseErrorShape {
  code?: unknown;
  constraint?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

/**
 * Traduz um erro do driver para o vocabulário da aplicação. Erros que não são
 * de concorrência nem de disponibilidade passam intactos (são bugs ou
 * violações de invariante e devem aparecer como erro interno).
 */
export function translateDatabaseError(error: unknown): unknown {
  for (let current = error, depth = 0; current != null && depth < 5; depth += 1) {
    const shape = current as DatabaseErrorShape;
    const code = typeof shape.code === 'string' ? shape.code : undefined;

    if (code === '23505') {
      const constraint = typeof shape.constraint === 'string' ? shape.constraint : undefined;
      return new DuplicateKeyError(constraint, { cause: error });
    }
    if (code !== undefined) {
      const reason = TRANSIENT_SQLSTATES[code];
      if (reason !== undefined) return new TransientInfrastructureError(reason, { cause: error });
      // classe 08 = connection exception
      if (code.startsWith('08') || NETWORK_ERRORS.has(code)) {
        return new TransientInfrastructureError('UNAVAILABLE', { cause: error });
      }
    }
    if (shape.name === 'ConnectionException') {
      return new TransientInfrastructureError('UNAVAILABLE', { cause: error });
    }
    current = shape.cause;
  }
  return error;
}
