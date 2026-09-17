import { describe, expect, it } from 'vitest';
import { createTelegramClient, TelegramPermanentError, TelegramTransientError } from '../src/telegram.ts';

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (next === undefined) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const OK = { status: 200, body: { ok: true, result: {} } };

function client(fetchImpl: typeof fetch) {
  const slept: number[] = [];
  const c = createTelegramClient({ token: 'T0K', fetchImpl, sleep: async (ms) => { slept.push(ms); }, maxRetryAfterMs: 5000 });
  return { c, slept };
}

describe('createTelegramClient', () => {
  it('posts JSON to the method URL as HTML, rendering emphasis and escaping the rest', async () => {
    const { fetchImpl, requests } = fakeFetch([OK]);
    await client(fetchImpl).c.sendMessage(42, 'Форма **kochacie** — *Wy czytacie* & a < b, 2 * 3');
    expect(requests[0]!.url).toBe('https://api.telegram.org/botT0K/sendMessage');
    expect(requests[0]!.body).toEqual({
      chat_id: 42, parse_mode: 'HTML',
      text: 'Форма <b>kochacie</b> — <i>Wy czytacie</i> &amp; a &lt; b, 2 * 3',
    });
  });

  it('renders each chunk on its own so a pair cut by the split stays literal', async () => {
    const { fetchImpl, requests } = fakeFetch([OK, OK]);
    const text = `**${'x'.repeat(4095)}\n${'y'.repeat(10)}**`;
    await client(fetchImpl).c.sendMessage(1, text);
    expect(requests.length).toBe(2);
    for (const r of requests) expect(String(r.body['text'])).not.toContain('<b>');
  });

  it('splits long text and attaches the keyboard to the last chunk only', async () => {
    const { fetchImpl, requests } = fakeFetch([OK, OK, OK]);
    const kb = { inline_keyboard: [[{ text: 'A', callback_data: 'topic:a' }]] };
    await client(fetchImpl).c.sendMessage(1, 'x'.repeat(9000), kb);
    expect(requests.length).toBe(3);
    expect(requests[0]!.body).not.toHaveProperty('reply_markup');
    expect(requests[2]!.body['reply_markup']).toEqual(kb);
  });

  it('waits retry_after on 429 and retries once', async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 2 } } }, OK]);
    const { c, slept } = client(fetchImpl);
    await c.sendMessage(1, 'hi');
    expect(slept).toEqual([2000]);
    expect(requests.length).toBe(2);
  });

  it('gives up on a 429 whose retry_after exceeds the cap', async () => {
    const { fetchImpl } = fakeFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 60 } } }]);
    const { c, slept } = client(fetchImpl);
    await expect(c.sendMessage(1, 'hi')).rejects.toBeInstanceOf(TelegramTransientError);
    expect(slept).toEqual([]);
  });

  it('retries a 5xx once, then fails', async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 502, body: {} }, { status: 502, body: {} }]);
    await expect(client(fetchImpl).c.sendMessage(1, 'hi')).rejects.toBeInstanceOf(TelegramTransientError);
    expect(requests.length).toBe(2);
  });

  it('retries a network failure once', async () => {
    const { fetchImpl, requests } = fakeFetch([new Error('reset'), OK]);
    await client(fetchImpl).c.sendChatAction(1, 'typing');
    expect(requests.length).toBe(2);
  });

  it('never leaks the token from a network error message', async () => {
    const leaking = new Error('fetch failed: https://api.telegram.org/botT0K/sendMessage');
    const { fetchImpl } = fakeFetch([leaking, leaking]);
    const err = await client(fetchImpl).c.sendMessage(1, 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramTransientError);
    expect(err.message).not.toContain('T0K');
  });

  it('403 is permanent and clears the session', async () => {
    const { fetchImpl } = fakeFetch([{ status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }]);
    const err = await client(fetchImpl).c.sendMessage(1, 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramPermanentError);
    expect(err.clearsSession).toBe(true);
  });

  it('400 chat not found clears the session, other 400s do not', async () => {
    const a = fakeFetch([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }]);
    const e1 = await client(a.fetchImpl).c.sendMessage(1, 'hi').catch((e) => e);
    expect(e1.clearsSession).toBe(true);
    const b = fakeFetch([{ status: 400, body: { ok: false, description: 'Bad Request: message is too long' } }]);
    const e2 = await client(b.fetchImpl).c.sendMessage(1, 'hi').catch((e) => e);
    expect(e2).toBeInstanceOf(TelegramPermanentError);
    expect(e2.clearsSession).toBe(false);
  });

  it('answerCallbackQuery sends the id and optional text', async () => {
    const { fetchImpl, requests } = fakeFetch([OK]);
    await client(fetchImpl).c.answerCallbackQuery('cb1', 'Тема удалена');
    expect(requests[0]!.url).toContain('/answerCallbackQuery');
    expect(requests[0]!.body).toEqual({ callback_query_id: 'cb1', text: 'Тема удалена' });
  });
});
