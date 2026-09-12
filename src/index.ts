// Worker entry (spec §8): secret → chat type → immediate 200 → work in waitUntil.
import { handleUpdate } from './bot.ts';
import type { BotDeps } from './bot.ts';
import { LIMITS } from './budget.ts';
import type { Env } from './env.ts';
import { createLlmClient } from './llm.ts';
import type { LlmConfig } from './llm.ts';
import { createTelegramClient } from './telegram.ts';
import type { TelegramUpdate } from './telegram.ts';
import manifest from './topics.generated.json';
import type { Manifest } from './types.ts';

export { SessionObject } from './session.ts';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const TOPICS = (manifest as Manifest).topics;

export function chatTypeOf(update: TelegramUpdate): string | null {
  return update.message?.chat.type ?? update.callback_query?.message?.chat.type ?? null;
}

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** `omit` leaves the parameter out entirely; unknown values fall back to `none` (cheapest, and every reasoning model accepts it). */
export function reasoningEffort(raw: string | undefined): LlmConfig['reasoningEffort'] {
  const value = (raw ?? 'none').toLowerCase();
  if (value === 'omit') return null;
  return (REASONING_EFFORTS as readonly string[]).includes(value) ? (value as LlmConfig['reasoningEffort']) : 'none';
}

export function buildDeps(env: Env): BotDeps {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const parsedLimit = Number.parseInt(env.DAILY_LIMIT_PER_CHAT, 10);
  return {
    topics: TOPICS,
    sessions: env.SESSIONS,
    telegram: createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl, sleep, maxRetryAfterMs: LIMITS.telegramMaxRetryAfterMs }),
    llm: createLlmClient({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, reasoningEffort: reasoningEffort(env.OPENAI_REASONING_EFFORT), fetchImpl }),
    now: () => Date.now(),
    random: () => Math.random(),
    sleep,
    dailyLimit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 150,
    // Structured log line; never include tokens, secrets or message bodies (spec §9).
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return new Response('ok');
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || request.headers.get(SECRET_HEADER) !== secret) return new Response('forbidden', { status: 403 });

    let update: TelegramUpdate;
    let chatType: string | null;
    try {
      update = (await request.json()) as TelegramUpdate;
      if (typeof update !== 'object' || update === null) throw new Error('not an object');
      // Malformed field shapes (e.g. `message` not an object) can throw inside chatTypeOf;
      // keep the call inside this try so such a body yields 400 instead of an unhandled throw.
      chatType = chatTypeOf(update);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (chatType !== 'private') return new Response('ok');

    ctx.waitUntil(
      handleUpdate(update, buildDeps(env)).catch((error: unknown) => {
        console.log(JSON.stringify({ event: 'unhandled', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
      }),
    );
    return new Response('ok');
  },
} satisfies ExportedHandler<Env>;
