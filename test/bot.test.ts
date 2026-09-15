import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { classify, handleUpdate, TOPIC_CALLBACK_PREFIX, topicKeyboard } from '../src/bot.ts';
import type { BotDeps } from '../src/bot.ts';
import { LIMITS } from '../src/budget.ts';
import { LlmError } from '../src/llm.ts';
import type { CheckInput, ExplainInput, GenerationInput, LlmClient } from '../src/llm.ts';
import { S } from '../src/strings.ts';
import { TelegramPermanentError, TelegramTransientError } from '../src/telegram.ts';
import type { InlineKeyboardMarkup, TelegramClient } from '../src/telegram.ts';
import type { CheckResult, GeneratedTask, Topic } from '../src/types.ts';

const TOPIC: Topic = {
  id: 'czas-przeszly', title: 'Прошедшее время', description: 'd', generation: 'g', checking: 'c',
  axes: { форма: ['on', 'ona'], лексика: ['дом'] }, commonMistakes: null, examples: null, lesson: null,
};

function gen(task: string, axes = { форма: 'on', лексика: 'дом' }, exact = true): GeneratedTask {
  return { task, answer: 'poszedł', exact, axes, fingerprint: `fp/${task}` };
}
const CHECK_WRONG: CheckResult = { on_target: false, correct: 'poszedł', explanation: 'Он — мужской род.', note: '' };
const CHECK_PARTIAL: CheckResult = { on_target: true, correct: 'poszedł', explanation: '', note: 'пропущен ł' };

function fakeLlm() {
  const calls = { generate: [] as GenerationInput[], check: [] as CheckInput[], explain: [] as ExplainInput[] };
  const queue = { generate: [] as Array<GeneratedTask | Error>, check: [] as Array<CheckResult | Error>, explain: [] as Array<string | Error> };
  let n = 0;
  const take = <T>(q: Array<T | Error>, fallback: () => T): T => {
    const v = q.shift();
    if (v instanceof Error) throw v;
    return v ?? fallback();
  };
  const client: LlmClient = {
    async generateTask(input) { calls.generate.push(input); return take(queue.generate, () => gen(`task-${++n}`, input.cell as { форма: string; лексика: string })); },
    async checkAnswer(input) { calls.check.push(input); return take(queue.check, () => CHECK_WRONG); },
    async explain(input) { calls.explain.push(input); return take(queue.explain, () => 'Подробное объяснение.'); },
  };
  return { client, calls, queue };
}

function fakeTelegram() {
  const sent: Array<{ chatId: number; text: string; markup?: InlineKeyboardMarkup }> = [];
  const callbacks: Array<{ id: string; text?: string }> = [];
  let typing = 0;
  const result = {
    failNextSend: null as Error | null,
    sent, callbacks, typing: () => typing,
    client: undefined as unknown as TelegramClient,
  };
  result.client = {
    async sendMessage(chatId, text, markup) {
      if (result.failNextSend) {
        const err = result.failNextSend;
        result.failNextSend = null;
        throw err;
      }
      sent.push({ chatId, text, markup });
    },
    async answerCallbackQuery(id, text) { callbacks.push({ id, text }); },
    async sendChatAction() { typing++; },
  };
  return result;
}

let chatSeq = 1000;
function harness(over: Partial<BotDeps> = {}) {
  const clock = { t: Date.UTC(2026, 8, 11, 12) };
  const tg = fakeTelegram();
  const llm = fakeLlm();
  const deps: BotDeps = {
    topics: [TOPIC], sessions: env.SESSIONS, telegram: tg.client, llm: llm.client,
    now: () => clock.t, random: () => 0, sleep: () => new Promise((r) => setTimeout(r, 1)),
    dailyLimit: 100, log: () => {}, ...over,
  };
  const chatId = ++chatSeq;
  let updateId = 1;
  const chat = { id: chatId, type: 'private' as const };
  const text = (t: string) => handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat, text: t } }, deps);
  const nonText = () => handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat } }, deps);
  const button = (topicId: string) => handleUpdate({ update_id: updateId++, callback_query: { id: `cb${updateId}`, data: TOPIC_CALLBACK_PREFIX + topicId, message: { message_id: 1, chat } } }, deps);
  const stub = () => env.SESSIONS.get(env.SESSIONS.idFromName(String(chatId)));
  const last = () => tg.sent.at(-1)?.text ?? '';
  return { clock, tg, llm, deps, chatId, text, nonText, button, stub, last, nextUpdateId: () => updateId++ };
}

