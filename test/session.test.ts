import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/budget.ts';
import { nextUtcMidnight } from '../src/session.ts';
import type { CommitPatch } from '../src/session.ts';

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0); // 2026-09-11 12:00 UTC
const OPTS = { leaseTtlMs: LIMITS.leaseTtlMs, dailyLimit: 100, consumesExercise: true };

let chatCounter = 0;
function stub() {
  chatCounter++;
  return env.SESSIONS.get(env.SESSIONS.idFromName(`chat-${chatCounter}`));
}

function patch(task: string, cellKey = 'форма=on'): CommitPatch {
  return {
    next: { task, answer: 'poszła', exact: true, cellKey, axes: { форма: 'on' } },
    fingerprint: `fp-${task}`,
    markCellUsed: true,
    previous: null,
    outcome: null,
  };
}

describe('SessionObject', () => {
  it('acquires a lease on a fresh chat', async () => {
    const s = stub();
    const r = await s.acquire(1, T0, OPTS);
    expect(r.kind).toBe('acquired');
    if (r.kind !== 'acquired') return;
    expect(r.leaseId).toBe(1);
    expect(r.state.topicId).toBeNull();
    expect(r.epoch).toBe(0);
  });

  it('reports busy while the lease is alive and takes over after expiry with a larger id', async () => {
    const s = stub();
    await s.acquire(1, T0, OPTS);
    expect((await s.acquire(2, T0 + 1000, OPTS)).kind).toBe('busy');
    const r = await s.acquire(3, T0 + LIMITS.leaseTtlMs + 1, OPTS);
    expect(r.kind).toBe('acquired');
    if (r.kind === 'acquired') expect(r.leaseId).toBe(2);
  });

  it('a cycle with a stale lease id does not commit', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    const b = await s.acquire(2, T0 + LIMITS.leaseTtlMs + 1, OPTS); // takes over
    if (b.kind !== 'acquired') throw new Error(b.kind);
    expect(await s.commitTask(a.leaseId, a.epoch, patch('old'), T0 + 50_000)).toBe('stale');
    expect(await s.commitTask(b.leaseId, b.epoch, patch('new'), T0 + 50_000)).toBe('ok');
    expect((await s.inspect(T0 + 50_000)).current?.task).toBe('new');
  });

  it('a cycle finishing after /stop does not resurrect the session', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    const stopped = await s.stop(2, T0 + 1000);
    expect(stopped.kind).toBe('stopped');
    expect(await s.commitTask(a.leaseId, a.epoch, patch('zombie'), T0 + 2000)).toBe('stale');
    expect((await s.inspect(T0 + 2000)).topicId).toBeNull();
  });

  it('pendingDelivery survives a dead worker and is visible to the next acquirer', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    expect(await s.commitTask(a.leaseId, a.epoch, patch('t1'), T0 + 100)).toBe('ok');
    // worker dies here: no markDelivered
    expect((await s.acquire(2, T0 + 1000, OPTS)).kind).toBe('busy');
    const b = await s.acquire(3, T0 + LIMITS.leaseTtlMs + 200, OPTS);
    if (b.kind !== 'acquired') throw new Error(b.kind);
    expect(b.state.pendingDelivery).toBe(true);
    expect(b.state.current?.task).toBe('t1');
    await s.markDelivered(a.leaseId, T0 + 50_000); // stale: ignored
    expect((await s.inspect(T0 + 50_000)).pendingDelivery).toBe(true);
    await s.markDelivered(b.leaseId, T0 + 50_000);
    const after = await s.inspect(T0 + 50_000);
    expect(after.pendingDelivery).toBe(false);
    expect(after.lease).toBeNull();
  });

  it('/topics and /stop pass while the lease is held and clear it', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    expect(await s.interrupt(2, T0 + 10)).toBe('ok');
    const st = await s.inspect(T0 + 10);
    expect(st.lease).toBeNull();
    expect(st.epoch).toBe(a.epoch + 1);
    expect(st.topicId).toBe('czas-przeszly'); // interrupt keeps the topic
  });

  it('resets state older than a day but keeps the daily counter', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, patch('t1'), T0 + 100);
    await s.markDelivered(a.leaseId, T0 + 200);
    const later = T0 + LIMITS.sessionTtlMs + 1000; // 12:00 + 24 h: the session expired and UTC midnight has passed
    const st = await s.inspect(later);
    expect(st.topicId).toBeNull();
    expect(st.current).toBeNull();
    // midnight passed, so the daily counter is reset by schedule, not by expiry:
    expect(st.dailyCount).toBe(0);
  });

  it('keeps the daily counter within the same UTC day', async () => {
    const s = stub();
    const t0 = Date.UTC(2026, 8, 11, 0, 30, 0); // 00:30 UTC
    const a = await s.selectTopic(1, 'czas-przeszly', t0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, patch('t1'), t0 + 100);
    await s.markDelivered(a.leaseId, t0 + 200);
    // 23h later is still 2026-09-11 (23:30), but the session TTL is 24h, so nothing expires yet
    expect((await s.inspect(t0 + 23 * 3600_000)).dailyCount).toBe(1);
  });

  it('drops a duplicate update_id', async () => {
    const s = stub();
    expect((await s.acquire(7, T0, OPTS)).kind).toBe('acquired');
    expect((await s.acquire(7, T0 + LIMITS.leaseTtlMs + 1, OPTS)).kind).toBe('duplicate');
    expect(await s.interrupt(7, T0 + 100_000)).toBe('duplicate');
  });

  it('enforces the daily cap and resets it at UTC midnight', async () => {
    const s = stub();
    const opts = { ...OPTS, dailyLimit: 2 };
    const a = await s.selectTopic(1, 'czas-przeszly', T0, opts);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, patch('t1'), T0 + 10);
    await s.markDelivered(a.leaseId, T0 + 20);
    const b = await s.acquire(2, T0 + 30, opts);
    if (b.kind !== 'acquired') throw new Error(b.kind);
    await s.commitTask(b.leaseId, b.epoch, patch('t2'), T0 + 40);
    await s.markDelivered(b.leaseId, T0 + 50);
    const c = await s.acquire(3, T0 + 60, opts);
    expect(c.kind).toBe('daily-limit');
    if (c.kind === 'daily-limit') expect(c.resetAt).toBe(nextUtcMidnight(T0));
    // the cap gates every model-calling acquisition, /why included
    expect((await s.acquire(4, T0 + 70, { ...opts, consumesExercise: false })).kind).toBe('daily-limit');
    // after midnight the cap is gone (session also expired → topic null, so use selectTopic)
    const d = await s.selectTopic(5, 'czas-przeszly', nextUtcMidnight(T0) + 1, opts);
    expect(d.kind).toBe('acquired');
  });

  it('selectTopic resets windows, counters and bumps the epoch', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, { ...patch('t1'), outcome: { counted: true, onTarget: false, missCellKey: 'форма=on' } }, T0 + 10);
    await s.markDelivered(a.leaseId, T0 + 20);
    const before = await s.inspect(T0 + 30);
    expect(before.axesUsed).toEqual(['форма=on']);
    expect(before.missCounts).toEqual({ 'форма=on': 1 });
    expect(before.stats).toEqual({ total: 1, correct: 0 });
    const b = await s.selectTopic(2, 'inna', T0 + 40, OPTS);
    if (b.kind !== 'acquired') throw new Error(b.kind);
    expect(b.epoch).toBe(a.epoch + 1);
    expect(b.state.axesUsed).toEqual([]);
    expect(b.state.missCounts).toEqual({});
    expect(b.state.fingerprints).toEqual([]);
    expect(b.state.topicId).toBe('inna');
  });

  it('trims the windows', async () => {
    const s = stub();
    let t = T0;
    let cur = await s.selectTopic(1, 'czas-przeszly', t, OPTS);
    for (let i = 0; i < 35; i++) {
      if (cur.kind !== 'acquired') throw new Error(cur.kind);
      await s.commitTask(cur.leaseId, cur.epoch, patch(`t${i}`, `cell-${i}`), t + 1);
      await s.markDelivered(cur.leaseId, t + 2);
      t += 10;
      cur = await s.acquire(100 + i, t, OPTS);
    }
    const st = await s.inspect(t);
    expect(st.fingerprints.length).toBe(LIMITS.fingerprintWindow);
    expect(st.axesUsed.length).toBe(20);
    expect(st.seenUpdateIds.length).toBe(LIMITS.seenUpdateWindow);
  });

  it('release with clearTask records the outcome and drops the task', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, patch('t1'), T0 + 10);
    await s.markDelivered(a.leaseId, T0 + 20);
    const b = await s.acquire(2, T0 + 30, OPTS);
    if (b.kind !== 'acquired') throw new Error(b.kind);
    await s.release(b.leaseId, {
      clearTask: true,
      previous: { task: 't1', answer: 'poszła', userAnswer: 'poszli', explanation: 'x' },
      outcome: { counted: true, onTarget: false, missCellKey: 'форма=on' },
    }, T0 + 40);
    const st = await s.inspect(T0 + 50);
    expect(st.current).toBeNull();
    expect(st.previous?.userAnswer).toBe('poszli');
    expect(st.stats.total).toBe(1);
    expect(st.lease).toBeNull();
  });

  it('stop returns a summary with the worst cells', async () => {
    const s = stub();
    const a = await s.selectTopic(1, 'czas-przeszly', T0, OPTS);
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await s.commitTask(a.leaseId, a.epoch, { ...patch('t1'), outcome: { counted: true, onTarget: false, missCellKey: 'форма=oni' } }, T0 + 10);
    await s.markDelivered(a.leaseId, T0 + 20);
    const r = await s.stop(2, T0 + 30);
    expect(r).toEqual({ kind: 'stopped', summary: { total: 1, correct: 0, worstCells: [{ cellKey: 'форма=oni', misses: 1 }] } });
    expect((await s.stop(3, T0 + 40)).kind).toBe('no-topic');
  });
});

describe('nextUtcMidnight', () => {
  it('returns the next 00:00 UTC strictly after now', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 8, 11, 12))).toBe(Date.UTC(2026, 8, 12));
    expect(nextUtcMidnight(Date.UTC(2026, 8, 12))).toBe(Date.UTC(2026, 8, 13));
  });
});
