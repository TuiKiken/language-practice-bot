// Every text the learner sees. Russian by policy. **bold** and *italic* are allowed: the Telegram client
// renders them and escapes everything else (spec §7).
import { LIMITS } from './budget.ts';
import { describeCell } from './topics.ts';
import type { SessionSummary, Verdict } from './types.ts';

export const S = {
  chooseTopic: 'Выбери тему:',
  nextTaskHeader: 'Следующее задание:',
  oneSecond: 'Секунду, ещё думаю над предыдущим ответом.',
  sendText: 'Пришли ответ текстом.',
  sendAgain: 'Это не похоже на ответ. Напиши форму ещё раз — или /skip, если не знаешь.',
  noTaskYet: 'Задания пока нет. Напиши любое сообщение, и я его составлю.',
  nothingToExplain: 'Пока нечего разбирать: ответь на задание, потом спроси /why.',
  topicRemoved: 'Эта тема была удалена. Выбери другую:',
  topicRemovedCallback: 'Тема удалена',
  noSession: 'Тренировка не начата.',
  noRule: 'У этой темы нет отдельного правила.',
  dailyLimit: 'Лимит упражнений на сегодня исчерпан. Он сбросится в полночь по UTC.',
  storageUnavailable: 'Не получилось сохранить состояние. Попробуй ещё раз.',
  resend: 'Повторяю задание:',
  nextTaskFailed: 'Не удалось составить следующее задание. Напиши любое сообщение, и я попробую снова.',
  checkFailed: 'Не удалось проверить ответ. Отправь его ещё раз.',
  llmQuota: 'Лимит расходов OpenAI исчерпан. Бот заработает, когда владелец пополнит баланс.',
  llmPermanent: 'Бот сломан, нужна починка. Владелец увидит ошибку в логах.',
  llmTransient: 'Модель сейчас не отвечает. Попробуй ещё раз через минуту.',
  llmUnusable: 'Не удалось составить задание. Попробуй ещё раз.',
  help: [
    'Тренажёр польского по темам курса.',
    '',
    '/topics — выбрать тему',
    '/repeat — показать текущее задание',
    '/rule — показать правило темы',
    '/why — подробнее разобрать предыдущий ответ',
    '/skip — показать ответ и получить следующее задание',
    '/stop — закончить и увидеть итог',
    '/help — эта справка',
    '',
    'Отвечай текстом: впиши форму, которой не хватает в пропуске ___.',
    'Поставь польскую раскладку: пропущенный ą, ę, ł и другие знаки я отмечу, а если знак меняет форму — засчитаю как ошибку.',
    'Правка уже отправленного сообщения не учитывается — пришли новый ответ.',
    `В сутки на один чат — не больше заданного владельцем числа упражнений; лимит сбрасывается в полночь UTC.`,
    'Тексты заданий и твои ответы обрабатывает OpenAI.',
  ].join('\n'),
} as const;

export function formatVerdictBlock(input: { verdict: Verdict; shown: string; explanation: string; note: string }): string {
  const { verdict, shown, explanation, note } = input;
  if (verdict === 'correct') return `✅ Верно. Эталон: ${shown}`;
  if (verdict === 'partial') {
    const lines = [`🟡 Почти. ${note.trim()}`, `Эталон: ${shown}`];
    if (explanation.trim() !== '') lines.push(explanation.trim());
    return lines.join('\n');
  }
  const lines = [`❌ Неверно. Правильно: ${shown}`];
  if (explanation.trim() !== '') lines.push(explanation.trim());
  if (note.trim() !== '') lines.push(`Ещё: ${note.trim()}`);
  return lines.join('\n');
}

export function formatCycleMessage(parts: { verdictBlock: string | null; skippedAnswer: string | null; nextTask: string | null }): string {
  const blocks: string[] = [];
  if (parts.verdictBlock !== null) blocks.push(parts.verdictBlock);
  if (parts.skippedAnswer !== null) blocks.push(`Ответ: ${parts.skippedAnswer}`);
  if (parts.nextTask !== null) blocks.push(`${S.nextTaskHeader}\n${parts.nextTask}`);
  return blocks.join('\n\n');
}

export function formatRule(topicTitle: string, rule: string): string {
  return `Тема: ${topicTitle}\n\nПравило:\n${rule}`;
}

export function formatFirstTask(topicTitle: string, task: string): string {
  return `Тема: ${topicTitle}\n\n${task}`;
}

export function formatSummary(summary: SessionSummary): string {
  const lines = [`Итог: заданий ${summary.total}, верно ${summary.correct}.`];
  if (summary.worstCells.length > 0) {
    lines.push('Чаще всего промахи:');
    for (const c of summary.worstCells) {
      const label = c.cellKey === '' ? 'без разбивки по осям' : describeCell(c.cellKey);
      lines.push(`— ${label}: ${c.misses}`);
    }
  }
  return lines.join('\n');
}

/** Splits on newlines first, then hard-splits any single line longer than `max` (spec §7, 4096). */
export function splitMessage(text: string, max: number = LIMITS.maxMessageLength): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = '';
  let started = false;
  for (const line of text.split('\n')) {
    const pieces: string[] = [];
    for (let i = 0; i < line.length; i += max) pieces.push(line.slice(i, i + max));
    if (pieces.length === 0) pieces.push('');
    for (const piece of pieces) {
      if (!started) { current = piece; started = true; }
      else if (current.length + 1 + piece.length <= max) current = `${current}\n${piece}`;
      else { out.push(current); current = piece; }
    }
  }
  if (started) out.push(current);
  return out;
}
