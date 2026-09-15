import type { Topic } from './types.ts';

export class TopicParseError extends Error {
  fileName: string;
  constructor(fileName: string, message: string) {
    super(`${fileName}: ${message}`);
    this.name = 'TopicParseError';
    this.fileName = fileName;
  }
}

export const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
export const TITLE_MAX = 64;
/** Keeps the rule message well inside Telegram's 4096-character limit together with its header. */
export const RULE_MAX = 1500;

export const REQUIRED_SECTIONS = ['Описание', 'Генерация', 'Проверка'] as const;
export const KNOWN_SECTIONS = [...REQUIRED_SECTIONS, 'Вариативность', 'Типичные ошибки', 'Примеры', 'Правило'] as const;
const KNOWN_FRONTMATTER = ['id', 'title', 'lesson'] as const;
const LESSON_PATTERN = /^[1-9][0-9]{0,3}$/;

interface Split {
  frontmatter: Record<string, string>;
  sections: Map<string, string>;
}

function splitDocument(source: string, fileName: string): Split {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw new TopicParseError(fileName, 'frontmatter must start with ---');
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new TopicParseError(fileName, 'frontmatter is not closed');

  const frontmatter: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    if (raw.trim() === '') continue;
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (!m) throw new TopicParseError(fileName, `bad frontmatter line: ${raw}`);
    const key = m[1] as string;
    if (!(KNOWN_FRONTMATTER as readonly string[]).includes(key)) {
      throw new TopicParseError(fileName, `unknown frontmatter field: ${key}`);
    }
    frontmatter[key] = (m[2] as string).trim();
  }

  const sections = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name !== null) sections.set(name, buf.join('\n').trim());
  };
  for (const line of lines.slice(end + 1)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      name = h[1] as string;
      if (!(KNOWN_SECTIONS as readonly string[]).includes(name)) {
        throw new TopicParseError(fileName, `unknown section: ${name}`);
      }
      if (sections.has(name)) throw new TopicParseError(fileName, `duplicate section: ${name}`);
      buf = [];
    } else if (name !== null) {
      buf.push(line);
    } else if (line.trim() !== '') {
      throw new TopicParseError(fileName, `text before the first section: ${line}`);
    }
  }
  flush();
  return { frontmatter, sections };
}

function parseAxes(text: string, fileName: string): Record<string, string[]> {
  const axes: Record<string, string[]> = {};
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const idx = raw.indexOf(':');
    if (idx === -1) throw new TopicParseError(fileName, `axis line without colon: ${raw}`);
    const axis = raw.slice(0, idx).trim();
    const values = raw
      .slice(idx + 1)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (axis === '') throw new TopicParseError(fileName, `axis without a name: ${raw}`);
    if (values.length === 0) throw new TopicParseError(fileName, `axis without values: ${axis}`);
    if (axis in axes) throw new TopicParseError(fileName, `duplicate axis: ${axis}`);
    axes[axis] = values;
  }
  return axes;
}

export function parseTopic(source: string, fileName: string): Topic {
  const { frontmatter, sections } = splitDocument(source, fileName);

  const id = frontmatter['id'];
  if (id === undefined || !ID_PATTERN.test(id)) {
    throw new TopicParseError(fileName, `id must match ${ID_PATTERN}, got: ${id ?? '(missing)'}`);
  }
  const title = frontmatter['title'];
  if (title === undefined || title.length === 0 || title.length > TITLE_MAX) {
    throw new TopicParseError(fileName, `title must be 1–${TITLE_MAX} characters`);
  }

  const lessonText = frontmatter['lesson'];
  if (lessonText !== undefined && !LESSON_PATTERN.test(lessonText)) {
    throw new TopicParseError(fileName, `lesson must be an integer from 1 to 9999, got: ${lessonText || '(empty)'}`);
  }

  for (const s of REQUIRED_SECTIONS) {
    const body = sections.get(s);
    if (body === undefined || body === '') throw new TopicParseError(fileName, `missing required section: ${s}`);
  }

  const rule = sections.get('Правило') || null;
  if (rule !== null && rule.length > RULE_MAX) {
    throw new TopicParseError(fileName, `Правило must be at most ${RULE_MAX} characters, got ${rule.length}`);
  }

  const axesText = sections.get('Вариативность');
  return {
    id,
    title,
    description: sections.get('Описание') as string,
    generation: sections.get('Генерация') as string,
    checking: sections.get('Проверка') as string,
    axes: axesText === undefined || axesText === '' ? {} : parseAxes(axesText, fileName),
    commonMistakes: sections.get('Типичные ошибки') || null,
    examples: sections.get('Примеры') || null,
    lesson: lessonText === undefined ? null : Number(lessonText),
    rule,
  };
}
