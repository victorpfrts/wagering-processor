import { applyWagerTransaction } from '../domain/apply-wager-transaction.ts';
import { DomainError, ValidationError } from '../domain/errors.ts';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events.ts';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.ts';
import { FailureCode } from '../domain/failure-code.ts';
import { Money, type MoneyProps } from '../domain/money.ts';
import { computePayloadHash } from '../domain/payload-hash.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { InboxMessage } from '../domain/inbox-message.ts';
import {
  DuplicateKeyError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  TransientInfrastructureError,
} from './errors.ts';
import {
  type AppLogger,
  type Clock,
  type IdGenerator,
  NOOP_METRICS,
  SILENT_LOGGER,
  type TransactionContext,
  type TransactionSource,
  type UnitOfWork,
  type WageringMetrics,
} from './ports.ts';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  /** Rastreio: acompanha logs e eventos gerados por esta operação. */
  correlationId: string;
  /** Id da mensagem que causou a operação (entrada por fila). */
  causationId?: string | undefined;
  /**
   * Presente quando a entrada é a fila: a mensagem é registrada no inbox na
   * mesma transação SQL do efeito financeiro.
   */
  inbox?: InboxReceipt | undefined;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi resolvida (o original, em replays). */
  balance: MoneyProps | undefined;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Corridas pela mesma chave se resolvem na 2ª execução; o limite só evita laço. */
const MAX_DUPLICATE_KEY_RETRIES = 3;

