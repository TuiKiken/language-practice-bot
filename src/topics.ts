// Cell selection: exclusion window + miss weighting (spec §6). Pure; randomness injected.
import type { Cell, Topic } from './types.ts';

export const MAX_WINDOW = 20;
export const MISS_WEIGHT = 2;

export function cellsOf(topic: Topic): Cell[] {
  const axes = Object.keys(topic.axes).sort();
  if (axes.length === 0) return [];
  let cells: Cell[] = [{}];
  for (const axis of axes) {
    const values = topic.axes[axis] ?? [];
    cells = cells.flatMap((c) => values.map((v) => ({ ...c, [axis]: v })));
  }
  return cells;
}

export function cellKey(cell: Cell): string {
  return Object.keys(cell)
    .sort()
    .map((k) => `${k}=${cell[k]}`)
    .join('|');
}

export function describeCell(key: string): string {
  if (key === '') return '';
  return key
    .split('|')
    .map((pair) => pair.replace('=', ': '))
    .join(', ');
}

export function windowSize(cellCount: number): number {
  return Math.max(0, Math.min(MAX_WINDOW, cellCount - 1));
}

export function pickCell(
  topic: Topic,
  axesUsed: string[],
  missCounts: Record<string, number>,
  random: () => number,
): Cell {
  const cells = cellsOf(topic);
  if (cells.length === 0) return {};

  const window = new Set(axesUsed.slice(-windowSize(cells.length)));
  let candidates = cells.filter((c) => !window.has(cellKey(c)));
  if (candidates.length === 0) {
    // Every cell is inside the window: take the least recently used one.
    const oldestKey = axesUsed.find((k) => cells.some((c) => cellKey(c) === k));
    const oldest = cells.find((c) => cellKey(c) === oldestKey);
    candidates = oldest ? [oldest] : cells;
  }

  const weights = candidates.map((c) => 1 + MISS_WEIGHT * (missCounts[cellKey(c)] ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i] as number;
    if (r < 0) return candidates[i] as Cell;
  }
  return candidates[candidates.length - 1] as Cell;
}

export function axesMatch(requested: Cell, produced: Cell): boolean {
  return Object.keys(requested).every((axis) => produced[axis] === requested[axis]);
}

export function findTopic(topics: readonly Topic[], id: string): Topic | undefined {
  return topics.find((t) => t.id === id);
}
