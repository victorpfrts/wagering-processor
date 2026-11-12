import { z } from 'zod';
import { ValidationError } from '../../domain/errors.ts';

const identifier = z.string().min(1).max(200);

/** Formato e tipo aqui; regras de valor (escala, sinal, moeda) ficam no Money. */
const moneySchema = z.strictObject({
  amount: z.string(),
  currency: z.string(),
});

export const submitTransactionSchema = z.strictObject({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: identifier,
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  // OPENING fica de fora: é interno e não pode ser submetido.
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});

export type SubmitTransactionBody = z.infer<typeof submitTransactionSchema>;

export const openWalletSchema = z.strictObject({
  playerId: identifier,
  initialBalance: moneySchema,
});

export const uuidParamSchema = z.uuid();
export const identifierParamSchema = identifier;

export const ledgerQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  // query string chega como texto: só dígitos, convertido depois
  limit: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform((value) => Number.parseInt(value, 10))
    .optional(),
});

export const idempotencyKeySchema = z.string().min(1).max(255);

/** Valida e devolve o valor tipado; falha vira ValidationError com os campos. */
export function parseOrThrow<T>(schema: z.ZodType<T, unknown>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || what,
      message: issue.message,
    }));
    throw new RequestValidationError(`Invalid ${what}`, details);
  }
  return result.data;
}

export class RequestValidationError extends ValidationError {
  constructor(
    message: string,
    public readonly details: { field: string; message: string }[],
  ) {
    super(message);
  }
}
