import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedRead, clearChainReads, invalidateChainReads, refreshFresh } from './read-cache.js';

// gcTime timers would keep the test process alive.
after(() => clearChainReads());

function counter<T>(value: T) {
  let calls = 0;
  return { read: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return value; }, get calls() { return calls; } };
}

test('concurrent callers share one read and a fresh result is served from memory', async () => {
  clearChainReads();
  const source = counter(42);
  const results = await Promise.all([1, 2, 3].map(() => cachedRead(['t', 'dedupe'], 60_000, source.read)));
  assert.deepEqual(results, [42, 42, 42]);
  assert.equal(await cachedRead(['t', 'dedupe'], 60_000, source.read), 42);
  assert.equal(source.calls, 1);
});

test('a stale result is refetched', async () => {
  clearChainReads();
  const source = counter('v');
  await cachedRead(['t', 'stale'], 1, source.read);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cachedRead(['t', 'stale'], 1, source.read);
  assert.equal(source.calls, 2);
});

test('invalidation forces the next read, scoped or global', async () => {
  clearChainReads();
  const a = counter('a');
  const b = counter('b');
  await cachedRead(['channels', 'x'], 60_000, a.read);
  await cachedRead(['rewards', 'x'], 60_000, b.read);
  invalidateChainReads(['channels']);
  await cachedRead(['channels', 'x'], 60_000, a.read);
  await cachedRead(['rewards', 'x'], 60_000, b.read);
  assert.deepEqual([a.calls, b.calls], [2, 1]);
  invalidateChainReads();
  await cachedRead(['rewards', 'x'], 60_000, b.read);
  assert.equal(b.calls, 2);
});

test('freshness can depend on the cached value', async () => {
  clearChainReads();
  let calls = 0;
  const read = async () => ({ error: calls++ === 0 ? 'rate limited' : null });
  const fresh = (cached?: { error: string | null }) => (cached?.error ? 0 : 60_000);
  assert.equal((await cachedRead(['t', 'err'], fresh, read)).error, 'rate limited');
  assert.equal((await cachedRead(['t', 'err'], fresh, read)).error, null);
  assert.equal((await cachedRead(['t', 'err'], fresh, read)).error, null);
  assert.equal(calls, 2);
});

test('a failed read is not cached', async () => {
  clearChainReads();
  let calls = 0;
  const read = async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(cachedRead(['t', 'fail'], 60_000, read), /boom/);
  assert.equal(await cachedRead(['t', 'fail'], 60_000, read), 'ok');
});

test('a fresh read always reaches the chain and refreshes what display callers see', async () => {
  clearChainReads();
  let value = 1;
  let calls = 0;
  const read = async () => { calls++; return value; };
  assert.equal(await cachedRead(['credits', 'w'], 60_000, read), 1);
  value = 2;
  assert.equal(await cachedRead(['credits', 'w'], 60_000, read), 1);
  assert.equal(await refreshFresh(['credits', 'w'], read), 2);
  assert.equal(await refreshFresh(['credits', 'w'], read), 2);
  assert.equal(calls, 3);
  assert.equal(await cachedRead(['credits', 'w'], 60_000, read), 2);
  assert.equal(calls, 3);
});

const later = <T>(ms: number, value: T) => () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test('a fresh read does not join a read that started before it', async () => {
  clearChainReads();
  const before = cachedRead(['credits', 'race'], 60_000, later(40, 'before deposit'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await refreshFresh(['credits', 'race'], later(5, 'after deposit')), 'after deposit');
  assert.equal(await before, 'before deposit');
  // The earlier read finishing later must not replace the fresh value.
  assert.equal(await cachedRead(['credits', 'race'], 60_000, later(5, 'refetched')), 'after deposit');
});

test('a read in flight during invalidation is not cached as fresh', async () => {
  clearChainReads();
  const before = cachedRead(['credits', 'inv'], 60_000, later(30, 'before payment'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  invalidateChainReads();
  assert.equal(await before, 'before payment');
  assert.equal(await cachedRead(['credits', 'inv'], 60_000, later(5, 'after payment')), 'after payment');
});

test('display callers arriving during a fresh read share it', async () => {
  clearChainReads();
  let calls = 0;
  const read = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return calls; };
  const fresh = refreshFresh(['channels', 'share'], read);
  const display = cachedRead(['channels', 'share'], 60_000, read);
  assert.deepEqual(await Promise.all([fresh, display]), [1, 1]);
  assert.equal(calls, 1);
});
