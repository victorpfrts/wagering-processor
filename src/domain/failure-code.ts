/**
 * Taxonomia estável de falhas. O provedor decide pelo código se reenvia,
 * corrige o payload ou desiste (ver docs/regras.md).
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Usado apenas com o status FAILED (erro permanente de infraestrutura). */
  InternalError = 'INTERNAL_ERROR',
}
