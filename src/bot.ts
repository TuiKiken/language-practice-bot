// Dialogue dispatch and the exercise cycle (spec §5–§7, §9). Knows Telegram and the session API,
// nothing about storage layout or markdown.
import { Budget, BudgetExhaustedError, jitteredDelay, LIMITS, withRetry } from './budget.ts';
import { grade, looksLikeAttempt } from './grade.ts';
import { isRetryableLlmError, LlmError } from './llm.ts';
import type { LlmClient } from './llm.ts';
import { deriveVerdict } from './schemas.ts';
import type { Acquired, CommitPatch, Outcome, SessionObject } from './session.ts';
import { formatCycleMessage, formatFirstTask, formatSummary, formatVerdictBlock, S } from './strings.ts';
import { TelegramPermanentError } from './telegram.ts';
import type { InlineKeyboardMarkup, TelegramClient, TelegramUpdate } from './telegram.ts';
import { axesMatch, cellKey, findTopic, pickCell } from './topics.ts';
import type { CheckResult, CurrentTask, PreviousItem, Topic } from './types.ts';

export const TOPIC_CALLBACK_PREFIX = 'topic:';

export interface BotDeps {
  topics: readonly Topic[];
  sessions: DurableObjectNamespace<SessionObject>;
  telegram: TelegramClient;
  llm: LlmClient;
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  dailyLimit: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

type CommandName = 'topics' | 'help' | 'stop' | 'repeat' | 'why' | 'skip' | 'unknown';

export type BotEvent =
  | { kind: 'command'; name: CommandName; chatId: number; updateId: number }
  | { kind: 'text'; text: string; chatId: number; updateId: number }
  | { kind: 'non-text'; chatId: number; updateId: number }
  | { kind: 'topic-button'; topicId: string; callbackId: string; chatId: number; updateId: number };

const COMMANDS: Record<string, CommandName> = {
  start: 'topics', topics: 'topics', help: 'help', stop: 'stop', repeat: 'repeat', why: 'why', skip: 'skip',
};

export function classify(update: TelegramUpdate): BotEvent | null {
  const cb = update.callback_query;
  if (cb) {
    const chatId = cb.message?.chat.id;
    if (chatId === undefined || !cb.data?.startsWith(TOPIC_CALLBACK_PREFIX)) return null;
    return { kind: 'topic-button', topicId: cb.data.slice(TOPIC_CALLBACK_PREFIX.length), callbackId: cb.id, chatId, updateId: update.update_id };
  }
  const msg = update.message;
  if (!msg) return null;
  const base = { chatId: msg.chat.id, updateId: update.update_id };
  if (msg.text === undefined) return { kind: 'non-text', ...base };
  const m = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s|$)/.exec(msg.text);
  if (m) return { kind: 'command', name: COMMANDS[(m[1] as string).toLowerCase()] ?? 'unknown', ...base };
  return { kind: 'text', text: msg.text, ...base };
}

export function topicCaption(topic: Topic): string {
  return topic.lesson === null ? topic.title : `${topic.lesson}. ${topic.title}`;
}

export function topicKeyboard(topics: readonly Topic[]): InlineKeyboardMarkup {
  return { inline_keyboard: topics.map((t) => [{ text: topicCaption(t), callback_data: `${TOPIC_CALLBACK_PREFIX}${t.id}` }]) };
}

interface Ctx {
  deps: BotDeps;
  stub: ReturnType<BotDeps['sessions']['get']>;
  chatId: number;
  updateId: number;
}

type CycleAction = { kind: 'first' } | { kind: 'skip' } | { kind: 'answer'; text: string };

