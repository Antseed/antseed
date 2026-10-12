import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  value: undefined as unknown,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
  mounted: false,
}));

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useState: (initial: () => unknown) => {
    if (!hooks.mounted) hooks.value = initial();
    return [hooks.value, (next: unknown) => { hooks.value = typeof next === 'function' ? next(hooks.value) : next; }];
  },
  useRef: (value: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: value };
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (!hooks.mounted) hooks.effects.push(effect);
  },
}));

let data: typeof import('./data');
let IndexerSyncingError: typeof import('../../src/read-state')['IndexerSyncingError'];
let cleanups: Array<() => void>;
let resolveRead: (value: number) => void;
let rejectRead: (error: Error) => void;
let fetcher: ReturnType<typeof vi.fn<() => Promise<number>>>;

function render(key = 'rewards', options = {}) {
  hooks.refIndex = 0;
  const result = data.usePageData(key, fetcher, 300_000, options);
  if (!hooks.mounted) {
    hooks.mounted = true;
    for (const effect of hooks.effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
  }
  return result;
}

beforeEach(async () => {
  vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('window', globalThis);
  vi.resetModules();
  hooks.value = undefined;
  hooks.refs = [];
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.mounted = false;
  cleanups = [];
  data = await import('./data');
  ({ IndexerSyncingError } = await import('../../src/read-state'));
  fetcher = vi.fn(() => new Promise<number>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
  render();
  resolveRead(100);
  await Promise.resolve();
});

afterEach(() => { for (const cleanup of cleanups) cleanup(); vi.unstubAllGlobals(); });

describe('partial seller data', () => {
  const options = { isPartial: (value: number) => value < 0, retryOnError: false };
  const renderPools = () => render('pools', options);
  const remount = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    hooks.mounted = false;
    hooks.refs = [];
    hooks.effects = [];
    return renderPools();
  };

  it('shows loading until settlement, preserves the complete list on partial failure, and recovers', async () => {
    remount();
    expect(renderPools()).toMatchObject({ data: null, loading: true, partial: false, error: null });
    resolveRead(200);
    await new Promise(resolve => setImmediate(resolve));
    renderPools().refresh();
    expect(renderPools()).toMatchObject({ data: 200, loading: true, partial: false });
    resolveRead(-1);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: 200, loading: false, partial: true, error: null });
    renderPools().refresh();
    expect(renderPools()).toMatchObject({ data: 200, loading: true, partial: true });
    resolveRead(300);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: 300, loading: false, partial: false });
  });

  it('shows partial own-pool data if no complete list exists and revalidates immediately on return', async () => {
    remount();
    resolveRead(-1);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: -1, loading: false, partial: true });
    const previousCalls = fetcher.mock.calls.length;
    expect(remount()).toMatchObject({ data: -1, partial: true });
    expect(fetcher).toHaveBeenCalledTimes(previousCalls + 1);
    expect(renderPools()).toMatchObject({ data: -1, loading: true, partial: true });
    resolveRead(300);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: 300, partial: false });
  });

  it('never retains a previous wallet list after a wallet switch or late completion', async () => {
    remount();
    resolveRead(200);
    await new Promise(resolve => setImmediate(resolve));
    renderPools().refresh();
    const finishPreviousWallet = resolveRead;
    data.invalidateAll({ clear: true });
    finishPreviousWallet(250);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: null, loading: true, partial: false });
    resolveRead(-1);
    await new Promise(resolve => setImmediate(resolve));
    expect(renderPools()).toMatchObject({ data: -1, loading: false, partial: true });
  });

  it('keeps revalidating a successful read that is still waiting on wallet figures', async () => {
    const syncingOptions = { isSyncing: (value: number) => value === 7 };
    const mount = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      hooks.mounted = false;
      hooks.refs = [];
      hooks.effects = [];
      return render('pools', syncingOptions);
    };
    mount();
    resolveRead(7);
    await new Promise(resolve => setImmediate(resolve));
    expect(render('pools', syncingOptions)).toMatchObject({ data: 7, reconciling: true, loading: false });
    expect(mount()).toMatchObject({ data: 7, reconciling: true });
    expect(render('pools', syncingOptions)).toMatchObject({ loading: true });
    resolveRead(8);
    await new Promise(resolve => setImmediate(resolve));
    expect(render('pools', syncingOptions)).toMatchObject({ data: 8, reconciling: false });
  });

  it('preserves the partial marker on a retained full list across navigation', async () => {
    remount();
    resolveRead(200);
    await new Promise(resolve => setImmediate(resolve));
    renderPools().refresh();
    resolveRead(-1);
    await new Promise(resolve => setImmediate(resolve));
    expect(remount()).toMatchObject({ data: 200, partial: true });
    expect(renderPools()).toMatchObject({ data: 200, loading: true, partial: true });
  });
});

