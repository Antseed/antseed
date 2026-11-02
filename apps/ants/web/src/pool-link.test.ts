import { describe, expect, it } from 'vitest';
import { linkedPoolId, PoolSelection, poolToOpen } from './pool-link';

describe('linked seller pool', () => {
  it('reads a positive agent id and ignores malformed ones', () => {
    expect(linkedPoolId(new URLSearchParams('pool=956159'))).toBe(956159);
    for (const query of ['', 'pool=', 'pool=0', 'pool=-3', 'pool=12abc', 'pool=1.5']) {
      expect(linkedPoolId(new URLSearchParams(query))).toBeNull();
    }
  });
});

describe('opening a linked pool', () => {
  it('opens each new link once and again after the link is left', () => {
    let last: number | null = null;
    const step = (linked: number | null) => {
      const next = poolToOpen(linked, last);
      last = next.lastOpened;
      return next.open;
    };
    expect(step(1)).toBe(1);
    expect(step(1)).toBeNull(); // a refresh does not reopen a drawer closed by hand
    expect(step(2)).toBe(2); // the query changed while the page stayed mounted
    expect(step(null)).toBeNull();
    expect(step(2)).toBe(2);
  });
});

describe('pool selection', () => {
  it('drops a slow lookup once a newer selection or a close happened', async () => {
    const selection = new PoolSelection();
    let resolveA: (agentId: number) => void = () => {};
    const lookupA = new Promise<number>((resolve) => { resolveA = resolve; });
    const opened: number[] = [];

    const isA = selection.begin();
    void lookupA.then((agentId) => { if (isA()) opened.push(agentId); });
    const isB = selection.begin();
    if (isB()) opened.push(2);
    resolveA(1);
    await lookupA;
    expect(opened).toEqual([2]);

    const isC = selection.begin();
    selection.invalidate();
    expect(isC()).toBe(false);
  });
});
