import type { IntegrationEvent } from '../domain/events/integration-event.ts';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-events.ts';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.ts';
import { ValidationError } from '../domain/errors.ts';
import { Money, type MoneyProps } from '../domain/money.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';
import { Wallet } from '../domain/wallet.ts';
import { DuplicateKeyError, WalletAlreadyExistsError } from './errors.ts';
import type { Clock, IdGenerator, UnitOfWork } from './ports.ts';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Abre a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a transação
 * interna OPENING, o lançamento CREDIT e os eventos — a wallet nunca existe
 * com saldo sem ledger.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    if (typeof command.playerId !== 'string' || command.playerId.trim() === '') {
      throw new ValidationError('playerId is required');
    }
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      now,
    });

    try {
      await this.unitOfWork.run(async (context) => {
        await context.wallets.insert(wallet);
        if (openingEntry === undefined) return;

        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          now,
        });
        await context.transactions.insert(opening);
        await context.ledger.append(openingEntry);

        const eventContext = () => ({
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          occurredAt: now,
        });
        const events: IntegrationEvent<unknown>[] = [
          WagerTransactionProcessed.from(opening, eventContext()),
          WalletBalanceChanged.from(wallet, openingEntry, eventContext()),
        ];
        await context.outbox.enqueue(events);
      });
    } catch (error) {
      // O índice único (player_id, currency) é quem decide a corrida entre
      // duas aberturas simultâneas.
      if (error instanceof DuplicateKeyError) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
    return wallet;
  }
}