describe('post-confirmation data refresh', () => {
  it('retains the last snapshot during indexer lag and replaces it only after a successful refresh', async () => {
    data.invalidateAll({ confirmed: true });
    rejectRead(new IndexerSyncingError());
    await new Promise(resolve => setImmediate(resolve));
    expect(render()).toMatchObject({ data: 100, error: null, loading: false, reconciling: true });
    render().refresh();
    expect(render()).toMatchObject({ data: 100, error: null, loading: true, reconciling: true });
    resolveRead(50);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 50, error: null, loading: false, reconciling: false });
  });

  it('does not restore an old account snapshot when the new account is syncing', async () => {
    data.invalidateAll({ clear: true });
    rejectRead(new IndexerSyncingError());
    await new Promise(resolve => setImmediate(resolve));
    expect(render()).toMatchObject({ data: null, error: null, loading: false, reconciling: true });
  });

  it('retains the syncing marker when navigating away and back', async () => {
    data.invalidateAll();
    rejectRead(new IndexerSyncingError());
    await new Promise(resolve => setImmediate(resolve));
    for (const cleanup of cleanups.splice(0)) cleanup();
    hooks.mounted = false;
    hooks.refs = [];
    hooks.effects = [];
    expect(render()).toMatchObject({ data: 100, error: null, reconciling: true });
    expect(render()).toMatchObject({ data: 100, error: null, reconciling: true, loading: true });
  });

  it('does not reconcile balances for ordinary focus or cache refreshes', () => {
    data.invalidateAll();
    expect(render()).toMatchObject({ data: 100, loading: true, reconciling: false });
  });

  it('reconciles only confirmed changes and finishes when fresh data arrives', async () => {
    data.invalidateAll({ confirmed: true });
    expect(render()).toMatchObject({ data: 100, loading: true, reconciling: true });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, loading: false, reconciling: false });
  });

  it('preserves reconciliation after failure and during manual retry', async () => {
    data.invalidateAll({ confirmed: true });
    rejectRead(new Error('RPC unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    expect(render()).toMatchObject({ data: 100, loading: false, reconciling: true, error: 'RPC unavailable' });
    render().refresh();
    expect(render()).toMatchObject({ loading: true, reconciling: true, error: null });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, loading: false, reconciling: false });
  });

  it('does not let a background read erase pending confirmed changes', async () => {
    data.invalidateAll();
    const resolveBackground = resolveRead;
    data.invalidateAll({ confirmed: true });
    resolveBackground(100);
    await Promise.resolve();
    expect(render()).toMatchObject({ loading: true, reconciling: true });
    data.invalidateAll();
    expect(render()).toMatchObject({ loading: true, reconciling: true });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, reconciling: false });
  });

  it('clears reconciliation and old balances on wallet changes', () => {
    data.invalidateAll({ confirmed: true });
    data.invalidateAll({ clear: true });
    expect(render()).toMatchObject({ data: null, loading: true, reconciling: false });
  });
});

describe('automatic sync checks', () => {
  function fakeDocument(visibilityState: DocumentVisibilityState) {
    const listeners = new Set<() => void>();
    return {
      visibilityState,
      addEventListener: (_event: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener); },
      fire() { for (const listener of [...listeners]) listener(); },
      listeners,
    };
  }

  it('re-reads after the poll interval while visible, once', () => {
    vi.useFakeTimers();
    try {
      const doc = fakeDocument('visible');
      const reload = vi.fn();
      data.scheduleSyncCheck(reload, doc as unknown as Document, globalThis as unknown as Window);
      vi.advanceTimersByTime(data.SYNC_POLL_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      doc.fire();
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('waits for a hidden tab to become visible and stops after cleanup', () => {
    vi.useFakeTimers();
    try {
      const doc = fakeDocument('hidden');
      const reload = vi.fn();
      const stop = data.scheduleSyncCheck(reload, doc as unknown as Document, globalThis as unknown as Window);
      vi.advanceTimersByTime(data.SYNC_POLL_MS * 5);
      expect(reload).not.toHaveBeenCalled();
      doc.visibilityState = 'visible';
      doc.fire();
      expect(reload).toHaveBeenCalledOnce();
      const again = vi.fn();
      const stopAgain = data.scheduleSyncCheck(again, doc as unknown as Document, globalThis as unknown as Window);
      stopAgain();
      vi.advanceTimersByTime(data.SYNC_POLL_MS);
      expect(again).not.toHaveBeenCalled();
      expect(doc.listeners.size).toBe(1);
      stop();
      expect(doc.listeners.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
