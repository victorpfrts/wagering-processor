import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ProcessWagerTransaction,
  type WagerTransactionResult,
} from '../../application/process-wager-transaction.ts';
import { WageringQueries } from '../../application/queries.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction.ts';
import { presentTransaction } from './presenters.ts';
import {
  idempotencyKeySchema,
  identifierParamSchema,
  parseOrThrow,
  submitTransactionSchema,
  uuidParamSchema,
} from './schemas.ts';

/** O desfecho da transação decide o status: o provedor não precisa ler mensagem. */
export function statusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      // Terminal: a operação não foi aplicada e reenviar com esta chave não muda isso.
      return HttpStatus.INTERNAL_SERVER_ERROR;
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

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') rawId: string) {
    const transactionId = parseOrThrow(uuidParamSchema, rawId, 'transactionId');
    return presentTransaction(await this.queries.getTransaction(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') rawProviderId: string,
    @Param('externalTransactionId') rawExternalId: string,
  ) {
    const providerId = parseOrThrow(identifierParamSchema, rawProviderId, 'providerId');
    const externalId = parseOrThrow(identifierParamSchema, rawExternalId, 'externalTransactionId');
    return presentTransaction(await this.queries.getTransactionByExternalId(providerId, externalId));
  }

  @Post('wagering/transactions')
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
    // preenchido pelo middleware requestContext; o fallback cobre uso direto do controller
    const correlationId = correlationIdHeader ?? Bun.randomUUIDv7();

    const result = await this.processWagerTransaction.execute({
      ...body,
      idempotencyKey,
      correlationId,
    });

    response.status(statusFor(result));
    return presentResult(result);
  }
}