export async function handleUpdate(update: TelegramUpdate, deps: BotDeps): Promise<void> {
  const event = classify(update);
  if (!event) return;
  const stub = deps.sessions.get(deps.sessions.idFromName(String(event.chatId)));
  const ctx: Ctx = { deps, stub, chatId: event.chatId, updateId: event.updateId };
  try {
    switch (event.kind) {
      case 'command':
        return await onCommand(ctx, event.name);
      case 'text':
        return await startExercise(ctx, { kind: 'answer', text: event.text });
      case 'non-text':
        return await send(ctx, S.sendText);
      case 'topic-button':
        return await onTopicButton(ctx, event.topicId, event.callbackId);
    }
  } catch (error) {
    if (error instanceof TelegramPermanentError) {
      deps.log('telegram_permanent', { status: error.status, clearsSession: error.clearsSession });
      if (error.clearsSession) await stub.reset(deps.now()).catch(() => {});
      return;
    }
    deps.log('update_failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    await send(ctx, S.storageUnavailable).catch(() => {});
  }
}

// --- helpers ---------------------------------------------------------------------------------

async function send(ctx: Ctx, text: string, markup?: InlineKeyboardMarkup): Promise<void> {
  await ctx.deps.telegram.sendMessage(ctx.chatId, text, markup);
}

async function sendTopicList(ctx: Ctx, header: string): Promise<void> {
  await send(ctx, header, topicKeyboard(ctx.deps.topics));
}

function acquireOptions(ctx: Ctx, consumesExercise: boolean) {
  return { leaseTtlMs: LIMITS.leaseTtlMs, dailyLimit: ctx.deps.dailyLimit, consumesExercise };
}

function describeLlmError(error: unknown): string {
  if (error instanceof BudgetExhaustedError) return S.llmTransient;
  if (!(error instanceof LlmError)) return S.llmPermanent;
  switch (error.kind) {
    case 'quota': return S.llmQuota;
    case 'permanent': return S.llmPermanent;
    case 'transient': return S.llmTransient;
    default: return S.llmUnusable;
  }
}

function callModel<T>(ctx: Ctx, budget: Budget, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withRetry(fn, {
    budget,
    callTimeoutMs: LIMITS.modelCallTimeoutMs,
    reserveMs: LIMITS.sendReserveMs,
    maxAttempts: 2,
    shouldRetry: isRetryableLlmError,
    delayMs: (attempt) => jitteredDelay(attempt, ctx.deps.random),
    sleep: ctx.deps.sleep,
  });
}

/** Keeps the "typing…" indicator alive until the returned function is called (spec §7). */
function startTyping(ctx: Ctx): () => void {
  let stopped = false;
  let release: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => { release = resolve; });
  void (async () => {
    while (!stopped) {
      await ctx.deps.telegram.sendChatAction(ctx.chatId, 'typing').catch(() => {});
      await Promise.race([stopSignal, ctx.deps.sleep(LIMITS.typingIntervalMs)]);
    }
  })();
  return () => { stopped = true; release(); };
}

async function resendPending(ctx: Ctx, acquired: Acquired): Promise<void> {
  const task = acquired.state.current?.task ?? '';
  await send(ctx, `${S.resend}\n${task}`);
  await ctx.stub.markDelivered(acquired.leaseId, ctx.deps.now());
}

// --- commands --------------------------------------------------------------------------------

async function onCommand(ctx: Ctx, name: CommandName): Promise<void> {
  const now = ctx.deps.now();
  switch (name) {
    case 'topics': {
      if ((await ctx.stub.interrupt(ctx.updateId, now)) === 'duplicate') return;
      return sendTopicList(ctx, S.chooseTopic);
    }
    case 'help':
    case 'unknown':
      return send(ctx, S.help);
    case 'stop': {
      const r = await ctx.stub.stop(ctx.updateId, now);
      if (r.kind === 'duplicate') return;
      if (r.kind === 'no-topic') return sendTopicList(ctx, `${S.noSession}\n${S.chooseTopic}`);
      return send(ctx, formatSummary(r.summary));
    }
    case 'repeat': {
      const st = await ctx.stub.inspect(now);
      if (st.topicId === null) return sendTopicList(ctx, S.chooseTopic);
      if (st.current === null) return send(ctx, S.noTaskYet);
      return send(ctx, st.current.task);
    }
    case 'why':
      return onWhy(ctx);
    case 'skip':
      return startExercise(ctx, { kind: 'skip' });
  }
}

async function onTopicButton(ctx: Ctx, topicId: string, callbackId: string): Promise<void> {
  const topic = findTopic(ctx.deps.topics, topicId);
  if (!topic) {
    await ctx.deps.telegram.answerCallbackQuery(callbackId, S.topicRemovedCallback).catch(() => {});
    return sendTopicList(ctx, S.topicRemoved);
  }
  // Acknowledge immediately, before any model call (spec §7).
  await ctx.deps.telegram.answerCallbackQuery(callbackId).catch(() => {});
  const r = await ctx.stub.selectTopic(ctx.updateId, topic.id, ctx.deps.now(), acquireOptions(ctx, true));
  if (r.kind === 'duplicate' || r.kind === 'busy') return;
  if (r.kind === 'daily-limit') return send(ctx, S.dailyLimit);
  return runCycle(ctx, r, topic, { kind: 'first' });
}

