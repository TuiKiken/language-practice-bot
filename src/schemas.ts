// Strict Structured Outputs schemas and runtime guards (spec §5 "Схемы"). Pure.
// Rules: every property required, additionalProperties: false, no minLength/maxLength.
import type { CheckResult, GeneratedTask, Topic, Verdict } from './types.ts';

export type JsonSchema = Record<string, unknown>;

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

const STRING: JsonSchema = { type: 'string' };
const BOOLEAN: JsonSchema = { type: 'boolean' };

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function generationSchema(topic: Topic): JsonSchema {
  const axisProps: Record<string, JsonSchema> = {};
  for (const axis of Object.keys(topic.axes).sort()) {
    axisProps[axis] = { type: 'string', enum: topic.axes[axis] };
  }
  return object({
    task: STRING,
    answer: STRING,
    exact: BOOLEAN,
    axes: object(axisProps),
    fingerprint: STRING,
  });
}

export const CHECK_SCHEMA: JsonSchema = object({
  on_target: BOOLEAN,
  correct: STRING,
  explanation: STRING,
  note: STRING,
});

export const EXPLAIN_SCHEMA: JsonSchema = object({
  explanation: STRING,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: Record<string, unknown>, key: string, nonEmpty: boolean): string {
  const x = v[key];
  if (typeof x !== 'string') throw new SchemaMismatchError(`${key} must be a string`);
  if (nonEmpty && x.trim() === '') throw new SchemaMismatchError(`${key} must not be empty`);
  return x;
}

function bool(v: Record<string, unknown>, key: string): boolean {
  const x = v[key];
  if (typeof x !== 'boolean') throw new SchemaMismatchError(`${key} must be a boolean`);
  return x;
}

export function parseGenerated(value: unknown, topic: Topic): GeneratedTask {
  if (!isRecord(value)) throw new SchemaMismatchError('generation output is not an object');
  const axesRaw = value['axes'];
  if (!isRecord(axesRaw)) throw new SchemaMismatchError('axes must be an object');
  const axes: Record<string, string> = {};
  for (const axis of Object.keys(topic.axes)) {
    const v = axesRaw[axis];
    if (typeof v !== 'string' || !(topic.axes[axis] ?? []).includes(v)) {
      throw new SchemaMismatchError(`axes.${axis} has an unknown value`);
    }
    axes[axis] = v;
  }
  return {
    task: str(value, 'task', true),
    answer: str(value, 'answer', true),
    exact: bool(value, 'exact'),
    axes,
    fingerprint: str(value, 'fingerprint', false),
  };
}

export function parseCheck(value: unknown): CheckResult {
  if (!isRecord(value)) throw new SchemaMismatchError('check output is not an object');
  return {
    on_target: bool(value, 'on_target'),
    correct: str(value, 'correct', false),
    explanation: str(value, 'explanation', false),
    note: str(value, 'note', false),
  };
}

export function parseExplain(value: unknown): string {
  if (!isRecord(value)) throw new SchemaMismatchError('explain output is not an object');
  return str(value, 'explanation', true);
}

/** Spec §5: the verdict is derived in code, never decided by the model. */
export function deriveVerdict(check: CheckResult): Verdict {
  if (!check.on_target) return 'incorrect';
  return check.note.trim() === '' ? 'correct' : 'partial';
}