describe('classify', () => {
  const chat = { id: 1, type: 'private' as const };
  it('maps commands, text, non-text and buttons', () => {
    expect(classify({ update_id: 1, message: { message_id: 1, chat, text: '/start' } })).toMatchObject({ kind: 'command', name: 'topics' });
    expect(classify({ update_id: 1, message: { message_id: 1, chat, text: '/why@polski_bot' } })).toMatchObject({ kind: 'command', name: 'why' });
    expect(classify({ update_id: 1, message: { message_id: 1, chat, text: '/foo' } })).toMatchObject({ kind: 'command', name: 'unknown' });
    expect(classify({ update_id: 1, message: { message_id: 1, chat, text: 'poszła' } })).toMatchObject({ kind: 'text', text: 'poszła' });
    expect(classify({ update_id: 1, message: { message_id: 1, chat } })).toMatchObject({ kind: 'non-text' });
    expect(classify({ update_id: 1, callback_query: { id: 'c', data: 'topic:x', message: { message_id: 1, chat } } })).toMatchObject({ kind: 'topic-button', topicId: 'x' });
    expect(classify({ update_id: 1, callback_query: { id: 'c', data: 'other' } })).toBeNull();
  });
});

describe('topicKeyboard', () => {
  it('prefixes the caption with the lesson number when there is one', () => {
    const rows = topicKeyboard([{ ...TOPIC, lesson: 12 }, TOPIC]).inline_keyboard;
    expect(rows[0]?.[0]?.text).toBe('12. Прошедшее время');
    expect(rows[1]?.[0]?.text).toBe('Прошедшее время');
  });
});

