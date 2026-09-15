import { describe, expect, it } from 'vitest';
import { parseTopic, RULE_MAX, TopicParseError } from '../src/topic-parser.ts';

const FULL = `---
id: czas-przeszly
title: Прошедшее время
---

## Описание
Прошедшее время: выбор окончания по роду, числу и лицу.

## Генерация
Дай польское предложение в прошедшем времени с одним пропуском.

## Проверка
Главное — окончание глагола.

## Вариативность
форма: on, ona, ono, oni (мужское лицо), one (немужское лицо)
лексика: дом, работа, магазин

## Типичные ошибки
Ставят -li там, где нужно -ły.

## Примеры
Wczoraj Anna ___ (iść) do sklepu. → poszła
`;

describe('parseTopic', () => {
  it('parses frontmatter and all sections', () => {
    const t = parseTopic(FULL, '01-czas-przeszly.md');
    expect(t.id).toBe('czas-przeszly');
    expect(t.title).toBe('Прошедшее время');
    expect(t.description).toBe('Прошедшее время: выбор окончания по роду, числу и лицу.');
    expect(t.generation).toContain('одним пропуском');
    expect(t.checking).toBe('Главное — окончание глагола.');
    expect(t.axes).toEqual({
      форма: ['on', 'ona', 'ono', 'oni (мужское лицо)', 'one (немужское лицо)'],
      лексика: ['дом', 'работа', 'магазин'],
    });
    expect(t.commonMistakes).toBe('Ставят -li там, где нужно -ły.');
    expect(t.examples).toBe('Wczoraj Anna ___ (iść) do sklepu. → poszła');
  });

  it('accepts a topic without variability and without examples', () => {
    const src = FULL.replace(/## Вариативность[\s\S]*?(?=## Типичные)/, '').replace(/## Примеры[\s\S]*$/, '');
    const t = parseTopic(src, 'x.md');
    expect(t.axes).toEqual({});
    expect(t.examples).toBeNull();
    expect(t.commonMistakes).not.toBeNull();
  });

  it('rejects a missing required section', () => {
    const src = FULL.replace(/## Проверка[\s\S]*?(?=## Вариативность)/, '');
    expect(() => parseTopic(src, 'x.md')).toThrow(TopicParseError);
    expect(() => parseTopic(src, 'x.md')).toThrow(/Проверка/);
  });

  it('rejects an id outside the pattern', () => {
    const src = FULL.replace('id: czas-przeszly', 'id: Czas_Przeszły');
    expect(() => parseTopic(src, 'x.md')).toThrow(/id/);
  });

  it('parses an optional lesson number and defaults it to null', () => {
    expect(parseTopic(FULL, 'x.md').lesson).toBeNull();
    const src = FULL.replace('title: Прошедшее время', 'title: Прошедшее время\nlesson: 12');
    expect(parseTopic(src, 'x.md').lesson).toBe(12);
  });

  it('rejects a lesson outside 1–9999 or not an integer', () => {
    for (const bad of ['0', 'abc', '1.5', '-3', '', '10000', '99999999999999999999']) {
      const src = FULL.replace('title: Прошедшее время', `title: Прошедшее время\nlesson: ${bad}`);
      expect(() => parseTopic(src, 'x.md'), bad).toThrow(/lesson/);
    }
  });

  it('parses an optional rule section and defaults it to null', () => {
    expect(parseTopic(FULL, 'x.md').rule).toBeNull();
    const src = FULL + '\n## Правило\nОкончание -li только для групп с мужчинами.\n';
    expect(parseTopic(src, 'x.md').rule).toBe('Окончание -li только для групп с мужчинами.');
  });

  it('rejects a rule longer than the limit', () => {
    const src = FULL + '\n## Правило\n' + 'а'.repeat(RULE_MAX + 1) + '\n';
    expect(() => parseTopic(src, 'x.md')).toThrow(/Правило/);
    const ok = FULL + '\n## Правило\n' + 'а'.repeat(RULE_MAX) + '\n';
    expect(parseTopic(ok, 'x.md').rule?.length).toBe(RULE_MAX);
  });

  it('rejects an unknown frontmatter field', () => {
    const src = FULL.replace('title: Прошедшее время', 'title: Прошедшее время\nlevel: A2');
    expect(() => parseTopic(src, 'x.md')).toThrow(/level/);
  });

  it('rejects an unknown section', () => {
    const src = FULL + '\n## Заметки\nчто-то\n';
    expect(() => parseTopic(src, 'x.md')).toThrow(/Заметки/);
  });

  it('rejects an axis without values', () => {
    const src = FULL.replace('лексика: дом, работа, магазин', 'лексика:');
    expect(() => parseTopic(src, 'x.md')).toThrow(/лексика/);
  });

  it('rejects a title longer than 64 characters', () => {
    const src = FULL.replace('title: Прошедшее время', 'title: ' + 'а'.repeat(65));
    expect(() => parseTopic(src, 'x.md')).toThrow(/title/);
  });

  it('reports the file name in the error', () => {
    try {
      parseTopic('no frontmatter', 'broken.md');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TopicParseError);
      expect((e as TopicParseError).fileName).toBe('broken.md');
    }
  });
});
