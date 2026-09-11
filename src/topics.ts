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

// Defensive fallback: find the cell whose most recent use is furthest back.
// For each cell, take lastIndexOf in history; never-used cells (−1) win; ties resolve to first in cells order.
// Unreachable while windowSize < cells.length.
export function leastRecentlyUsed(cells: Cell[], axesUsed: string[]): Cell {
  let minIndex = Infinity;
  let result = cells[0] as Cell;
  for (const cell of cells) {
    const key = cellKey(cell);
    const index = axesUsed.lastIndexOf(key);
    if (index < minIndex) {
      minIndex = index;
      result = cell;
    }
  }
  return result;
}

export function pickCell(
  topic: Topic,
  axesUsed: string[],
  missCounts: Record<string, number>,
  random: () => number,
): Cell {
  const cells = cellsOf(topic);
  if (cells.length === 0) return {};

  const size = windowSize(cells.length);
  const window = new Set(size > 0 ? axesUsed.slice(-size) : []);
  let candidates = cells.filter((c) => !window.has(cellKey(c)));
  if (candidates.length === 0) {
    // Every cell is inside the window: take the least recently used one.
    candidates = [leastRecentlyUsed(cells, axesUsed)];
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
