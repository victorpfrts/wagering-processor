import { Body, Controller, Headers, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ProcessWagerTransaction,
  type WagerTransactionResult,
} from '../../application/process-wager-transaction.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction.ts';
import { idempotencyKeySchema, parseOrThrow, submitTransactionSchema } from './schemas.ts';

/** O desfecho da transação decide o status: o provedor não precisa ler mensagem. */
export function statusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      // PENDING_REFERENCE: aceita, ainda não aplicada.
      return HttpStatus.ACCEPTED;
  }
}

export function presentResult(result: WagerTransactionResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.balance !== undefined ? { balance: result.balance } : {}),
    ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Headers('x-correlation-id') correlationIdHeader: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = parseOrThrow(
      idempotencyKeySchema,
      idempotencyKeyHeader,
      'Idempotency-Key header',
    );
    const body = parseOrThrow(submitTransactionSchema, rawBody, 'request body');
    const correlationId = correlationIdHeader ?? Bun.randomUUIDv7();

    const result = await this.processWagerTransaction.execute({
      ...body,
      idempotencyKey,
      correlationId,
    });

    response.setHeader('X-Correlation-Id', correlationId);
    response.status(statusFor(result));
    return presentResult(result);
  }
}
