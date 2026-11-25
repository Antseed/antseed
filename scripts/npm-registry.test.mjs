import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onNpm, waitForNpm } from './npm-registry.mjs';

/** A registry that serves the version from the `servedFrom`-th request on, and a clock the waits move. */
function registry({ servedFrom = Infinity, status } = {}) {
  let clock = 0;
  const urls = [];
  return {
    urls,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async (url) => {
      urls.push(url);
      const code = status ?? (urls.length >= servedFrom ? 200 : 404);
      return { status: code, ok: code >= 200 && code < 300 };
    },
  };
}

test('reads a scoped version from the registry', async () => {
  const r = registry({ servedFrom: 1 });
  assert.equal(await onNpm('@antseed/cli', '1.2.3', r), true);
  assert.deepEqual(r.urls, ['https://registry.npmjs.org/@antseed%2fcli/1.2.3']);
  assert.equal(await onNpm('@antseed/cli', '1.2.3', registry()), false);
});

test('keeps polling a just-published version until the registry serves it', async () => {
  const r = registry({ servedFrom: 4 });
  const served = await waitForNpm('@antseed/cli', '1.2.3', { ...r, deadline: 60 * 60_000, intervalMs: 30_000 });
  assert.equal(served, true);
  assert.equal(r.urls.length, 4);
  assert.equal(r.now(), 90_000);
});

test('gives up at the deadline, after one last read', async () => {
  const r = registry();
  const served = await waitForNpm('@antseed/cli', '1.2.3', { ...r, deadline: 100_000, intervalMs: 30_000 });
  assert.equal(served, false);
  assert.equal(r.now(), 100_000);
  assert.equal(r.urls.length, 5);
});

test('reads once when there is nothing to wait for', async () => {
  const r = registry();
  assert.equal(await waitForNpm('@antseed/cli', '1.2.3', r), false);
  assert.equal(r.urls.length, 1);
});

test('stops at a registry error instead of waiting it out', async () => {
  const r = registry({ status: 503 });
  await assert.rejects(waitForNpm('@antseed/cli', '1.2.3', { ...r, deadline: 60_000 }), /answered 503/);
  assert.equal(r.urls.length, 1);
});
