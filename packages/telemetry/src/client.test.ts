import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryClient, normalizeBuyerHost, uuidV7, UUID_PATTERN } from './client.js';
import { BatchQueue, type PostHogEvent } from './posthog.js';
import type { EventCatalog } from './sanitize.js';

const catalog: EventCatalog = { ping: { keys: new Set(['outcome']), values: { outcome: new Set(['ok']) } } };
const WALLET = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';

function setup(overrides: Partial<Parameters<typeof createTelemetryClient>[0]> = {}) {
  const sent: PostHogEvent[] = [];
  let enabled = true;
  const client = createTelemetryClient({
    product: 'buyer',
    appVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
    catalog,
    getDistinctId: () => WALLET,
    isEnabled: () => enabled,
    sender: async (events) => { sent.push(...events); },
    flushIntervalMs: 60_000,
    ...overrides,
  });
  return { client, sent, setEnabled: (value: boolean) => { enabled = value; } };
}

test('envelope: product, schema v2, uuidv7 session, no person profile', async () => {
  const { client, sent } = setup();
  assert.equal(client.capture('ping', { outcome: 'ok', prompt: 'secret' }), true);
  await client.flush();
  assert.equal(sent.length, 1);
  const event = sent[0]!;
  assert.equal(event.distinct_id, WALLET.toLowerCase());
  assert.equal(event.properties['product'], 'buyer');
  assert.equal(event.properties['schema_version'], 2);
  assert.equal(event.properties['$process_person_profile'], false);
  assert.equal(event.properties['$geoip_disable'], true);
  assert.equal(event.properties['outcome'], 'ok');
  assert.equal('prompt' in event.properties, false);
  assert.match(String(event.properties['$session_id']), /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
});

test('a buyer carries its host and host session', async () => {
  const hostSession = uuidV7();
  const { client, sent } = setup({ product: 'buyer', buyerHost: 'gateway', hostSessionId: hostSession });
  client.capture('ping', { outcome: 'ok' });
  await client.flush();
  assert.equal(sent[0]!.properties['buyer_host'], 'gateway');
  assert.equal(sent[0]!.properties['host_session_id'], hostSession);
  assert.equal(normalizeBuyerHost('nope'), 'standalone');
  assert.match(hostSession, UUID_PATTERN);
});

test('nothing is sent without consent, wallet or a catalog entry', async () => {
  const { client, sent, setEnabled } = setup();
  assert.equal(client.capture('unknown_event', {}), false);
  client.capture('ping', { outcome: 'ok' });
  setEnabled(false);
  assert.equal(client.capture('ping', { outcome: 'ok' }), false);
  await client.flush();
  assert.equal(sent.length, 0, 'queue dropped when consent turned off before flush');
  const noWallet = setup({ getDistinctId: () => 'not-an-address' });
  assert.equal(noWallet.client.capture('ping', { outcome: 'ok' }), false);
});

test('a throwing sender or consent check never escapes', async () => {
  const { client } = setup({ sender: async () => { throw new Error('boom'); }, isEnabled: () => true });
  client.capture('ping', { outcome: 'ok' });
  await client.flush();
  const throwing = setup({ isEnabled: () => { throw new Error('x'); } });
  assert.equal(throwing.client.capture('ping', { outcome: 'ok' }), false);
});

test('queue: bounded, batched, close is bounded', async () => {
  const batches: number[] = [];
  const queue = new BatchQueue({ send: async (events) => { batches.push(events.length); }, maxQueue: 5, maxBatch: 2, flushIntervalMs: 60_000 });
  for (let i = 0; i < 9; i += 1) {
    queue.push({ event: 'e', distinct_id: 'x', timestamp: '', properties: {} });
  }
  assert.equal(queue.size, 5);
  await queue.flush();
  assert.deepEqual(batches, [2, 2, 1]);

  const hanging = new BatchQueue({ send: () => new Promise<void>(() => {}), flushIntervalMs: 60_000 });
  hanging.push({ event: 'e', distinct_id: 'x', timestamp: '', properties: {} });
  const started = Date.now();
  await hanging.close(50);
  assert.ok(Date.now() - started < 1_000);
});
