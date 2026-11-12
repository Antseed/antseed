import assert from 'node:assert/strict';
import test from 'node:test';
import { oncePerGatewayKey } from './once-per-key.js';

test('each key gets the list its own policy allows', async () => {
  const lists: Record<string, string[]> = { desktop: ['model-a'], pi: ['model-b'] };
  const modelsFor = oncePerGatewayKey(async (endpoint: { origin: string; apiKey: string }) => lists[endpoint.apiKey]!);
  assert.deepEqual(await modelsFor({ origin: 'http://gw', apiKey: 'desktop' }), ['model-a']);
  assert.deepEqual(await modelsFor({ origin: 'http://gw', apiKey: 'pi' }), ['model-b']);
});

test('a shared key loads once however many apps use it', async () => {
  let loads = 0;
  const modelsFor = oncePerGatewayKey(async (_endpoint: { origin: string; apiKey: string }) => { loads += 1; return []; });
  await Promise.all([modelsFor({ origin: 'http://gw', apiKey: 'k' }), modelsFor({ origin: 'http://gw', apiKey: 'k' })]);
  await modelsFor({ origin: 'http://gw', apiKey: 'k' });
  assert.equal(loads, 1);
});

test('the same key on another gateway loads again', async () => {
  let loads = 0;
  const modelsFor = oncePerGatewayKey(async (_endpoint: { origin: string; apiKey: string }) => { loads += 1; return []; });
  await modelsFor({ origin: 'http://one', apiKey: 'k' });
  await modelsFor({ origin: 'http://two', apiKey: 'k' });
  assert.equal(loads, 2);
});
