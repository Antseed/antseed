import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { writeSellerFixture } from '../../../seller-monitor/fixture.js';
import { registerSellerAlertsCommand } from './alerts.js';
import { parsePrice, parseSince, registerSellerMonitorCommands, resolvePriceTarget } from './monitor.js';

const PEER = '5e11e5' + '0'.repeat(34);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'seller-cli-'));
  const now = Date.now();
  writeSellerFixture(dir, {
    state: { updatedAt: now, peerId: PEER, modelHealth: [{ provider: 'openai', service: 'glm-5.3', advertised: false, consecutiveFailures: 3, lastProbeAt: now, lastStatusCode: 402, lastDetail: 'HTTP 402' }] },
    events: [{ at: now - 1_000, kind: 'model_down', severity: 'warning', title: 'glm-5.3 withdrawn' }],
    requests: [{ at: now - 60_000, sessionId: 's1', tokens: 100, costCents: 2 }, { at: now - 30_000, sessionId: 's1', tokens: 50, costCents: 1 }],
  });
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ identity: { displayName: 'Demo Seller' }, seller: { providers: { openai: { plugin: 'openai', baseUrl: 'https://upstream.example', services: { 'glm-5.3': { pricing: { inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2 } } } } } } }, null, 2));
  return { dir, config };
}

/** Runs `antseed --data-dir … --config … seller <args>` and returns what it printed. */
async function run(env: { dir: string; config: string }, args: string[]): Promise<{ out: string; json: () => any }> {
  const program = new Command().option('--data-dir <dir>').option('-c, --config <path>').exitOverride();
  const seller = program.command('seller');
  registerSellerMonitorCommands(seller);
  registerSellerAlertsCommand(seller);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try {
    await program.parseAsync(['node', 'antseed', '--data-dir', env.dir, '--config', env.config, 'seller', ...args]);
  } finally {
    console.log = log;
  }
  const out = lines.join('\n');
  return { out, json: () => JSON.parse(out) };
}

test('flag parsing: --since and --price', () => {
  assert.equal(parseSince('2h', 10_000_000), 10_000_000 - 7_200_000);
  assert.equal(parseSince('2026-10-25T00:00:00Z'), Date.parse('2026-10-25T00:00:00Z'));
  assert.throws(() => parseSince('yesterday'));
  assert.deepEqual(parsePrice('glm-5.3=0.7/2.2/0.08'), { service: 'glm-5.3', input: 0.7, output: 2.2, cached: 0.08 });
  assert.throws(() => parsePrice('glm-5.3=cheap'));
});

test('--price names the provider when two offer the same model', () => {
  const services = [{ provider: 'openai', service: 'glm-5.3' }, { provider: 'openforge', service: 'glm-5.3' }, { provider: 'openai', service: 'kimi-k3' }];
  assert.equal(resolvePriceTarget(services, 'kimi-k3'), services[2]);
  assert.equal(resolvePriceTarget(services, 'openforge/glm-5.3'), services[1]);
  assert.throws(() => resolvePriceTarget(services, 'glm-5.3'), /more than one provider; name one: openai\/glm-5\.3, openforge\/glm-5\.3/);
  assert.throws(() => resolvePriceTarget(services, 'qwen'), /not one of this seller's services/);
});

test('events, usage and logs read the same service the dashboard does', async () => {
  const env = fixture();
  assert.equal((await run(env, ['events', '--json'])).json()[0].title, 'glm-5.3 withdrawn');
  const usage = (await run(env, ['usage', '--days', '1', '--json'])).json();
  assert.equal(usage.days[0].requests, 2);
  const page = (await run(env, ['logs', '--limit', '1', '--json'])).json();
  assert.equal(page.entries.length, 1);
  assert.ok(page.next);
  const older = (await run(env, ['logs', '--limit', '1', '--cursor', page.next, '--json'])).json();
  assert.equal(older.entries[0].costUsd, 0.02);
  assert.match((await run(env, ['logs', '--limit', '1'])).out, /Older: antseed seller logs --cursor/);
});

test('settings set writes through the validated writer; alerts set keeps the token out of argv and config.json', async () => {
  const env = fixture();
  const saved = (await run(env, ['settings', 'set', '--price', 'glm-5.3=0.6/2/0.05', '--max-buyers', '10', '--json'])).json();
  assert.deepEqual(saved.changed, ['maxConcurrentBuyers', 'pricing']);
  const config = JSON.parse(readFileSync(env.config, 'utf-8'));
  assert.deepEqual(config.seller.providers.openai.services['glm-5.3'].pricing, { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.05 });
  assert.equal(JSON.parse(readFileSync(`${env.config}.bak`, 'utf-8')).seller.maxConcurrentBuyers, undefined);
  const alerts = (await run(env, ['alerts', 'set', '--telegram-chat', '-1001', '--idle', '30', '--json'])).json();
  assert.equal(alerts.alerts.telegram.chatId, '-1001');
  assert.equal(alerts.alerts.idleMinutes, 30);
  assert.equal(JSON.parse(readFileSync(env.config, 'utf-8')).seller.alerts, undefined, 'alert settings live in the data dir');
  assert.match((await run(env, ['alerts'])).out, /chat -1001/);
});
