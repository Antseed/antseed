import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ProcessManager } from './process-manager.js';
import { isCompatibleSharedBuyer, refreshSharedBuyerAttachment } from './shared-buyer.js';

test('isCompatibleSharedBuyer accepts the Antseed status endpoint', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal(await isCompatibleSharedBuyer(address.port), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('isCompatibleSharedBuyer rejects unrelated listeners', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal(await isCompatibleSharedBuyer(address.port), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('refreshSharedBuyerAttachment clears stale attached state when the buyer exits', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const logs: string[] = [];
  const processManager = new ProcessManager((_mode, _stream, line) => logs.push(line));
  processManager.attach('connect');
  assert.equal(await refreshSharedBuyerAttachment(processManager, address.port), true);
  assert.equal(processManager.isAttached('connect'), true);
  assert.equal(processManager.getState().find((state) => state.mode === 'connect')?.running, true);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await refreshSharedBuyerAttachment(processManager, address.port), false);
  const state = processManager.getState().find((candidate) => candidate.mode === 'connect');
  assert.equal(processManager.isAttached('connect'), false);
  assert.equal(state?.running, false);
  assert.match(state?.lastError ?? '', /no longer reachable/);
  assert.match(logs.at(-1) ?? '', /no longer reachable/);
});
