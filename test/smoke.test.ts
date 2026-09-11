import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker boots', () => {
  it('answers GET /', async () => {
    const res = await SELF.fetch('https://bot.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
