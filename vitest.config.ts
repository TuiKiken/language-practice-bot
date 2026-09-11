import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: 'test-token',
          OPENAI_API_KEY: 'test-key',
          TELEGRAM_WEBHOOK_SECRET: 'test-secret',
          OPENAI_MODEL: 'test-model',
          DAILY_LIMIT_PER_CHAT: '5',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
