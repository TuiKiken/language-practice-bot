// Durable Object holding one chat's session as a single value (spec §7). No network calls here.
import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from './budget.ts';
import type { Env } from './env.ts';
import { MAX_WINDOW } from './topics.ts';
import type { CurrentTask, PreviousItem, SessionState, SessionSummary } from './types.ts';

const KEY = 'state';

/**
 * `consumesExercise` is kept for callers to document intent, but the daily cap gates every
 * model-calling acquisition (including `/why`), not just exercise turns.
 */
export interface AcquireOptions { leaseTtlMs: number; dailyLimit: number; consumesExercise: boolean }
export type Acquired = { kind: 'acquired'; leaseId: number; epoch: number; state: SessionState };
export type AcquireResult = Acquired | { kind: 'busy' } | { kind: 'duplicate' } | { kind: 'daily-limit'; resetAt: number };
export interface Outcome { counted: boolean; onTarget: boolean; missCellKey: string | null }
export interface CommitPatch {
  next: CurrentTask;
  fingerprint: string;
  markCellUsed: boolean;
  previous: PreviousItem | null;
  outcome: Outcome | null;
}
export interface ReleasePatch { clearTask: boolean; previous: PreviousItem | null; outcome: Outcome | null }
export type StopResult = { kind: 'stopped'; summary: SessionSummary } | { kind: 'no-topic' } | { kind: 'duplicate' };

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function freshState(now: number): SessionState {
  return {
    topicId: null,
    current: null,
    previous: null,
    pendingDelivery: false,
    axesUsed: [],
    missCounts: {},
    stats: { total: 0, correct: 0 },
    fingerprints: [],
    lease: null,
    leaseSeq: 0,
    epoch: 0,
    seenUpdateIds: [],
    updatedAt: now,
    dailyCount: 0,
    dailyResetAt: nextUtcMidnight(now),
  };
}

function clearSession(state: SessionState): void {
  state.topicId = null;
  state.current = null;
  state.previous = null;
  state.pendingDelivery = false;
  state.axesUsed = [];
  state.missCounts = {};
  state.stats = { total: 0, correct: 0 };
  state.fingerprints = [];
}

export function summarize(state: SessionState): SessionSummary {
  const worstCells = Object.entries(state.missCounts)
    .filter(([, misses]) => misses > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cellKey, misses]) => ({ cellKey, misses }));
  return { total: state.stats.total, correct: state.stats.correct, worstCells };
}

function applyOutcome(state: SessionState, outcome: Outcome | null): void {
  if (!outcome || !outcome.counted) return;
  state.stats.total += 1;
  if (outcome.onTarget) state.stats.correct += 1;
  if (outcome.missCellKey !== null) {
    state.missCounts[outcome.missCellKey] = (state.missCounts[outcome.missCellKey] ?? 0) + 1;
  }
}

function pushWindow<T>(list: T[], value: T, size: number): void {
  list.push(value);
  while (list.length > size) list.shift();
}

export class SessionObject extends DurableObject<Env> {
  private async load(now: number): Promise<SessionState> {
    const stored = await this.ctx.storage.get<SessionState>(KEY);
    const state = stored ?? freshState(now);
    if (now >= state.dailyResetAt) {
      state.dailyCount = 0;
      state.dailyResetAt = nextUtcMidnight(now);
    }
    if (state.topicId !== null && now - state.updatedAt > LIMITS.sessionTtlMs) {
      clearSession(state);
      state.lease = null;
    }
    return state;
  }

  private async save(state: SessionState, now: number): Promise<void> {
    state.updatedAt = now;
    await this.ctx.storage.put(KEY, state);
  }

  /** Returns true (and records nothing) when the update was already seen. */
  private seen(state: SessionState, updateId: number): boolean {
    if (state.seenUpdateIds.includes(updateId)) return true;
    pushWindow(state.seenUpdateIds, updateId, LIMITS.seenUpdateWindow);
    return false;
  }

  private takeLease(state: SessionState, now: number, ttlMs: number): number {
    state.leaseSeq += 1;
    state.lease = { id: state.leaseSeq, expiresAt: now + ttlMs };
    return state.leaseSeq;
  }

