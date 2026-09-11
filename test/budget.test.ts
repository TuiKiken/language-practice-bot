import { describe, expect, it } from 'vitest';
import { Budget, BudgetExhaustedError, jitteredDelay, LIMITS, withRetry } from '../src/budget.ts';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('Budget', () => {
  it('reports remaining time and affordability', () => {
    const c = clock(1000);
    const b = new Budget(c.now, 1000 + 26_000);
    expect(b.remainingMs()).toBe(26_000);
    expect(b.canAfford(26_000)).toBe(true);
    c.advance(25_000);
    expect(b.remainingMs()).toBe(1000);
    expect(b.canAfford(2000)).toBe(false);
    c.advance(5000);
    expect(b.remainingMs()).toBe(0);
  });
});

describe('jitteredDelay', () => {
  it('grows with the attempt and adds bounded jitter', () => {
    expect(jitteredDelay(1, () => 0)).toBe(LIMITS.retryBaseDelayMs);
    expect(jitteredDelay(1, () => 0.999)).toBeLessThan(LIMITS.retryBaseDelayMs + LIMITS.retryJitterMs);
    expect(jitteredDelay(2, () => 0)).toBe(2 * LIMITS.retryBaseDelayMs);
  });
});

describe('withRetry', () => {
  const base = (c: ReturnType<typeof clock>, extra: Partial<Parameters<typeof withRetry>[1]> = {}) => ({
    budget: new Budget(c.now, LIMITS.cycleBudgetMs),
    callTimeoutMs: 10_000,
    reserveMs: 4_000,
    maxAttempts: 2,
    shouldRetry: () => true,
    delayMs: () => 1000,
    sleep: async (ms: number) => { c.advance(ms); },
    ...extra,
  });

  it('returns on first success without sleeping', async () => {
    const c = clock();
    let calls = 0;
    const v = await withRetry(async () => { calls++; return 'ok'; }, base(c));
    expect(v).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries once when the budget allows', async () => {
    const c = clock();
    let calls = 0;
    const v = await withRetry(async () => {
      calls++;
      if (calls === 1) { c.advance(10_000); throw new Error('boom'); }
      return 'second';
    }, base(c));
    expect(v).toBe('second');
    expect(calls).toBe(2);
  });

  it('does not retry when the remaining budget cannot fit another call plus the reserve', async () => {
    const c = clock();
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      c.advance(13_000); // remaining 13 000 < delay 1 000 + call 10 000 + reserve 4 000
      throw new Error('boom');
    }, base(c))).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('does not retry when shouldRetry says no', async () => {
    const c = clock();
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('permanent'); },
      base(c, { shouldRetry: () => false }))).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });

  it('stops at maxAttempts', async () => {
    const c = clock();
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('again'); },
      base(c, { maxAttempts: 3, delayMs: () => 0 }))).rejects.toThrow('again');
    expect(calls).toBe(3);
  });

  it('throws BudgetExhaustedError when nothing is left before the first attempt', async () => {
    const c = clock();
    c.advance(30_000);
    await expect(withRetry(async () => 'never', base(c))).rejects.toThrow(BudgetExhaustedError);
  });

  it('passes a signal whose timeout is capped by the remaining budget', async () => {
    const c = clock();
    c.advance(20_000); // remaining 6 000 − reserve 4 000 = 2 000 for the call
    let seen: AbortSignal | null = null;
    await withRetry(async (signal) => { seen = signal; return 1; }, base(c));
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