async function onWhy(ctx: Ctx): Promise<void> {
  const now = ctx.deps.now();
  const r = await ctx.stub.acquire(ctx.updateId, now, acquireOptions(ctx, false));
  if (r.kind === 'duplicate') return;
  if (r.kind === 'busy') return send(ctx, S.oneSecond);
  if (r.kind === 'daily-limit') return send(ctx, S.dailyLimit);
  const { state, leaseId } = r;
  if (state.pendingDelivery && state.current) return resendPending(ctx, r);
  const topic = state.topicId === null ? undefined : findTopic(ctx.deps.topics, state.topicId);
  if (!topic) {
    await ctx.stub.release(leaseId, null, ctx.deps.now());
    return sendTopicList(ctx, S.chooseTopic);
  }
  const previous = state.previous;
  if (!previous) {
    await ctx.stub.release(leaseId, null, ctx.deps.now());
    return send(ctx, S.nothingToExplain);
  }
  const budget = new Budget(ctx.deps.now, now + LIMITS.cycleBudgetMs);
  const stopTyping = startTyping(ctx);
  try {
    // Only the model call is treated as an LLM failure; a Telegram error from `send` below
    // must propagate to handleUpdate's TelegramPermanentError handling untouched.
    let text: string;
    try {
      text = await callModel(ctx, budget, (signal) => ctx.deps.llm.explain({
        topic, task: previous.task, reference: previous.answer, userAnswer: previous.userAnswer, previousExplanation: previous.explanation,
      }, signal));
    } catch (error) {
      stopTyping();
      ctx.deps.log('explain_failed', { error: String(error) });
      await send(ctx, describeLlmError(error));
      return;
    }
    stopTyping();
    await send(ctx, text);
  } finally {
    await ctx.stub.release(leaseId, null, ctx.deps.now());
  }
}

async function startExercise(ctx: Ctx, action: Exclude<CycleAction, { kind: 'first' }>): Promise<void> {
  const r = await ctx.stub.acquire(ctx.updateId, ctx.deps.now(), acquireOptions(ctx, true));
  if (r.kind === 'duplicate') return;
  if (r.kind === 'busy') return send(ctx, S.oneSecond);
  if (r.kind === 'daily-limit') return send(ctx, S.dailyLimit);
  const { state, leaseId } = r;
  if (state.topicId === null) {
    await ctx.stub.release(leaseId, null, ctx.deps.now());
    return sendTopicList(ctx, S.chooseTopic);
  }
  const topic = findTopic(ctx.deps.topics, state.topicId);
  if (!topic) {
    await ctx.stub.reset(ctx.deps.now());
    return sendTopicList(ctx, S.topicRemoved);
  }
  if (state.pendingDelivery && state.current) return resendPending(ctx, r);
  if (state.current === null) return runCycle(ctx, r, topic, { kind: 'first' });
  if (action.kind === 'answer' && !looksLikeAttempt(action.text)) {
    await ctx.stub.release(leaseId, null, ctx.deps.now());
    return send(ctx, S.sendAgain);
  }
  return runCycle(ctx, r, topic, action);
}

// --- the cycle -------------------------------------------------------------------------------

interface VerdictPart {
  block: string | null;
  skippedAnswer: string | null;
  outcome: Outcome | null;
  previous: PreviousItem | null;
}

function verdictFromCheck(current: CurrentTask, userAnswer: string, check: CheckResult): VerdictPart {
  const verdict = deriveVerdict(check);
  const shown = check.correct.trim() !== '' ? check.correct : current.answer;
  return {
    block: formatVerdictBlock({ verdict, shown, explanation: check.explanation, note: check.note }),
    skippedAnswer: null,
    outcome: { counted: true, onTarget: check.on_target, missCellKey: verdict === 'incorrect' ? current.cellKey : null },
    previous: { task: current.task, answer: current.answer, userAnswer, explanation: check.explanation.trim() || null },
  };
}

function verdictLocalCorrect(current: CurrentTask, userAnswer: string): VerdictPart {
  return {
    block: formatVerdictBlock({ verdict: 'correct', shown: current.answer, explanation: '', note: '' }),
    skippedAnswer: null,
    outcome: { counted: true, onTarget: true, missCellKey: null },
    previous: { task: current.task, answer: current.answer, userAnswer, explanation: null },
  };
}

function verdictSkip(current: CurrentTask): VerdictPart {
  return {
    block: null,
    skippedAnswer: current.answer,
    outcome: { counted: true, onTarget: false, missCellKey: current.cellKey },
    previous: { task: current.task, answer: current.answer, userAnswer: null, explanation: null },
  };
}

