/** Base de todos os erros de domínio. `code` é estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que nunca deveria ter passado da borda (payload malformado). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('Insufficient funds');
  }
}

/** Erro de programação: tentativa de transicionar uma transação em estado terminal. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}
