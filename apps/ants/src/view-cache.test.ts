import { describe, expect, it } from 'vitest';
import { ViewCache } from './view-cache.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ViewCache', () => {
  it('shares one load between identical concurrent reads and caches the result', async () => {
    const cache = new ViewCache(60_000);
    let loads = 0;
    const load = async () => { loads += 1; await tick(); return { loads }; };
    const [a, b] = await Promise.all([cache.read('overview', load), cache.read('overview', load)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    expect(await cache.read('overview', load)).toBe(a);
    expect(loads).toBe(1);
  });

  it('serves pools while an unrelated reward read is still blocked', async () => {
    const cache = new ViewCache();
    let finish!: (value: number) => void;
    const slow = cache.read('rewards', () => new Promise<number>(resolve => { finish = resolve; }));
    const fast = cache.read('pools', async () => 'pools ready');
    expect(await fast).toBe('pools ready');
    finish(1);
    expect(await slow).toBe(1);
  });

  it('does not cache failures and keeps serving after one', async () => {
    const cache = new ViewCache();
    await expect(cache.read('rewards', async () => { throw new Error('rpc down'); })).rejects.toThrow('rpc down');
    expect(await cache.read('rewards', async () => 'ok')).toBe('ok');
  });

  it('expires entries after the TTL and on invalidate', async () => {
    const cache = new ViewCache(1);
    let loads = 0;
    const load = async () => ++loads;
    await cache.read('overview', load);
    await tick();
    await cache.read('overview', load);
    expect(loads).toBe(2);
    const long = new ViewCache(60_000);
    await long.read('overview', load);
    long.invalidate();
    await long.read('overview', load);
    expect(loads).toBe(4);
  });
});

it('does not serve an in-flight result from the previous wallet after invalidation', async () => {
  const cache = new ViewCache();
  let finish!: (value: string) => void;
  const old = cache.read('positions', () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  const current = cache.read('positions', async () => 'wallet B');
  finish('wallet A');
  expect(await old).toBe('wallet A');
  expect(await current).toBe('wallet B');
  expect(await cache.read('positions', async () => 'unexpected')).toBe('wallet B');
});
