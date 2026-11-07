import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackServedPeer } from './served-peer.js';

test('reports the seller for requests inside a run, and only those', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { headers: { 'x-antseed-peer-id': 'abc123' } });
  try {
    const seen: string[] = [];
    await trackServedPeer((peerId) => seen.push(peerId), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await fetch('http://gateway.test/v1/chat/completions');
    });
    await fetch('http://gateway.test/v1/models');
    assert.deepEqual(seen, ['abc123']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
