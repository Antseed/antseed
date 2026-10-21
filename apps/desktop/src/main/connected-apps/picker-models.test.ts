import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectedAppPickerModels, waitForBuyerTextModels } from './picker-models.js';

const BLOCKED = 'b'.repeat(40);

async function withBuyer(data: unknown[], run: (port: number) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

test('connectedAppPickerModels lists the selection, starred models and the lineup from the buyer and config', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'antseed-picker-models-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ buyer: {
    favoriteModels: ['aion20'],
    routingPreferences: { blockedPeerIds: [BLOCKED] },
  } }));
  const peer = (peerId: string, serviceId: string) => ({ peerId, serviceId, provider: 'openai', effectiveReputationScore: 90, inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await withBuyer([
    { id: 'claude-opus-5', name: 'Claude Opus 5', type: 'text', peers: [peer('a', 'claude-opus-5')] },
    { id: 'aion-2.0', name: 'Aion 2.0', type: 'text', peers: [peer('a', 'aion-2.0')] },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', type: 'text', peers: [peer('a', 'kimi-k2.6')] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', type: 'text', peers: [peer(BLOCKED, 'claude-sonnet-5')] },
    { id: 'other-model', name: 'Other', type: 'text', peers: [peer('a', 'other-model')] },
  ], async (port) => {
    const rows = await connectedAppPickerModels(port, `${'a'.repeat(40)}@kimi-k2.6`, configPath);
    assert.deepEqual(rows.map((row) => [row.model, row.favorite === true]), [
      ['kimi-k2.6', false],
      ['aion-2.0', true],
      ['claude-opus-5', false],
    ]);
    assert.equal(rows[0]!.provider, 'openai');
  });
});

test('connectedAppPickerModels is empty when the buyer does not answer', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  server.close();
  assert.deepEqual(await connectedAppPickerModels(port, null, path.join(tmpdir(), 'missing-config.json')), []);
});

test('waitForBuyerTextModels resolves once the buyer lists models, and false on timeout', async () => {
  await withBuyer([{ id: 'kimi-k3', type: 'text' }], async (port) => {
    assert.equal(await waitForBuyerTextModels(async () => port, 2_000, 10), true);
  });
  await withBuyer([], async (port) => {
    assert.equal(await waitForBuyerTextModels(async () => port, 50, 10), false);
  });
});
