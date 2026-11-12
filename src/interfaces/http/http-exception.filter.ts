import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
} from '../../application/errors.ts';
import { InvalidMoneyError, ValidationError } from '../../domain/errors.ts';
import { RequestValidationError } from './schemas.ts';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Mapeamento único de erro → HTTP, igual em todos os endpoints:
 *
 *   400 payload inválido            → corrigir e reenviar
 *   404 recurso inexistente
 *   409 conflito de idempotência    → não reenviar com esta chave
 *   503 falha transitória           → reenviar a MESMA requisição (Retry-After)
 *   500 erro interno                → bug; nada foi confirmado
 *
 * Rejeição por regra de negócio (422) e aceite pendente (202) não são erros:
 * são desfechos da transação e saem do controller.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.map(exception);
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, value);
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): {
    status: number;
    body: ErrorBody;
    headers: Record<string, string>;
  } {
    if (exception instanceof RequestValidationError) {
      return reply(HttpStatus.BAD_REQUEST, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ValidationError || exception instanceof InvalidMoneyError) {
      return reply(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', exception.message);
    }
    if (exception instanceof IdempotencyConflictError) {
      return reply(HttpStatus.CONFLICT, exception.code, exception.message);
    }
    if (exception instanceof NotFoundError) {
      return reply(HttpStatus.NOT_FOUND, exception.code, exception.message);
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        ...reply(HttpStatus.SERVICE_UNAVAILABLE, exception.code, exception.message, {
          reason: exception.reason,
        }),
        headers: { 'Retry-After': '1' },
      };
    }
    if (exception instanceof HttpException) {
      // Erros do próprio framework: rota inexistente, JSON malformado, health indisponível.
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (status === HttpStatus.SERVICE_UNAVAILABLE && typeof payload === 'object') {
        return { status, body: payload as ErrorBody, headers: {} };
      }
      const code = status === HttpStatus.BAD_REQUEST ? 'VALIDATION_ERROR' : httpCode(status);
      return reply(status, code, exception.message);
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'unhandled exception',
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      }),
    );
    return reply(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Internal server error');
  }
}

function reply(status: number, code: string, message: string, details?: unknown) {
  const body: ErrorBody = { code, message, ...(details !== undefined ? { details } : {}) };
  return { status, body, headers: {} as Record<string, string> };
}

function httpCode(status: number): string {
  return HttpStatus[status] ?? 'HTTP_ERROR';
}
