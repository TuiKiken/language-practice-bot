import { describe, expect, it } from 'vitest';
import {
  CHECK_SCHEMA, EXPLAIN_SCHEMA, deriveVerdict, generationSchema,
  parseCheck, parseExplain, parseGenerated, SchemaMismatchError,
} from '../src/schemas.ts';
import type { Topic } from '../src/types.ts';

const TOPIC: Topic = {
  id: 't', title: 'T', description: 'd', generation: 'g', checking: 'c',
  axes: { форма: ['on', 'ona'], лексика: ['дом'] }, commonMistakes: null, examples: null, lesson: null, rule: null,
};

function walk(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (typeof schema !== 'object' || schema === null) return;
  const node = schema as Record<string, unknown>;
  visit(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
    else walk(v, visit);
  }
}

describe('generationSchema', () => {
  const schema = generationSchema(TOPIC);
  it('is strict: every object closes additionalProperties and requires all properties', () => {
    walk(schema, (node) => {
      if (node['type'] === 'object') {
        expect(node['additionalProperties']).toBe(false);
        const props = Object.keys(node['properties'] as Record<string, unknown>);
        expect((node['required'] as string[]).sort()).toEqual(props.sort());
      }
    });
  });
  it('turns axes into enums', () => {
    const axes = (schema['properties'] as Record<string, Record<string, unknown>>)['axes'] as Record<string, unknown>;
    const props = axes['properties'] as Record<string, Record<string, unknown>>;
    expect(props['форма']?.['enum']).toEqual(['on', 'ona']);
    expect(props['лексика']?.['enum']).toEqual(['дом']);
  });
  it('contains no length keywords', () => {
    walk(schema, (node) => {
      expect(node).not.toHaveProperty('minLength');
      expect(node).not.toHaveProperty('maxLength');
    });
    walk(CHECK_SCHEMA, (node) => expect(node).not.toHaveProperty('maxLength'));
    walk(EXPLAIN_SCHEMA, (node) => expect(node).not.toHaveProperty('maxLength'));
  });
  it('produces an empty axes object for a topic without axes', () => {
    const s = generationSchema({ ...TOPIC, axes: {} });
    const axes = (s['properties'] as Record<string, Record<string, unknown>>)['axes'] as Record<string, unknown>;
    expect(axes['properties']).toEqual({});
    expect(axes['required']).toEqual([]);
  });
});

describe('parseGenerated', () => {
  const good = { task: 'Anna ___ (iść).', answer: 'poszła', exact: true, axes: { форма: 'ona', лексика: 'дом' }, fingerprint: 'iść/ona/dom' };
  it('accepts a well-formed object', () => {
    expect(parseGenerated(good, TOPIC)).toEqual(good);
  });
  it('rejects a missing field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { fingerprint: _f, ...bad } = good;
    expect(() => parseGenerated(bad, TOPIC)).toThrow(SchemaMismatchError);
  });
  it('rejects an axis value outside the topic', () => {
    expect(() => parseGenerated({ ...good, axes: { форма: 'oni', лексика: 'дом' } }, TOPIC)).toThrow(SchemaMismatchError);
  });
  it('rejects an empty task or answer', () => {
    expect(() => parseGenerated({ ...good, answer: '  ' }, TOPIC)).toThrow(SchemaMismatchError);
  });
});

describe('parseCheck / deriveVerdict', () => {
  it('parses and derives the verdict from on_target and note', () => {
    const c = parseCheck({ on_target: true, correct: 'poszła', explanation: '', note: '' });
    expect(deriveVerdict(c)).toBe('correct');
    expect(deriveVerdict({ ...c, note: 'пропущен ł' })).toBe('partial');
    expect(deriveVerdict({ ...c, on_target: false })).toBe('incorrect');
  });
  it('rejects a non-boolean on_target', () => {
    expect(() => parseCheck({ on_target: 'yes', correct: 'a', explanation: 'b', note: '' })).toThrow(SchemaMismatchError);
  });
});

describe('parseExplain', () => {
  it('returns the explanation string', () => {
    expect(parseExplain({ explanation: 'потому что' })).toBe('потому что');
    expect(() => parseExplain({})).toThrow(SchemaMismatchError);
  });
});
