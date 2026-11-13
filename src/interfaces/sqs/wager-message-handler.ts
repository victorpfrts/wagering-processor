import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  TransientInfrastructureError,
} from '../../application/errors.ts';
import type { AppLogger } from '../../application/ports.ts';
import type { ProcessWagerTransaction } from '../../application/process-wager-transaction.ts';
import { InvalidMoneyError, ValidationError } from '../../domain/errors.ts';
import { canonicalJson } from '../../domain/payload-hash.ts';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

const identifier = z.string().min(1).max(200);

/** Contrato da mensagem (seção 10 do desafio). */
export const wagerMessageSchema = z.strictObject({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
    providerId: identifier,
    externalTransactionId: identifier,
    idempotencyKey: z.string().min(1).max(255),
    playerId: identifier,
    walletId: z.uuid(),
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: z.strictObject({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: identifier.optional(),
  }),
});

/**
 * O que fazer com a mensagem depois de tratá-la:
 *
 *   ack          efeito confirmado no banco (ou erro de negócio já registrado)
 *   retry        falha transitória: devolver à fila com backoff
 *   dead-letter  falha permanente: repetir não muda o resultado
 */
export type HandlingDecision =
  | { action: 'ack'; detail: string }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string };

export interface MessageHandler {
  handle(body: string): Promise<HandlingDecision>;
}

/**
 * Adaptador de entrada da fila: traduz a mensagem para o MESMO use case do
 * HTTP e classifica o desfecho. Não conhece o SQS — recebe o corpo e devolve
 * uma decisão.
 */
export class WagerMessageHandler implements MessageHandler {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly logger: AppLogger,
  ) {}

  async handle(body: string): Promise<HandlingDecision> {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { action: 'dead-letter', reason: 'MALFORMED_JSON' };
    }
    const parsed = wagerMessageSchema.safeParse(json);
    if (!parsed.success) {
      return { action: 'dead-letter', reason: 'INVALID_MESSAGE_SCHEMA' };
    }
    const { messageId, type, data } = parsed.data;
    const trace = {
      messageId,
      correlationId: messageId,
      providerId: data.providerId,
      walletId: data.walletId,
    };

    try {
      const result = await this.processWagerTransaction.execute({
        ...data,
        correlationId: messageId,
        causationId: messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId,
          // Conteúdo de negócio da mensagem; occurredAt é metadado de transporte.
          payloadHash: createHash('sha256').update(canonicalJson({ type, data })).digest('hex'),
        },
      });
      // REJECTED e PENDING_REFERENCE também são desfechos confirmados: ack.
      // (O log do desfecho é feito pelo próprio use case.)
      return { action: 'ack', detail: result.status };
    } catch (error) {
      const decision = classifyFailure(error);
      this.logger[decision.action === 'retry' ? 'warn' : 'error']('wager message failed', {
        ...trace,
        action: decision.action,
        reason: decision.reason,
      });
      return decision;
    }
  }
}

/**
 * Permanente: o conteúdo está errado e nunca vai passar.
 * Transitório: infraestrutura, ou erro desconhecido — na dúvida tenta de
 * novo; o limite de recebimentos da fila leva à DLQ se persistir.
 */
export function classifyFailure(error: unknown): Exclude<HandlingDecision, { action: 'ack' }> {
  if (error instanceof ValidationError || error instanceof InvalidMoneyError) {
    return { action: 'dead-letter', reason: 'VALIDATION_ERROR' };
  }
  if (error instanceof IdempotencyConflictError || error instanceof InboxPayloadMismatchError) {
    return { action: 'dead-letter', reason: error.code };
  }
  if (error instanceof TransientInfrastructureError) {
    return { action: 'retry', reason: error.reason };
  }
  return { action: 'retry', reason: 'UNEXPECTED_ERROR' };
}
