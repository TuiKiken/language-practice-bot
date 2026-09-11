// Time budget for one cycle inside waitUntil (spec §7 "Бюджет времени"). Clock injected.

export const LIMITS = {
  cycleBudgetMs: 26_000,
  modelCallTimeoutMs: 10_000,
  sendReserveMs: 4_000,
  retryBaseDelayMs: 800,
  retryJitterMs: 400,
  leaseTtlMs: 40_000,
  typingIntervalMs: 4_000,
  telegramMaxRetryAfterMs: 5_000,
  maxOutputTokensGenerate: 400,
  maxOutputTokensCheck: 500,
  maxOutputTokensExplain: 600,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  fingerprintWindow: 30,
  seenUpdateWindow: 20,
  maxMessageLength: 4096,
} as const;

export class Budget {
  private readonly now: () => number;
  private readonly deadline: number;

  constructor(now: () => number, deadline: number) {
    this.now = now;
    this.deadline = deadline;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  canAfford(ms: number): boolean {
    return this.remainingMs() >= ms;
  }
}

export function jitteredDelay(attempt: number, random: () => number): number {
  return LIMITS.retryBaseDelayMs * attempt + Math.floor(random() * LIMITS.retryJitterMs);
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super('cycle time budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

export interface RetryOptions {
  budget: Budget;
  callTimeoutMs: number;
  reserveMs: number;
  maxAttempts: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  delayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Runs `fn` with a per-attempt timeout signal. A retry happens only if the caller's policy allows it
 * AND the remaining budget still fits delay + one full call + the send reserve.
 */
export async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const usable = opts.budget.remainingMs() - opts.reserveMs;
    if (usable <= 0) throw new BudgetExhaustedError();
    const timeout = Math.min(opts.callTimeoutMs, usable);
    try {
      return await fn(AbortSignal.timeout(timeout));
    } catch (error) {
      if (attempt >= opts.maxAttempts || !opts.shouldRetry(error, attempt)) throw error;
      const delay = opts.delayMs(attempt);
      if (opts.budget.remainingMs() - opts.reserveMs < delay + opts.callTimeoutMs) throw error;
      await opts.sleep(delay);
    }
  }
}
