import { exponentialBackoffMs, REFERENCE_RETRY_POLICY } from './backoff.ts';
import { InvalidTransactionStateError, ValidationError } from './errors.ts';
import type { FailureCode } from './failure-code.ts';
import type { Money } from './money.ts';
import { invertDirection, LedgerDirection } from './wallet-ledger-entry.ts';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca vem da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultingBalance: Money | undefined;
  referenceAttempts: number;
  nextAttemptAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  now: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  now: Date;
}

const INTERNAL_PROVIDER = 'internal';

/**
 * Transições válidas:
 *
 *   PENDING ──────────────► PROCESSED | REJECTED | FAILED
 *   PENDING ──────────────► PENDING_REFERENCE
 *   PENDING_REFERENCE ────► PENDING_REFERENCE (nova tentativa agendada)
 *   PENDING_REFERENCE ────► PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED e FAILED são terminais: qualquer transição a partir
 * deles lança InvalidTransactionStateError (erro de programação).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id no provedor — não o id interno. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultingBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência e de valor por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required = {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(`${field} is required`);
      }
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new ValidationError('OPENING is internal and cannot be submitted');
    }

    const reference = props.referenceExternalTransactionId;
    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && (reference === undefined || reference.trim() === '')) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new ValidationError('BET cannot reference another transaction');
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new ValidationError('A transaction cannot reference itself');
    }

    const zeroAllowed = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (props.money.isZero() && !zeroAllowed)) {
      throw new ValidationError(`${props.kind} amount must be positive`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.now,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Transação interna do saldo inicial; já nasce PROCESSED junto com a wallet. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new ValidationError('OPENING amount must be positive');
    }
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER,
      externalId,
      `${INTERNAL_PROVIDER}:${externalId}`,
      '',
      props.walletId,
      props.playerId,
      externalId,
      INTERNAL_PROVIDER,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.now,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.now,
      props.money,
      0,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceAttempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Instante em que a transação chegou a um estado terminal. */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Saldo observado quando a transação foi resolvida; devolvido nos replays. */
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, resultingBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /**
   * Primeira vez (vinda de PENDING): agenda a tentativa 0.
   * Chamadas seguintes: conta mais uma tentativa e empurra o próximo horário.
   */
  markPendingReference(now: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = new Date(
      now.getTime() + exponentialBackoffMs(this._referenceAttempts, REFERENCE_RETRY_POLICY),
    );
  }

  reject(code: FailureCode, resultingBalance: Money | undefined, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this.settleFailure(code, resultingBalance, at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this.settleFailure(code, undefined, at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    );
  }

  /**
   * A tentativa em curso é a última permitida. `referenceAttempts` conta as
   * tentativas já fracassadas; a atual é a de número `referenceAttempts + 1`.
   */
  hasExhaustedReferenceAttempts(): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._referenceAttempts + 1 >= REFERENCE_RETRY_POLICY.maxAttempts
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** undefined quando a operação não move saldo (LOSS). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const original = reference?.ledgerDirectionFor();
        if (original === undefined) {
          throw new ValidationError('ROLLBACK needs a reference that moved the balance');
        }
        return invertDirection(original);
      }
    }
  }

  private settleFailure(code: FailureCode, resultingBalance: Money | undefined, at: Date): void {
    this._failureCode = code;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition} a transaction in terminal state ${this._status}`,
      );
    }
  }
}