describe('dialogue', () => {
  it('text without a topic shows the topic list with buttons', async () => {
    const h = harness();
    await h.text('привет');
    expect(h.tg.sent[0]!.markup?.inline_keyboard[0]?.[0]).toEqual({ text: 'Прошедшее время', callback_data: 'topic:czas-przeszly' });
  });

  it('choosing a topic answers the callback first and sends the first task', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    expect(h.tg.callbacks.length).toBe(1);
    expect(h.last()).toContain('Прошедшее время');
    expect(h.last()).toContain('task-1');
    expect(h.llm.calls.check.length).toBe(0);
    const st = await h.stub().inspect(h.clock.t);
    expect(st.current?.task).toBe('task-1');
    expect(st.pendingDelivery).toBe(false);
    expect(st.lease).toBeNull();
  });

  it('exact match: no check call, one message with verdict and next task', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('Poszedł ');
    expect(h.llm.calls.check.length).toBe(0);
    expect(h.tg.sent.length).toBe(2);
    expect(h.last()).toContain('Верно');
    expect(h.last()).toContain('task-2');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.stats).toEqual({ total: 1, correct: 1 });
    expect(st.previous?.userAnswer).toBe('Poszedł ');
  });

  it('wrong answer: check call with the target cell, verdict + explanation + next task, miss counted', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('poszła');
    expect(h.llm.calls.check.length).toBe(1);
    expect(h.llm.calls.check[0]!.cell).toEqual({ форма: 'on', лексика: 'дом' });
    expect(h.llm.calls.check[0]!.userAnswer).toBe('poszła');
    expect(h.last()).toContain('Неверно');
    expect(h.last()).toContain('Он — мужской род.');
    expect(h.last()).toContain('task-2');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.missCounts).toEqual({ 'лексика=дом|форма=on': 1 });
    expect(st.stats).toEqual({ total: 1, correct: 0 });
  });

  it('diacritics-only match goes to the model and can end as "almost"', async () => {
    const h = harness();
    h.llm.queue.check.push(CHECK_PARTIAL);
    await h.button('czas-przeszly');
    await h.text('poszedl');
    expect(h.llm.calls.check.length).toBe(1);
    expect(h.last()).toContain('Почти');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.stats).toEqual({ total: 1, correct: 1 });
    expect(st.missCounts).toEqual({});
  });

  it('non-attempt does not consume the task', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('не знаю');
    expect(h.last()).toContain('не похоже на ответ');
    expect(h.llm.calls.generate.length).toBe(1);
    const st = await h.stub().inspect(h.clock.t);
    expect(st.current?.task).toBe('task-1');
    expect(st.lease).toBeNull();
  });

  it('/skip shows the answer, counts a miss and issues the next task', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('/skip');
    expect(h.last()).toContain('Ответ: poszedł');
    expect(h.last()).toContain('task-2');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.stats).toEqual({ total: 1, correct: 0 });
    expect(st.missCounts['лексика=дом|форма=on']).toBe(1);
  });

  it('/repeat resends the current task, /why explains the previous item', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('/repeat');
    expect(h.last()).toBe('task-1');
    await h.text('/why');
    expect(h.last()).toContain('нечего разбирать');
    await h.text('poszła');
    await h.text('/why');
    expect(h.llm.calls.explain.length).toBe(1);
    expect(h.llm.calls.explain[0]!.task).toBe('task-1');
    expect(h.llm.calls.explain[0]!.userAnswer).toBe('poszła');
    expect(h.last()).toBe('Подробное объяснение.');
    expect((await h.stub().inspect(h.clock.t)).lease).toBeNull();
  });

  it('/stop shows the summary and clears the session', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.text('poszła');
    await h.text('/stop');
    expect(h.last()).toContain('заданий 1, верно 0');
    expect(h.last()).toContain('форма: on');
    await h.text('/stop');
    expect(h.last()).toContain('не начата');
  });

  it('/help and non-text messages need no session', async () => {
    const h = harness();
    await h.text('/help');
    expect(h.last()).toContain('/topics');
    await h.nonText();
    expect(h.last()).toContain('текстом');
  });

  it('expired session: text shows the topic list again', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    h.clock.t += LIMITS.sessionTtlMs + 1;
    await h.text('poszedł');
    expect(h.llm.calls.check.length).toBe(0);
    expect(h.last()).toContain('Выбери тему');
  });

  it('daily cap refuses a new exercise', async () => {
    const h = harness({ dailyLimit: 1 });
    await h.button('czas-przeszly');
    await h.text('poszedł');
    expect(h.last()).toContain('Лимит упражнений');
    expect(h.llm.calls.generate.length).toBe(1);
  });

  it('daily cap also refuses /why', async () => {
    const h = harness({ dailyLimit: 1 });
    await h.button('czas-przeszly');
    await h.text('poszła');
    expect(h.last()).toContain('Лимит упражнений');
    await h.text('/why');
    expect(h.last()).toContain('Лимит упражнений');
    expect(h.llm.calls.explain.length).toBe(0);
  });

  it('a button for a removed topic answers the callback and lists topics', async () => {
    const h = harness();
    await h.button('nie-ma');
    expect(h.tg.callbacks[0]!.text).toBe('Тема удалена');
    expect(h.last()).toContain('удалена');
  });

  it('a session whose topic vanished after a deploy is reset', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    h.deps.topics = [];
    await h.text('poszedł');
    expect(h.last()).toContain('удалена');
    expect((await h.stub().inspect(h.clock.t)).topicId).toBeNull();
  });

  it('busy lease: text gets "one second", /stop still passes', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    await h.stub().acquire(h.nextUpdateId(), h.clock.t, { leaseTtlMs: LIMITS.leaseTtlMs, dailyLimit: 100, consumesExercise: true });
    await h.text('poszedł');
    expect(h.last()).toContain('Секунду');
    await h.text('/stop');
    expect(h.last()).toContain('Итог');
  });

  it('pendingDelivery after a dead worker: next update resends the task and is not graded', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    const a = await h.stub().acquire(h.nextUpdateId(), h.clock.t, { leaseTtlMs: LIMITS.leaseTtlMs, dailyLimit: 100, consumesExercise: true });
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await h.stub().commitTask(a.leaseId, a.epoch, {
      next: { task: 'ghost', answer: 'x', exact: true, cellKey: null, axes: {} }, fingerprint: '', markCellUsed: false, previous: null, outcome: null,
    }, h.clock.t);
    h.clock.t += LIMITS.leaseTtlMs + 1;
    await h.text('poszedł');
    expect(h.last()).toContain('ghost');
    expect(h.llm.calls.check.length).toBe(0);
    const st = await h.stub().inspect(h.clock.t);
    expect(st.pendingDelivery).toBe(false);
    expect(st.current?.task).toBe('ghost');
  });

  it('axes mismatch: task is delivered but the cell is not marked used', async () => {
    const h = harness();
    h.llm.queue.generate.push(gen('off-cell', { форма: 'ona', лексика: 'дом' }));
    await h.button('czas-przeszly');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.current?.task).toBe('off-cell');
    expect(st.current?.cellKey).toBeNull();
    expect(st.axesUsed).toEqual([]);
  });

  it('generation fails permanently after a successful check: verdict sent, task cleared, next text restarts', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    h.llm.queue.generate.push(new LlmError('permanent', 'bad key', 401));
    await h.text('poszła');
    expect(h.last()).toContain('Неверно');
    expect(h.last()).toContain('Не удалось составить');
    let st = await h.stub().inspect(h.clock.t);
    expect(st.current).toBeNull();
    expect(st.stats.total).toBe(1);
    await h.text('дальше');
    st = await h.stub().inspect(h.clock.t);
    expect(st.current?.task).toBe('task-2');
  });

  it('check fails: task kept, user asked to resend', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    h.llm.queue.check.push(new LlmError('refusal', 'no'));
    await h.text('poszła');
    expect(h.last()).toContain('Не удалось проверить');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.current?.task).toBe('task-1');
    expect(st.lease).toBeNull();
  });

  it('transient failure is retried once', async () => {
    const h = harness();
    h.llm.queue.generate.push(new LlmError('transient', '503', 503));
    await h.button('czas-przeszly');
    expect(h.llm.calls.generate.length).toBe(2);
    expect(h.last()).toContain('task-1');
  });

  it('quota exhaustion gets its own message', async () => {
    const h = harness();
    h.llm.queue.generate.push(new LlmError('quota', 'insufficient_quota', 429));
    await h.button('czas-przeszly');
    expect(h.last()).toContain('OpenAI');
    expect(h.llm.calls.generate.length).toBe(1);
  });

  it('duplicate update_id is dropped silently', async () => {
    const h = harness();
    const update = { update_id: 999, message: { message_id: 1, chat: { id: h.chatId, type: 'private' as const }, text: '/topics' } };
    await handleUpdate(update, h.deps);
    await handleUpdate(update, h.deps);
    expect(h.tg.sent.length).toBe(1);
  });

  it('transient send failure after commit keeps pendingDelivery and frees the lease', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    const sentBefore = h.tg.sent.length;
    h.tg.failNextSend = new TelegramTransientError('boom');
    await h.text('poszedł');
    expect(h.tg.sent.length).toBe(sentBefore);
    const st = await h.stub().inspect(h.clock.t);
    expect(st.pendingDelivery).toBe(true);
    expect(st.current?.task).toBe('task-2');
    expect(st.lease).toBeNull();
    // The next update takes over and resends immediately instead of hitting `busy`.
    await h.text('anything');
    expect(h.last()).toContain('task-2');
    expect(h.last()).toContain(S.resend);
    expect(h.llm.calls.check.length).toBe(0);
  });

  it('permanent send failure clears the session', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    h.tg.failNextSend = new TelegramPermanentError(403, 'Forbidden: bot was blocked by the user');
    await h.text('poszedł');
    const st = await h.stub().inspect(h.clock.t);
    expect(st.topicId).toBeNull();
  });

  it('a cycle interrupted by /topics does not commit (stale)', async () => {
    const h = harness();
    await h.button('czas-przeszly');
    const a = await h.stub().acquire(h.nextUpdateId(), h.clock.t, { leaseTtlMs: LIMITS.leaseTtlMs, dailyLimit: 100, consumesExercise: true });
    if (a.kind !== 'acquired') throw new Error(a.kind);
    await h.stub().interrupt(h.nextUpdateId(), h.clock.t);
    const committed = await h.stub().commitTask(a.leaseId, a.epoch, {
      next: { task: 'late', answer: 'x', exact: true, cellKey: null, axes: {} }, fingerprint: '', markCellUsed: false, previous: null, outcome: null,
    }, h.clock.t);
    expect(committed).toBe('stale');
  });
});
