import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearGatewayModelCache, fetchGatewayModelEntries } from './models.js';
import type { GatewayEndpoint } from './service.js';

const endpoint = { origin: 'http://gateway.test', apiKey: 'test-key' } as GatewayEndpoint;
const realFetch = globalThis.fetch;

/** Answers each `/v1/models` read with the next list, when the test releases it. */
function stubModelReads() {
  const pending: Array<(ids: string[]) => void> = [];
  globalThis.fetch = (async () => {
    const ids = await new Promise<string[]>((resolve) => pending.push(resolve));
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  }) as typeof fetch;
  const started = async (index: number) => {
    while (pending.length <= index) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    reads: () => pending.length,
    started,
    answer: async (index: number, ids: string[]) => {
      await started(index);
      pending[index]!(ids);
    },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearGatewayModelCache();
});

test('a read cached within the minute answers the next one', async () => {
  const stub = stubModelReads();
  const first = fetchGatewayModelEntries(endpoint);
  await stub.answer(0, ['model-a']);
  assert.deepEqual((await first).map((entry) => entry.id), ['model-a']);
  assert.deepEqual((await fetchGatewayModelEntries(endpoint)).map((entry) => entry.id), ['model-a']);
  assert.equal(stub.reads(), 1);
});

test('a read that began before the cache was cleared does not refill it', async () => {
  const stub = stubModelReads();
  // Started under the old privacy policy, answered after the switch cleared the cache.
  const stale = fetchGatewayModelEntries(endpoint);
  await stub.started(0);
  clearGatewayModelCache();
  await stub.answer(0, ['old-policy-model']);
  assert.deepEqual((await stale).map((entry) => entry.id), ['old-policy-model']);
  // The next read asks the gateway again instead of serving the old list.
  const fresh = fetchGatewayModelEntries(endpoint);
  assert.equal(stub.reads(), 2, 'the next read went to the gateway');
  await stub.answer(1, ['new-policy-model']);
  assert.deepEqual((await fresh).map((entry) => entry.id), ['new-policy-model']);
});
