// Telegram Bot API client and update types (spec §7, §9). Plain text only, transport injected.
import { splitMessage } from './strings.ts';

export interface TelegramChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
export interface TelegramMessage { message_id: number; chat: TelegramChat; text?: string }
export interface TelegramCallbackQuery { id: string; data?: string; message?: TelegramMessage }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
export interface InlineKeyboardMarkup { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

export class TelegramPermanentError extends Error {
  status: number;
  description: string;
  /** 403 (blocked) or "chat not found": the session must be cleared (spec §9). */
  clearsSession: boolean;
  constructor(status: number, description: string) {
    super(`telegram ${status}: ${description}`);
    this.name = 'TelegramPermanentError';
    this.status = status;
    this.description = description;
    this.clearsSession = status === 403 || /chat not found|user is deactivated|bot was blocked/i.test(description);
  }
}

export class TelegramTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramTransientError';
  }
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: 'typing'): Promise<void>;
}

export interface TelegramClientOptions {
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxRetryAfterMs: number;
  apiBase?: string;
}

interface ApiError { ok?: boolean; description?: string; parameters?: { retry_after?: number } }

export function createTelegramClient(opts: TelegramClientOptions): TelegramClient {
  const base = `${opts.apiBase ?? 'https://api.telegram.org'}/bot${opts.token}`;

  async function call(method: string, payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res: Response;
      try {
        res = await opts.fetchImpl(`${base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        if (attempt === 1) continue;
        throw new TelegramTransientError(`network: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.ok) return;
      const body = (await res.json().catch(() => null)) as ApiError | null;
      const description = body?.description ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        const waitMs = (body?.parameters?.retry_after ?? 1) * 1000;
        if (attempt === 1 && waitMs <= opts.maxRetryAfterMs) {
          await opts.sleep(waitMs);
          continue;
        }
        throw new TelegramTransientError(`rate limited: retry_after ${waitMs} ms`);
      }
      if (res.status >= 500) {
        if (attempt === 1) continue;
        throw new TelegramTransientError(description);
      }
      throw new TelegramPermanentError(res.status, description);
    }
  }

  return {
    async sendMessage(chatId, text, replyMarkup) {
      const chunks = splitMessage(text);
      for (let i = 0; i < chunks.length; i++) {
        const payload: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
        if (replyMarkup && i === chunks.length - 1) payload['reply_markup'] = replyMarkup;
        await call('sendMessage', payload);
      }
    },
    async answerCallbackQuery(callbackQueryId, text) {
      const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (text !== undefined) payload['text'] = text;
      await call('answerCallbackQuery', payload);
    },
    async sendChatAction(chatId, action) {
      await call('sendChatAction', { chat_id: chatId, action });
    },
  };
}
