import { WagerTransactionStatus } from '../domain/wager-transaction.ts';
import type {
  AppLogger,
  Clock,
  UnitOfWork,
  WageringMetrics,
  WageringReadModel,
} from './ports.ts';
import type { ProcessWagerTransaction } from './process-wager-transaction.ts';

/**
 * Reprocessa transações que chegaram antes da transação que referenciam
 * (seção 7.1). Chamado por um worker agendado em toda instância.
 *
 * Cada transação pendente é tratada na sua própria transação SQL e pelo MESMO
 * código de regras do caminho normal (ProcessWagerTransaction.resolve):
 *
 *   - referência chegou            → PROCESSED ou REJECTED, conforme as regras;
 *   - ainda não chegou             → nova tentativa com backoff exponencial;
 *   - tentativas esgotadas         → REJECTED (REFERENCE_NOT_FOUND) + evento.
 *
 * Várias instâncias podem rodar ao mesmo tempo: o lock da wallet serializa, e
 * quem chega depois relê a transação e vê que ela já não está vencida.
 */
export class RetryPendingReferences {
  constructor(
    private readonly readModel: WageringReadModel,
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
    private readonly batchSize: number,
  ) {}

  /** Devolve quantas transações foram de fato reavaliadas nesta rodada. */
  async execute(): Promise<number> {
    const due = await this.readModel.duePendingReferences(this.clock.now(), this.batchSize);
    let retried = 0;

    for (const candidate of due) {
      try {
        const status = await this.retryOne(candidate.id, candidate.walletId);
        if (status !== undefined) {
          retried += 1;
          this.metrics.pendingReferenceRetried(status);
          this.logger.info('pending reference retried', {
            transactionId: candidate.id,
            walletId: candidate.walletId,
            status,
          });
        }
      } catch (error) {
        // Falha transitória (lock, banco): a transação continua vencida e a
        // próxima rodada tenta de novo. Uma falha não trava as demais.
        this.logger.warn('pending reference retry failed', {
          transactionId: candidate.id,
          walletId: candidate.walletId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return retried;
  }

  private retryOne(
    transactionId: string,
    walletId: string,
  ): Promise<WagerTransactionStatus | undefined> {
    return this.unitOfWork.run(async (context) => {
      // Mesma ordem do caminho normal: a wallet primeiro.
      const wallet = await context.wallets.lockById(walletId);
      // Relê sob o lock: outra instância pode ter acabado de tratar.
      const transaction = await context.transactions.findById(transactionId);
      const nextAttemptAt = transaction?.nextAttemptAt;
      if (
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        nextAttemptAt === undefined ||
        nextAttemptAt.getTime() > this.clock.now().getTime()
      ) {
        return undefined;
      }

      // A requisição original já terminou; o id da transação amarra os
      // eventos desta resolução tardia.
      await this.processor.resolve(
        context,
        wallet,
        transaction,
        { correlationId: transaction.id },
        'save',
      );
      return transaction.status;
    });
  }
}
