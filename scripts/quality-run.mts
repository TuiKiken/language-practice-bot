// Manual quality pass (spec §10). Costs money; never in CI.
//   OPENAI_API_KEY=… OPENAI_MODEL=… node scripts/quality-run.mts [topic-id]
// For every topic: three generated tasks, and for each task the model's verdict on planted answers:
// the reference (must be on target), the reference without diacritics (should be "almost" or on target
// with a note), and a crude wrong form (last letter swapped; should be off target). A valid alternative
// wording cannot be synthesised automatically — judge that one by reading the printed tasks.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../src/llm.ts';
import { deriveVerdict } from '../src/schemas.ts';
import type { Manifest } from '../src/types.ts';

const apiKey = process.env['OPENAI_API_KEY'];
const model = process.env['OPENAI_MODEL'];
if (!apiKey || !model) {
  console.error('usage: OPENAI_API_KEY=… OPENAI_MODEL=… node scripts/quality-run.mts [topic-id]');
  process.exit(2);
}
const only = process.argv[2];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'src', 'topics.generated.json'), 'utf8')) as Manifest;
const llm = createLlmClient({ apiKey, model, reasoningEffort: 'minimal', fetchImpl: (i, init) => fetch(i, init) });

const strip = (s: string) => s.replace(/[ąćęłńóśźż]/gi, (ch) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' })[ch.toLowerCase()] ?? ch);
const mutate = (s: string) => (s.length < 2 ? s + 'a' : s.slice(0, -1) + (s.endsWith('a') ? 'i' : 'a'));
const signal = () => AbortSignal.timeout(30_000);

for (const topic of manifest.topics) {
  if (only && topic.id !== only) continue;
  console.log(`\n=== ${topic.id} — ${topic.title}`);
  const axes = Object.entries(topic.axes);
  const fingerprints: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cell = Object.fromEntries(axes.map(([axis, values]) => [axis, values[i % values.length] as string]));
    const g = await llm.generateTask({ topic, cell, recentFingerprints: fingerprints }, signal());
    fingerprints.push(g.fingerprint);
    console.log(`\n[${i + 1}] cell=${JSON.stringify(cell)} exact=${g.exact}\n    ${g.task}\n    → ${g.answer}`);
    for (const [label, planted] of [['reference', g.answer], ['no-diacritics', strip(g.answer)], ['wrong-form', mutate(g.answer)]] as const) {
      if (planted === g.answer && label !== 'reference') continue;
      const c = await llm.checkAnswer({ topic, cell, task: g.task, reference: g.answer, userAnswer: planted }, signal());
      console.log(`    ${label.padEnd(13)} "${planted}" → ${deriveVerdict(c)} | ${c.correct} | ${c.explanation} ${c.note ? `| note: ${c.note}` : ''}`);
    }
  }
}
