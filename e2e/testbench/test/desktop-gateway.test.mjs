import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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

  it('stops once its launcher is killed before cleaning up', { skip: !existsSync(cliEntry(repo)) && 'the CLI is not built', timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-gateway-orphan-'));
    try {
      const home = join(dir, 'home');
      const buyerDir = join(dir, 'buyer');
      await mkdir(home, { recursive: true });
      await mkdir(buyerDir, { recursive: true });
      const buyerConfig = join(dir, 'config.json');
      await writeFile(buyerConfig, '{}\n');
      const manifest = { home, buyerDir, buyerConfig, proxyUrl: 'http://127.0.0.1:9' };
      // A launcher that starts the gateway, prints its URL and waits to be killed.
      const helper = new URL('../lib/desktop.mjs', import.meta.url).href;
      const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
        const { startTestbenchGateway } = await import(${JSON.stringify(helper)});
        const gateway = await startTestbenchGateway(${JSON.stringify({ repo, manifest, reportDir: dir })});
        console.log(gateway.url);
        setInterval(() => {}, 1000);
      `], { stdio: ['ignore', 'pipe', 'inherit'] });
      const url = await new Promise((resolveUrl, reject) => {
        let out = '';
        launcher.stdout.on('data', (chunk) => {
          out += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
          if (match) resolveUrl(match[0]);
        });
        launcher.once('exit', (code) => reject(new Error(`launcher exited ${code}`)));
      });
      launcher.kill('SIGKILL');
      const deadline = Date.now() + 30_000;
      let up = true;
      while (Date.now() < deadline) {
        up = await fetch(`${url}/healthz`).then(() => true, () => false);
        if (!up) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(up, false, 'the gateway outlived its launcher');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
