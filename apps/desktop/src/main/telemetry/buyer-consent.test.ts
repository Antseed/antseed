import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncBuyerTelemetryConsent } from './buyer-consent.js';

test('syncBuyerTelemetryConsent writes telemetry.enabled and reports success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-consent-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ buyer: { proxyPort: 8377 } }));
    assert.equal(await syncBuyerTelemetryConsent(false, configPath), true);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { telemetry?: { enabled?: boolean }; buyer?: unknown };
    assert.equal(config.telemetry?.enabled, false);
    assert.deepEqual(config.buyer, { proxyPort: 8377 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncBuyerTelemetryConsent reports failure when the config cannot be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-consent-'));
  try {
    // The config's folder is a plain file, so the write must fail.
    await writeFile(join(dir, 'blocker'), '');
    assert.equal(await syncBuyerTelemetryConsent(false, join(dir, 'blocker', 'config.json')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
