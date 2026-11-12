/** Erros da camada de aplicação: descrevem o desfecho, não o protocolo (HTTP/SQS). */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Mesma idempotency key (ou mesmo id externo) com payload diferente. Não é replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

export type TransientReason = 'LOCK_TIMEOUT' | 'DEADLOCK' | 'UNAVAILABLE';

/**
 * Falha temporária de infraestrutura (lock disputado, banco fora do ar).
 * Nada foi confirmado: o chamador pode repetir a mesma requisição.
 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    public readonly reason: TransientReason,
    options?: { cause?: unknown },
  ) {
    super(`Transient infrastructure failure: ${reason}`, options);
  }
}

/**
 * Um índice único barrou a escrita: outra transação gravou a mesma chave
 * primeiro. Interno à aplicação — o use case reexecuta e encontra o registro.
 */
export class DuplicateKeyError extends ApplicationError {
  readonly code = 'DUPLICATE_KEY';

  constructor(
    public readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Duplicate key (${constraint ?? 'unknown constraint'})`, options);
  }
}
