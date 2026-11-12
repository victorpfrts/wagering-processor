export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Backoff exponencial determinístico: base * 2^attempt, limitado por maxMs.
 * `attempt` começa em 0. Sem jitter de propósito: o domínio fica testável
 * e a dispersão entre instâncias já vem do intervalo de polling dos workers.
 */
export function exponentialBackoffMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, Math.min(attempt, 30));
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
}

/** Referência fora de ordem: 2s, 4s, 8s, 16s, 32s, 64s (~2 min) e então rejeita. */
export const REFERENCE_RETRY_POLICY = {
  baseMs: 2_000,
  maxMs: 64_000,
  maxAttempts: 6,
} as const;

/** Publicação da outbox: 1s, 2s, 4s ... até 60s, sem limite de tentativas. */
export const OUTBOX_RETRY_POLICY = {
  baseMs: 1_000,
  maxMs: 60_000,
} as const;
