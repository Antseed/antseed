import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSellerEvents } from '@antseed/node';
import { SellerAlerts, formatAlert } from '../../../seller-alerts/alerts.js';

function harness(config: ConstructorParameters<typeof SellerAlerts>[0]['config'], { status = 200 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let now = 1_000_000;
  const alerts = new SellerAlerts({
    dataDir,
    config,
    sellerName: 'OpenForge',
    env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 'secret-token' },
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status });
    }) as typeof fetch,
  });
  return { alerts, calls, dataDir, advance: (ms: number) => { now += ms; } };
}

const down = { kind: 'model_down', severity: 'warning', title: 'glm-5.3 withdrawn', detail: 'HTTP 402: out of credit', provider: 'openai', service: 'glm-5.3' } as const;
const up = { kind: 'model_up', severity: 'info', title: 'glm-5.3 back', provider: 'openai', service: 'glm-5.3' } as const;

test('sends warnings to telegram and the webhook, journals every event', async () => {
  const { alerts, calls, dataDir } = harness({ telegram: { chatId: '42' }, webhook: { url: 'https://hooks.example/x' } });
  assert.deepEqual(alerts.channels(), ['telegram', 'webhook']);
  await alerts.record({ kind: 'started', severity: 'info', title: 'started' });
  await alerts.record(down);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://api.telegram.org/botsecret-token/sendMessage');
  assert.equal(calls[0]!.body.chat_id, '42');
  assert.equal(calls[0]!.body.text, '⚠️ OpenForge: glm-5.3 withdrawn\nHTTP 402: out of credit');
  assert.equal(calls[1]!.body.content, calls[1]!.body.text);
  assert.equal((await readSellerEvents(dataDir)).length, 2);
  assert.equal(alerts.state().lastError, null);
});

test('repeats wait out the cooldown; a recovery is sent only after its alert', async () => {
  const { alerts, calls, advance } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 });
  await alerts.record(up);
  assert.equal(calls.length, 0, 'no recovery without an alert');
  await alerts.record(down);
  advance(10 * 60_000);
  await alerts.record(down);
  assert.equal(calls.length, 1, 'repeat inside the cooldown is dropped');
  await alerts.record(up);
  assert.equal(calls.length, 2);
  await alerts.record(down);
  assert.equal(calls.length, 3, 'after a recovery the next failure alerts again');
});

test('without channels nothing is sent; failures never leak the token', async () => {
  const quiet = harness({});
  await quiet.alerts.record(down);
  assert.equal(quiet.calls.length, 0);

  const failing = harness({ telegram: { chatId: '42' } }, { status: 401 });
  const result = await failing.alerts.send({ ...down, at: 1 });
  assert.deepEqual(result, { sent: [], errors: ['telegram: HTTP 401'] });
  assert.equal(failing.alerts.state().lastError, 'telegram: HTTP 401');
  assert.doesNotMatch(JSON.stringify(failing.alerts.state()), /secret-token/);
});

test('formatAlert keeps long details short', () => {
  const [title, detail] = formatAlert('S', { at: 1, kind: 'test', severity: 'info', title: 't', detail: 'x'.repeat(600) }).split('\n');
  assert.equal(title, '✅ S: t');
  assert.equal(detail, `${'x'.repeat(500)}…`);
});

test('an existing state file at startup means the last run died', async () => {
  const { uncleanExitEvent } = await import('../../../seller-alerts/lifecycle.js');
  assert.equal(uncleanExitEvent(null, 0), null);
  assert.equal(uncleanExitEvent(JSON.stringify({ updatedAt: 0 }), 5 * 60_000)?.title, 'Seller restarted after an unexpected exit (last seen 5 min ago)');
  assert.equal(uncleanExitEvent('{"upda', 0)?.kind, 'crashed');
});