/**
 * Caso de uso único para a entrada HTTP e para a fila.
 *
 * Dentro de UMA transação SQL:
 *   1. trava a wallet (FOR UPDATE) — serializa tudo que toca o mesmo saldo;
 *   2. procura a idempotency key — replay devolve o resultado original,
 *      payload divergente é conflito;
 *   3. aplica as regras de negócio (função pura do domínio);
 *   4. grava transação, lançamento, saldo e eventos (outbox).
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger = SILENT_LOGGER,
    private readonly metrics: WageringMetrics = NOOP_METRICS,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const source: TransactionSource = command.inbox === undefined ? 'http' : 'queue';
    const startedAt = performance.now();
    // Campos de rastreio. De propósito NÃO há valor, saldo nem payload aqui.
    const trace = {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      providerId: command.providerId,
      walletId: command.walletId,
      source,
    };
    const observe = (outcome: string): void =>
      this.metrics.processingObserved(source, outcome, (performance.now() - startedAt) / 1000);

    try {
      const candidate = this.buildCandidate(command);
      const { result, kind, inboxRedelivery } = await this.runWithRetry(candidate, command);

      if (inboxRedelivery) this.metrics.duplicateDetected('inbox_redelivery');
      if (result.idempotentReplay) {
        this.metrics.duplicateDetected('idempotent_replay');
      } else {
        this.metrics.transactionResolved({
          kind,
          status: result.status,
          failureCode: result.failureCode,
          source,
        });
      }
      observe(result.idempotentReplay ? 'replay' : result.status.toLowerCase());
      this.logger.info('wager transaction handled', {
        ...trace,
        transactionId: result.transactionId,
        kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        this.metrics.duplicateDetected('idempotency_conflict');
        observe('conflict');
        this.logger.warn('idempotency conflict', trace);
      } else if (error instanceof TransientInfrastructureError) {
        if (error.reason !== 'UNAVAILABLE') this.metrics.concurrencyConflict(error.reason);
        observe('transient_failure');
        this.logger.warn('transient failure; nothing was committed', {
          ...trace,
          reason: error.reason,
        });
      } else if (error instanceof DomainError || error instanceof InboxPayloadMismatchError) {
        observe('invalid');
      } else {
        observe('error');
        this.logger.error('unexpected failure; nothing was committed', {
          ...trace,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async runWithRetry(
    candidate: CandidateFactory,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.unitOfWork.run((context) => this.process(context, candidate, command));
      } catch (error) {
        // Outra transação gravou a mesma chave entre a nossa busca e o nosso
        // insert (só acontece quando as duas não disputam a mesma wallet).
        // Reexecutar faz a busca encontrar o registro: replay ou conflito.
        if (error instanceof DuplicateKeyError && attempt < MAX_DUPLICATE_KEY_RETRIES) {
          this.metrics.concurrencyConflict('DUPLICATE_KEY');
          continue;
        }
        throw error;
      }
    }
  }

  /** Validação de formato, fora da transação: payload inválido nem abre conexão. */
  private buildCandidate(command: ProcessWagerTransactionCommand): CandidateFactory {
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim() === '') {
      throw new ValidationError('Idempotency-Key is required');
    }
    if (!SUBMITTABLE_KINDS.has(command.kind)) {
      throw new ValidationError(`kind must be one of ${[...SUBMITTABLE_KINDS].join(', ')}`);
    }
    const kind = command.kind as WagerTransactionKind;
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({ ...command, kind, money });

    const create = (): WagerTransaction =>
      WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        now: this.clock.now(),
      });
    create(); // dispara as validações do domínio antes de abrir a transação
    return { payloadHash, kind, create };
  }

  private async process(
    context: TransactionContext,
    candidate: CandidateFactory,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessOutcome> {
    // 1. Lock primeiro: a partir daqui ninguém mais mexe nesta wallet.
    const wallet = await context.wallets.lockById(command.walletId);

    // Entrada por fila: registra a mensagem no inbox, na mesma transação.
    // Redelivery (mesmo messageId, mesmo conteúdo) segue adiante e cai no
    // replay da idempotency key logo abaixo — nenhum efeito é repetido.
    const inboxRedelivery =
      command.inbox !== undefined && (await this.registerInInbox(context, command.inbox));

    // 2. Idempotência, já sob o lock.
    const sameKey = await context.transactions.findByIdempotencyKey(command.idempotencyKey);
    const sameExternalId =
      sameKey ??
      (await context.transactions.findByExternalId(
        command.providerId,
        command.externalTransactionId,
      ));
    if (sameExternalId !== undefined) {
      // A segunda busca pode enxergar uma linha que outra transação confirmou
      // depois da primeira (acontece quando não há wallet para travar). Por
      // isso a decisão é pela chave gravada, não por qual busca a encontrou.
      if (sameExternalId.idempotencyKey !== command.idempotencyKey) {
        throw new IdempotencyConflictError(
          'externalTransactionId was already submitted under a different Idempotency-Key',
        );
      }
      if (!sameExternalId.matchesPayload(candidate.payloadHash)) {
        throw new IdempotencyConflictError(
          'Idempotency-Key was already used with a different payload',
        );
      }
      return { result: toResult(sameExternalId, true), kind: candidate.kind, inboxRedelivery };
    }

    // 3 e 4. Regras de negócio e persistência.
    const transaction = candidate.create();
    await this.resolve(context, wallet, transaction, command, 'insert');
    return { result: toResult(transaction, false), kind: candidate.kind, inboxRedelivery };
  }

  /** Devolve true quando a mensagem já tinha sido recebida (redelivery). */
  private async registerInInbox(
    context: TransactionContext,
    receipt: InboxReceipt,
  ): Promise<boolean> {
    const seen = await context.inbox.find(receipt.consumerName, receipt.messageId);
    if (seen === undefined) {
      const now = this.clock.now();
      const message = InboxMessage.receive({ ...receipt, now });
      message.markProcessed(now);
      // Se esta transação for desfeita, o registro some junto: a mensagem
      // volta a ser "nunca vista" e o redelivery a processa do zero.
      await context.inbox.insert(message);
      return false;
    }
    if (!seen.matchesPayload(receipt.payloadHash)) {
      throw new InboxPayloadMismatchError();
    }
    return true;
  }

  /**
   * Aplica as regras e grava o desfecho. Compartilhado com o worker de
   * referências fora de ordem, que chama com persistence = 'save'.
   */
  async resolve(
    context: TransactionContext,
    wallet: Wallet | undefined,
    transaction: WagerTransaction,
    trace: { correlationId: string; causationId?: string | undefined },
    persistence: 'insert' | 'save',
  ): Promise<void> {
    const now = this.clock.now();
    const wasPendingReference = transaction.status === WagerTransactionStatus.PendingReference;
    let ledgerEntry: WalletLedgerEntry | undefined;

    if (wallet === undefined) {
      transaction.reject(FailureCode.WalletNotFound, undefined, now);
    } else {
      const reference =
        transaction.referenceExternalTransactionId === undefined
          ? undefined
          : await context.transactions.findByExternalId(
              transaction.providerId,
              transaction.referenceExternalTransactionId,
            );
      const referenceAlreadyReversed =
        reference !== undefined && transaction.requiresReference()
          ? await context.transactions.hasProcessedReversal(reference.id)
          : false;

      ({ ledgerEntry } = applyWagerTransaction({
        wallet,
        transaction,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now,
      }));
    }

    // A transação vai primeiro: o lançamento tem chave estrangeira para ela.
    await (persistence === 'insert'
      ? context.transactions.insert(transaction)
      : context.transactions.save(transaction));

    const events: IntegrationEvent<unknown>[] = [];
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: trace.correlationId,
      causationId: trace.causationId,
      occurredAt: now,
    });

    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(transaction, eventContext()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(transaction, eventContext()));
        break;
      case WagerTransactionStatus.PendingReference:
        // Só na entrada no estado; novas tentativas não repetem o evento.
        if (!wasPendingReference) {
          events.push(WagerTransactionPendingReference.from(transaction, eventContext()));
        }
        break;
      default:
        break;
    }

    if (wallet !== undefined && ledgerEntry !== undefined) {
      await context.ledger.append(ledgerEntry);
      await context.wallets.save(wallet);
      events.push(WalletBalanceChanged.from(wallet, ledgerEntry, eventContext()));
    }

    await context.outbox.enqueue(events);
  }
}

interface CandidateFactory {
  payloadHash: string;
  kind: WagerTransactionKind;
  create(): WagerTransaction;
}

interface ProcessOutcome {
  result: WagerTransactionResult;
  kind: WagerTransactionKind;
  inboxRedelivery: boolean;
}

export function toResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultingBalance?.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}
