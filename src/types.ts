/** A topic as parsed from `topics/NN-<slug>.md` (spec §4). Prose sections are passed verbatim to the model. */
export interface Topic {
  /** Matches /^[a-z0-9-]{1,32}$/; used in callback_data. */
  id: string;
  /** Topic name, 1–64 characters; the button caption is this, prefixed with the lesson number when set. */
  title: string;
  /** `## Описание` — sent to both model calls. */
  description: string;
  /** `## Генерация` — generation instructions. */
  generation: string;
  /** `## Проверка` — checking instructions. */
  checking: string;
  /** `## Вариативность` — axis name → allowed values. Empty object when absent. */
  axes: Record<string, string[]>;
  /** `## Типичные ошибки` — sent to both calls; null when absent. */
  commonMistakes: string | null;
  /** `## Примеры` — sets difficulty; null when absent. */
  examples: string | null;
  /** Frontmatter `lesson` — lesson number, drives menu order and the button prefix; null when absent. */
  lesson: number | null;
}

export interface Manifest {
  topics: Topic[];
}

/** One chosen value per axis. Empty object for topics without axes. */
export type Cell = Record<string, string>;

/** Output of the generation call (spec §5). */
export interface GeneratedTask {
  task: string;
  answer: string;
  exact: boolean;
  axes: Cell;
  fingerprint: string;
}

/** Output of the checking call (spec §5). */
export interface CheckResult {
  on_target: boolean;
  correct: string;
  explanation: string;
  note: string;
}

export type Verdict = 'correct' | 'partial' | 'incorrect';

export interface Lease {
  id: number;
  expiresAt: number;
}

export interface CurrentTask {
  task: string;
  answer: string;
  exact: boolean;
  /** Stable key of the cell the task actually realised; null when the model missed the requested cell. */
  cellKey: string | null;
  axes: Cell;
}

/** What `/why` talks about. */
export interface PreviousItem {
  task: string;
  answer: string;
  userAnswer: string | null;
  explanation: string | null;
}

export interface SessionStats {
  total: number;
  correct: number;
}

export interface SessionState {
  topicId: string | null;
  current: CurrentTask | null;
  previous: PreviousItem | null;
  pendingDelivery: boolean;
  axesUsed: string[];
  missCounts: Record<string, number>;
  stats: SessionStats;
  fingerprints: string[];
  lease: Lease | null;
  leaseSeq: number;
  epoch: number;
  seenUpdateIds: number[];
  updatedAt: number;
  dailyCount: number;
  dailyResetAt: number;
}

export interface SessionSummary {
  total: number;
  correct: number;
  /** Up to three cells with the most misses, descending. */
  worstCells: Array<{ cellKey: string; misses: number }>;
}
