import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliEntry } from '../lib/cli-node.mjs';
import { gatewayStartArgs, startTestbenchGateway } from '../lib/desktop.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('startTestbenchGateway', () => {
  it('passes the gateway options to `gateway start`, where they belong', () => {
    const args = gatewayStartArgs({ entry: 'cli.js', manifest: { buyerDir: '/tb/buyer', buyerConfig: '/tb/config.json' }, buyerPort: 8401, port: 9001 });
    assert.deepEqual(args.slice(args.indexOf('gateway'), args.indexOf('gateway') + 4), ['gateway', 'start', '--no-buyer', '--no-console']);
  });

  it('starts on a fresh buyer data dir with no gateway keys', { skip: !existsSync(cliEntry(repo)) && 'the CLI is not built', timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-gateway-'));
    try {
      const home = join(dir, 'home');
      const buyerDir = join(dir, 'buyer');
      await mkdir(home, { recursive: true });
      await mkdir(buyerDir, { recursive: true });
      const buyerConfig = join(dir, 'config.json');
      await writeFile(buyerConfig, '{}\n');
      // No buyer listens here; the gateway still starts and answers.
      const manifest = { home, buyerDir, buyerConfig, proxyUrl: 'http://127.0.0.1:9' };
      const gateway = await startTestbenchGateway({ repo, manifest, reportDir: dir });
      try {
        assert.match(gateway.key, /\S{16,}/);
        const response = await fetch(`${gateway.url}/v1/key`, { headers: { authorization: `Bearer ${gateway.key}` } });
        assert.notEqual(response.status, 401);
      } finally {
        await gateway.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
