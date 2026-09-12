import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { chatTypeOf, reasoningEffort, SECRET_HEADER } from '../src/index.ts';

// The brief calls for `fetchMock` from 'cloudflare:test' (undici MockAgent) to intercept the
// outbound `sendMessage` call. The installed @cloudflare/vitest-pool-workers (0.22.0) does not
// export it — `dist/worker/lib/cloudflare/test.mjs` only re-exports `env`, `SELF`,
// `createExecutionContext`, `waitOnExecutionContext` and a handful of other helpers; `fetchMock`
// isn't among them (the `.d.ts` still declares the MockAgent/MockInterceptor types, but nothing
// wires them up at runtime in this version). We stub the global `fetch` instead: same intent as
// `disableNetConnect()` (every outbound call is recorded, none are silently allowed to hit the
// network), and we still assert the exact call count/URL rather than dropping the assertion.
let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(body: unknown, secret: string | null = 'test-secret'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers[SECRET_HEADER] = secret;
  return new Request('https://bot.test/', { method: 'POST', headers, body: JSON.stringify(body) });
}

const privateHelp = { update_id: 1, message: { message_id: 1, chat: { id: 7, type: 'private' }, text: '/help' } };
const groupHelp = { update_id: 2, message: { message_id: 1, chat: { id: -100, type: 'supergroup' }, text: '/help' } };

describe('webhook entry', () => {
  it('GET is a health check', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://bot.test/'), env, ctx);
    expect(res.status).toBe(200);
  });

  it('rejects a missing or wrong secret before reading the body', async () => {
    for (const secret of [null, 'wrong']) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(post(privateHelp, secret), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(403);
    }
    expect(calls.length).toBe(0);
  });

  it('rejects a non-JSON body', async () => {
    const ctx = createExecutionContext();
    const req = new Request('https://bot.test/', { method: 'POST', headers: { [SECRET_HEADER]: 'test-secret' }, body: 'nope' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed update body without throwing', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ update_id: 1, message: 5 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('rejects a null body without throwing', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post(null), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('ignores group chats silently', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post(groupHelp), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    // No outbound call should have been made for a non-private chat.
    expect(calls.length).toBe(0);
  });

  it('answers 200 immediately and handles a private update in waitUntil', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post(privateHelp), env, ctx);
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/bottest-token/sendMessage');
  });
});

describe('chatTypeOf', () => {
  it('reads the chat from a message or a callback', () => {
    expect(chatTypeOf({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' } } })).toBe('private');
    expect(chatTypeOf({ update_id: 1, callback_query: { id: 'c', message: { message_id: 1, chat: { id: 1, type: 'group' } } } })).toBe('group');
    expect(chatTypeOf({ update_id: 1 })).toBeNull();
  });
});

describe('reasoningEffort', () => {
  it('passes known levels through, sends none by default, omits only on "omit"', () => {
    expect(reasoningEffort(undefined)).toBe('none');
    expect(reasoningEffort('none')).toBe('none');
    expect(reasoningEffort('Low')).toBe('low');
    expect(reasoningEffort('xhigh')).toBe('xhigh');
    expect(reasoningEffort('omit')).toBeNull();
    expect(reasoningEffort('banana')).toBe('none');
  });
});
