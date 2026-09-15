import { describe, expect, it } from 'vitest';
import { axesMatch, cellKey, cellsOf, describeCell, findTopic, leastRecentlyUsed, menuOrder, pickCell, windowSize } from '../src/topics.ts';
import type { Topic } from '../src/types.ts';

function topicWith(axes: Record<string, string[]>): Topic {
  return {
    id: 't', title: 'T', description: 'd', generation: 'g', checking: 'c',
    axes, commonMistakes: null, examples: null, lesson: null,
  };
}

const FOUR = topicWith({ форма: ['on', 'ona'], лексика: ['дом', 'работа'] });

describe('cellsOf / cellKey', () => {
  it('builds the cartesian product', () => {
    expect(cellsOf(FOUR).map(cellKey).sort()).toEqual([
      'лексика=дом|форма=on', 'лексика=дом|форма=ona', 'лексика=работа|форма=on', 'лексика=работа|форма=ona',
    ]);
  });
  it('returns no cells for a topic without axes', () => {
    expect(cellsOf(topicWith({}))).toEqual([]);
    expect(cellKey({})).toBe('');
  });
  it('describes a key for humans', () => {
    expect(describeCell('лексика=дом|форма=on')).toBe('лексика: дом, форма: on');
  });
});

describe('windowSize', () => {
  it('is min(20, cells − 1)', () => {
    expect(windowSize(4)).toBe(3);
    expect(windowSize(30)).toBe(20);
    expect(windowSize(1)).toBe(0);
    expect(windowSize(0)).toBe(0);
  });
});

describe('pickCell', () => {
  it('never returns a cell inside the window', () => {
    const used = ['лексика=дом|форма=on', 'лексика=дом|форма=ona', 'лексика=работа|форма=on'];
    for (let i = 0; i < 50; i++) {
      const picked = cellKey(pickCell(FOUR, used, {}, Math.random));
      expect(picked).toBe('лексика=работа|форма=ona');
    }
  });
  it('does not jam on a four-cell topic: the one cell outside the window is chosen', () => {
    const used = ['лексика=дом|форма=on', 'лексика=дом|форма=ona', 'лексика=работа|форма=on', 'лексика=работа|форма=ona'];
    // window is 3, so the oldest one is eligible again
    expect(cellKey(pickCell(FOUR, used, {}, () => 0))).toBe('лексика=дом|форма=on');
  });
  it('weights cells with misses higher', () => {
    const missy = 'лексика=дом|форма=on';
    let hits = 0;
    const N = 2000;
    let seed = 1;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N; i++) {
      if (cellKey(pickCell(FOUR, [], { [missy]: 3 }, rnd)) === missy) hits++;
    }
    // weight 1+2*3 = 7 vs 1+1+1 → expected share 0.7
    expect(hits / N).toBeGreaterThan(0.6);
    expect(hits / N).toBeLessThan(0.8);
  });
  it('returns the empty cell for a topic without axes', () => {
    expect(pickCell(topicWith({}), [], {}, Math.random)).toEqual({});
  });
  it('single-cell topic keeps returning its only cell', () => {
    const single = topicWith({ форма: ['on'] });
    const axesUsed = ['форма=on'];
    expect(cellKey(pickCell(single, axesUsed, {}, Math.random))).toBe('форма=on');
  });
});

describe('leastRecentlyUsed', () => {
  it('returns the least recent cell from history', () => {
    const twoCell = topicWith({ форма: ['on', 'ona'], лексика: ['дом'] });
    const cells = cellsOf(twoCell);
    const history = ['лексика=дом|форма=on', 'лексика=дом|форма=ona', 'лексика=дом|форма=on'];
    const lru = leastRecentlyUsed(cells, history);
    expect(cellKey(lru)).toBe('лексика=дом|форма=ona');
  });
  it('never-used cell wins over used ones', () => {
    const twoCell = topicWith({ форма: ['on', 'ona'], лексика: ['дом'] });
    const cells = cellsOf(twoCell);
    const history = ['лексика=дом|форма=on'];
    const lru = leastRecentlyUsed(cells, history);
    expect(cellKey(lru)).toBe('лексика=дом|форма=ona');
  });
  it('empty history returns the first cell', () => {
    const twoCell = topicWith({ форма: ['on', 'ona'], лексика: ['дом'] });
    const cells = cellsOf(twoCell);
    const lru = leastRecentlyUsed(cells, []);
    expect(cellKey(lru)).toBe('лексика=дом|форма=on');
  });
});

describe('axesMatch', () => {
  it('requires every requested axis to match', () => {
    expect(axesMatch({ форма: 'on', лексика: 'дом' }, { форма: 'on', лексика: 'дом' })).toBe(true);
    expect(axesMatch({ форма: 'on', лексика: 'дом' }, { форма: 'ona', лексика: 'дом' })).toBe(false);
    expect(axesMatch({}, {})).toBe(true);
  });
});

describe('findTopic', () => {
  it('finds by id', () => {
    expect(findTopic([FOUR], 't')).toBe(FOUR);
    expect(findTopic([FOUR], 'nope')).toBeUndefined();
  });
});

describe('menuOrder', () => {
  const t = (id: string, lesson: number | null): Topic => ({ ...topicWith({}), id, lesson });
  it('puts numbered lessons first, highest lesson on top', () => {
    const entries = [
      { file: '01-a.md', topic: t('a', 3) },
      { file: '02-b.md', topic: t('b', 7) },
      { file: '03-c.md', topic: t('c', 5) },
    ];
    expect(menuOrder(entries).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('puts topics without a lesson after the numbered ones, in reverse file-name order', () => {
    const entries = [
      { file: '01-a.md', topic: t('a', null) },
      { file: '02-b.md', topic: t('b', 4) },
      { file: '03-c.md', topic: t('c', null) },
      { file: '04-d.md', topic: t('d', 2) },
    ];
    expect(menuOrder(entries).map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('breaks a lesson tie by file name, descending', () => {
    const entries = [
      { file: '01-a.md', topic: t('a', 4) },
      { file: '02-b.md', topic: t('b', 4) },
    ];
    expect(menuOrder(entries).map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('does not mutate its input', () => {
    const entries = [{ file: '01-a.md', topic: t('a', null) }, { file: '02-b.md', topic: t('b', null) }];
    menuOrder(entries);
    expect(entries.map((e) => e.topic.id)).toEqual(['a', 'b']);
  });
});
