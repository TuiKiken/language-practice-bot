import type { SessionObject } from './session.ts';

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENAI_MODEL: string;
  OPENAI_REASONING_EFFORT?: string;
  DAILY_LIMIT_PER_CHAT: string;
  SESSIONS: DurableObjectNamespace<SessionObject>;
}