test('idle watch alerts once after the quiet period and recovers on traffic', async () => {
  const { EventEmitter } = await import('node:events');
  const { startIdleWatch } = await import('../../../seller-alerts/lifecycle.js');
  const node = new EventEmitter();
  const events: string[] = [];
  let now = 0;
  const watch = startIdleWatch({ idleMinutes: 10, node, record: (e) => events.push(e.kind), now: () => now, checkEveryMs: 1_000_000 });
  now = 9 * 60_000; watch.check();
  now = 11 * 60_000; watch.check(); watch.check();
  node.emit('session:updated');
  watch.stop();
  assert.deepEqual(events, ['idle', 'active']);
  assert.equal(node.listenerCount('session:updated'), 0);
  assert.equal(typeof startIdleWatch({ idleMinutes: undefined, node, record: () => {} }).stop, 'function');
});

test('the token comes from the secrets file when the env has none, and edits apply without a restart', async () => {
  const { writeFileSync } = await import('node:fs');
  const { writeAlertSecrets } = await import('../../../seller-alerts/settings.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '42' }, idleMinutes: 30 } } }));
  let now = 1_000_000;
  const urls: string[] = [];
  const alerts = new SellerAlerts({
    dataDir, configPath, sellerName: 'S', env: {}, now: () => now,
    fetch: (async (url: string) => { urls.push(String(url)); return new Response('{}'); }) as typeof fetch,
  });
  assert.deepEqual(alerts.channels(), [], 'no token yet');
  writeAlertSecrets(dataDir, { telegramBotToken: 'file-token', webhookUrl: 'https://hooks.example/abc' });
  now += 3_000;
  assert.deepEqual(alerts.channels(), ['telegram', 'webhook']);
  await alerts.send({ at: now, kind: 'test', severity: 'info', title: 't' }, 'telegram');
  assert.deepEqual(urls, ['https://api.telegram.org/botfile-token/sendMessage']);

  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '43' }, idleMinutes: 5, minSeverity: 'critical' } } }));
  now += 3_000;
  assert.equal(alerts.idleMinutes(), 5);
  assert.equal(alerts.settings.telegram?.chatId, '43');
  await alerts.record(down);
  assert.equal(urls.length, 1, 'minSeverity critical now drops warnings');
});

test('failures never leak the webhook URL either', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const alerts = new SellerAlerts({
    dataDir, config: { webhook: { url: 'https://hooks.example/very-secret' } }, sellerName: 'S', env: {},
    fetch: (async (url: string) => { throw new Error(`connect failed for ${url}`); }) as typeof fetch,
  });
  const { errors } = await alerts.send({ at: 1, kind: 'test', severity: 'info', title: 't' });
  assert.deepEqual(errors, ['webhook: connect failed for <webhook>']);
  assert.ok(!alerts.state().lastError!.includes('very-secret'));
});

test('the idle watch follows idleMinutes edits', async () => {
  const { startIdleWatch } = await import('../../../seller-alerts/lifecycle.js');
  let now = 0;
  let minutes: number | undefined;
  const events: string[] = [];
  const node = { on() {}, off() {} };
  const watch = startIdleWatch({ idleMinutes: () => minutes, node, record: (event) => events.push(event.kind), now: () => now, checkEveryMs: 1_000_000 });
  now = 120 * 60_000;
  watch.check();
  assert.deepEqual(events, [], 'off while unset');
  minutes = 60;
  watch.check();
  assert.deepEqual(events, ['idle']);
  watch.stop();
});

test('dashboard overrides in the data dir win over config.json and apply live', async () => {
  const { writeFileSync } = await import('node:fs');
  const { writeAlertOverrides } = await import('../../../seller-alerts/settings.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '1' }, webhook: { url: 'https://hooks.example/from-config' }, idleMinutes: 30 } } }));
  let now = 0;
  const alerts = new SellerAlerts({ dataDir, configPath, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' }, now: () => now });
  assert.equal(alerts.settings.telegram?.chatId, '1');
  writeAlertOverrides(dataDir, { telegramChatId: '2', idleMinutes: null, webhookFromConfig: false });
  now += 3_000;
  assert.equal(alerts.settings.telegram?.chatId, '2');
  assert.equal(alerts.idleMinutes(), undefined, 'null turns the config value off');
  assert.deepEqual(alerts.channels(), ['telegram']);
});
