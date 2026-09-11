import { describe, expect, it } from 'vitest';
import { formatCycleMessage, formatFirstTask, formatSummary, formatVerdictBlock, S, splitMessage } from '../src/strings.ts';

describe('formatVerdictBlock', () => {
  it('correct: short confirmation with the reference', () => {
    const s = formatVerdictBlock({ verdict: 'correct', shown: 'poszła', explanation: '', note: '' });
    expect(s).toContain('Верно');
    expect(s).toContain('poszła');
  });
  it('partial: shows the note and the reference', () => {
    const s = formatVerdictBlock({ verdict: 'partial', shown: 'cześć', explanation: '', note: 'пропущен знак' });
    expect(s).toContain('Почти');
    expect(s).toContain('пропущен знак');
  });
  it('incorrect: correct form plus explanation', () => {
    const s = formatVerdictBlock({ verdict: 'incorrect', shown: 'poszła', explanation: 'Anna — она', note: '' });
    expect(s).toContain('Неверно');
    expect(s).toContain('poszła');
    expect(s).toContain('Anna — она');
  });
});

describe('formatCycleMessage', () => {
  it('joins verdict and next task in one message', () => {
    const s = formatCycleMessage({ verdictBlock: 'V', skippedAnswer: null, nextTask: 'T' });
    expect(s.indexOf('V')).toBeLessThan(s.indexOf('T'));
    expect(s).toContain(S.nextTaskHeader);
  });
  it('formats a skip', () => {
    const s = formatCycleMessage({ verdictBlock: null, skippedAnswer: 'poszła', nextTask: 'T' });
    expect(s).toContain('poszła');
    expect(s).toContain('T');
  });
  it('omits the next-task header when there is none', () => {
    const s = formatCycleMessage({ verdictBlock: 'V', skippedAnswer: null, nextTask: null });
    expect(s).not.toContain(S.nextTaskHeader);
  });
});

describe('formatFirstTask / formatSummary', () => {
  it('names the topic', () => {
    expect(formatFirstTask('Прошедшее время', 'Anna ___')).toContain('Прошедшее время');
  });
  it('lists the worst cells', () => {
    const s = formatSummary({ total: 10, correct: 7, worstCells: [{ cellKey: 'форма=oni (мужское лицо)|лексика=дом', misses: 2 }] });
    expect(s).toContain('10');
    expect(s).toContain('7');
    expect(s).toContain('форма: oni (мужское лицо)');
  });
  it('handles an empty session', () => {
    expect(formatSummary({ total: 0, correct: 0, worstCells: [] })).toContain('0');
  });
});

describe('splitMessage', () => {
  it('returns short text untouched', () => {
    expect(splitMessage('abc')).toEqual(['abc']);
  });
  it('splits on newlines and never exceeds the limit', () => {
    const line = 'x'.repeat(1000);
    const text = Array(10).fill(line).join('\n'); // 10 009 chars
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n')).toBe(text);
  });
  it('hard-splits a single overlong line', () => {
    const parts = splitMessage('y'.repeat(9000), 4096);
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 808]);
  });
  it('preserves blank lines in the middle', () => {
    const text = 'aaaaaaaaaa\n\nbbbbbbbbbb';
    const parts = splitMessage(text, 10);
    expect(parts.join('\n')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(10);
  });
  it('preserves leading newline before long body', () => {
    const text = '\n' + 'x'.repeat(100);
    const parts = splitMessage(text, 200);
    expect(parts.join('\n')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
  });
  it('keeps short text with blank lines untouched', () => {
    expect(splitMessage('a\n\nb')).toEqual(['a\n\nb']);
  });
});
