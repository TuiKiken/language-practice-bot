// Loader, not generator (spec §3): reads topics/*.md, validates, writes src/topics.generated.json.
// Runs under Node 24 type stripping: no enums, no parameter properties.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTopic, TopicParseError } from '../src/topic-parser.ts';
import { menuOrder } from '../src/topics.ts';
import type { Manifest, Topic } from '../src/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const topicsDir = join(root, 'topics');
const outFile = join(root, 'src', 'topics.generated.json');

const files = readdirSync(topicsDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

const entries: { file: string; topic: Topic }[] = [];
const errors: string[] = [];
const seenIds = new Map<string, string>();

for (const file of files) {
  try {
    const topic = parseTopic(readFileSync(join(topicsDir, file), 'utf8'), file);
    const firstFile = seenIds.get(topic.id);
    if (firstFile !== undefined) {
      errors.push(`${file}: duplicate id "${topic.id}" (first seen in ${firstFile})`);
      continue;
    }
    seenIds.set(topic.id, file);
    entries.push({ file, topic });
  } catch (e) {
    errors.push(e instanceof TopicParseError ? e.message : `${file}: ${String(e)}`);
  }
}

if (errors.length > 0) {
  for (const line of errors) console.error(`topic error: ${line}`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('topic error: no topics found in topics/');
  process.exit(1);
}

// Menu order is decided here, once; the worker shows topics in manifest order.
const topics = menuOrder(entries);
const manifest: Manifest = { topics };
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`bundled ${topics.length} topic(s) into ${outFile}`);