  private holds(state: SessionState, leaseId: number): boolean {
    return state.lease !== null && state.lease.id === leaseId;
  }

  async inspect(now: number): Promise<SessionState> {
    return this.load(now);
  }

  async acquire(updateId: number, now: number, opts: AcquireOptions): Promise<AcquireResult> {
    const state = await this.load(now);
    if (this.seen(state, updateId)) return { kind: 'duplicate' };
    if (state.lease !== null && state.lease.expiresAt > now) {
      await this.save(state, now);
      return { kind: 'busy' };
    }
    if (state.topicId !== null && state.dailyCount >= opts.dailyLimit && !state.pendingDelivery) {
      await this.save(state, now);
      return { kind: 'daily-limit', resetAt: state.dailyResetAt };
    }
    const leaseId = this.takeLease(state, now, opts.leaseTtlMs);
    await this.save(state, now);
    return { kind: 'acquired', leaseId, epoch: state.epoch, state };
  }

  async selectTopic(updateId: number, topicId: string, now: number, opts: AcquireOptions): Promise<AcquireResult> {
    const state = await this.load(now);
    if (this.seen(state, updateId)) return { kind: 'duplicate' };
    if (state.dailyCount >= opts.dailyLimit) {
      await this.save(state, now);
      return { kind: 'daily-limit', resetAt: state.dailyResetAt };
    }
    clearSession(state);
    state.topicId = topicId;
    state.epoch += 1;
    const leaseId = this.takeLease(state, now, opts.leaseTtlMs);
    await this.save(state, now);
    return { kind: 'acquired', leaseId, epoch: state.epoch, state };
  }

  async commitTask(leaseId: number, epoch: number, patch: CommitPatch, now: number): Promise<'ok' | 'stale'> {
    const state = await this.load(now);
    if (!this.holds(state, leaseId) || state.epoch !== epoch) return 'stale';
    applyOutcome(state, patch.outcome);
    if (patch.previous !== null) state.previous = patch.previous;
    state.current = patch.next;
    state.pendingDelivery = true;
    if (patch.markCellUsed && patch.next.cellKey !== null) pushWindow(state.axesUsed, patch.next.cellKey, MAX_WINDOW);
    if (patch.fingerprint.trim() !== '') pushWindow(state.fingerprints, patch.fingerprint, LIMITS.fingerprintWindow);
    state.dailyCount += 1;
    await this.save(state, now);
    return 'ok';
  }

  async markDelivered(leaseId: number, now: number): Promise<void> {
    const state = await this.load(now);
    if (!this.holds(state, leaseId)) return;
    state.pendingDelivery = false;
    state.lease = null;
    await this.save(state, now);
  }

  async release(leaseId: number, patch: ReleasePatch | null, now: number): Promise<void> {
    const state = await this.load(now);
    if (!this.holds(state, leaseId)) return;
    if (patch !== null) {
      applyOutcome(state, patch.outcome);
      if (patch.previous !== null) state.previous = patch.previous;
      if (patch.clearTask) {
        state.current = null;
        state.pendingDelivery = false;
      }
    }
    state.lease = null;
    await this.save(state, now);
  }

  /** `/topics`: kill any in-flight cycle, keep the session. */
  async interrupt(updateId: number, now: number): Promise<'ok' | 'duplicate'> {
    const state = await this.load(now);
    if (this.seen(state, updateId)) return 'duplicate';
    state.epoch += 1;
    state.lease = null;
    await this.save(state, now);
    return 'ok';
  }

  async stop(updateId: number, now: number): Promise<StopResult> {
    const state = await this.load(now);
    if (this.seen(state, updateId)) return { kind: 'duplicate' };
    if (state.topicId === null) {
      await this.save(state, now);
      return { kind: 'no-topic' };
    }
    const summary = summarize(state);
    clearSession(state);
    state.epoch += 1;
    state.lease = null;
    await this.save(state, now);
    return { kind: 'stopped', summary };
  }

  /** Vanished topic or a permanently failing chat: drop the session, keep the daily counter. */
  async reset(now: number): Promise<void> {
    const state = await this.load(now);
    clearSession(state);
    state.epoch += 1;
    state.lease = null;
    await this.save(state, now);
  }
}