const EMPTY_PART: VerdictPart = { block: null, skippedAnswer: null, outcome: null, previous: null };

async function runCycle(ctx: Ctx, acquired: Acquired, topic: Topic, action: CycleAction): Promise<void> {
  const { deps, stub } = ctx;
  const start = deps.now();
  const budget = new Budget(deps.now, start + LIMITS.cycleBudgetMs);
  const { state, leaseId, epoch } = acquired;
  const current = state.current;
  const stopTyping = startTyping(ctx);

  try {
    // 1. Checking side: local fast path or a model call (spec §5).
    let localPart: VerdictPart | null = null;
    let checkPromise: Promise<CheckResult> | null = null;
    if (action.kind === 'answer' && current) {
      const outcome = grade(action.text, current.answer);
      if (current.exact && outcome === 'match') {
        localPart = verdictLocalCorrect(current, action.text);
      } else {
        checkPromise = callModel(ctx, budget, (signal) => deps.llm.checkAnswer({
          topic, cell: current.axes, task: current.task, reference: current.answer, userAnswer: action.text,
        }, signal));
      }
    } else if (action.kind === 'skip' && current) {
      localPart = verdictSkip(current);
    } else {
      localPart = EMPTY_PART;
    }

    // 2. Generation side, in parallel (spec §7). The cell is chosen before the verdict is known (spec §6).
    const cell = pickCell(topic, state.axesUsed, state.missCounts, deps.random);
    const genPromise = callModel(ctx, budget, (signal) => deps.llm.generateTask({
      topic, cell, recentFingerprints: state.fingerprints,
    }, signal));

    const [checkSettled, genSettled] = await Promise.allSettled([checkPromise ?? Promise.resolve(null), genPromise]);

    // 3. Resolve the verdict part.
    let part: VerdictPart;
    if (localPart) {
      part = localPart;
    } else if (checkSettled.status === 'fulfilled' && checkSettled.value && current && action.kind === 'answer') {
      part = verdictFromCheck(current, action.text, checkSettled.value);
    } else {
      // Check failed: keep the task, drop whatever was generated, ask to resend (spec §9).
      const reason = checkSettled.status === 'rejected' ? checkSettled.reason : new Error('no check result');
      deps.log('check_failed', { error: String(reason) });
      await stub.release(leaseId, null, deps.now());
      await send(ctx, `${S.checkFailed}\n${describeLlmError(reason)}`);
      return;
    }

    // 4. Generation failed: send the verdict alone and clear the task (spec §9).
    if (genSettled.status === 'rejected') {
      deps.log('generate_failed', { error: String(genSettled.reason) });
      await stub.release(leaseId, { clearTask: true, previous: part.previous, outcome: part.outcome }, deps.now());
      const verdictText = formatCycleMessage({ verdictBlock: part.block, skippedAnswer: part.skippedAnswer, nextTask: null });
      const tail = action.kind === 'first' ? describeLlmError(genSettled.reason) : `${S.nextTaskFailed}\n${describeLlmError(genSettled.reason)}`;
      await send(ctx, verdictText === '' ? tail : `${verdictText}\n\n${tail}`);
      return;
    }

    // 5. Commit, then send, then mark delivered (spec §7 "Порядок").
    const generated = genSettled.value;
    const matched = axesMatch(cell, generated.axes);
    const next: CurrentTask = {
      task: generated.task, answer: generated.answer, exact: generated.exact,
      cellKey: matched ? cellKey(generated.axes) : null, axes: generated.axes,
    };
    const patch: CommitPatch = { next, fingerprint: generated.fingerprint, markCellUsed: matched, previous: part.previous, outcome: part.outcome };
    const committed = await stub.commitTask(leaseId, epoch, patch, deps.now());
    if (committed === 'stale') {
      deps.log('commit_stale', { leaseId, epoch });
      return;
    }
    const message = action.kind === 'first'
      ? formatFirstTask(topic.title, generated.task)
      : formatCycleMessage({ verdictBlock: part.block, skippedAnswer: part.skippedAnswer, nextTask: generated.task });
    try {
      await send(ctx, message);
    } catch (error) {
      if (error instanceof TelegramPermanentError) throw error; // handled in handleUpdate
      deps.log('send_failed_pending', { error: String(error) });
      // pendingDelivery stays set; free the lease so the next update can resend immediately
      // instead of hitting `busy` for the rest of the lease TTL (spec §7).
      await stub.release(leaseId, null, deps.now());
      return;
    }
    await stub.markDelivered(leaseId, deps.now());
  } finally {
    stopTyping();
  }
}
