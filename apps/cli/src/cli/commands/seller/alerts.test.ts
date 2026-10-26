import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSellerEvents } from '@antseed/node';
import { SellerAlerts, formatAlert } from '../../../seller-alerts/alerts.js';
import { readSecretFromStdin } from './alerts.js';

function harness(config: ConstructorParameters<typeof SellerAlerts>[0]['config'], { status = 200, retryMs }: { status?: number; retryMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let now = 1_000_000;
  let statusFor = (_url: string) => status;
  const alerts = new SellerAlerts({
    dataDir,
    config,
    sellerName: 'OpenForge',
    env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 'secret-token' },
    now: () => now,
    ...(retryMs !== undefined ? { retryMs } : {}),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: statusFor(String(url)) });
    }) as typeof fetch,
  });
  return { alerts, calls, dataDir, advance: (ms: number) => { now += ms; }, failWhen: (fail: (url: string) => boolean) => { statusFor = (url) => (fail(url) ? 500 : 200); } };
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
  advance(20 * 60_000);
  await alerts.record(down);
  assert.equal(calls.length, 3, 'once the cooldown is over, the next failure alerts again');
});

test('a flapping model alerts once per cooldown: a new failure inside it waits, and its recovery cancels both', async () => {
  const { alerts, calls, advance } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 });
  await alerts.record(down);
  await alerts.record(up);
  advance(60_000);
  await alerts.record(down);
  await alerts.record(up);
  assert.equal(calls.length, 2, 'the second flap sends nothing');
  advance(60_000);
  await alerts.record(down);
  assert.equal(calls.length, 2, 'held until the cooldown ends');
  alerts.close();
});

test('an alert held by the cooldown goes out when it ends if nothing recovered', async () => {
  const { alerts, calls, advance } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 0.001 });
  await alerts.record(down);
  await alerts.record(up);
  await alerts.record(down);
  assert.equal(calls.length, 2);
  advance(60_000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 3, 'still down after the cooldown: alerted');
  await alerts.record(up);
  assert.equal(calls.length, 4, 'and its recovery follows');
});

test('crash alerts keep their cooldown across restarts', async () => {
  const first = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 });
  const crashed = { kind: 'crashed', severity: 'warning', title: 'Seller restarted after an unexpected exit' } as const;
  await first.alerts.record(crashed);
  assert.equal(first.calls.length, 1);
  const calls: string[] = [];
  const restarted = new SellerAlerts({
    dataDir: first.dataDir, config: { telegram: { chatId: '42' }, cooldownMinutes: 30 }, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' },
    now: () => 1_000_000 + 5 * 60_000,
    fetch: (async (url: string) => { calls.push(String(url)); return new Response('{}'); }) as typeof fetch,
  });
  await restarted.record(crashed);
  assert.equal(calls.length, 0, 'a crash loop does not alert on every restart');
});

test('a failed alert is retried on its next repeat and gets no recovery until one arrives', async () => {
  // Long enough that no resend lands between the records below on a busy machine.
  const { alerts, calls, failWhen } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 }, { retryMs: 250 });
  failWhen(() => true);
  await alerts.record(down);
  await alerts.record(up);
  assert.equal(calls.length, 1, 'no recovery for an alert that never arrived');
  failWhen(() => false);
  await alerts.record(down);
  assert.equal(calls.length, 2, 'the repeat is not held back by a cooldown');
  failWhen(() => true);
  await alerts.record(up);
  failWhen(() => false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls.length, 4, 'a failed recovery is resent');
  await alerts.record(up);
  assert.equal(calls.length, 4);
  alerts.close();
});

test('an incident closes even when its recovery fails to send, so the next outage inside the cooldown is held, not dropped', async () => {
  const { alerts, calls, failWhen, advance } = harness({ webhook: { url: 'https://hooks.example/x' }, cooldownMinutes: 0.002 }, { retryMs: 60_000 });
  await alerts.record(down);
  failWhen(() => true);
  await alerts.record(up);
  failWhen(() => false);
  await alerts.record(down);
  assert.equal(calls.length, 2, 'the new outage waits out the cooldown');
  advance(200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls.map((call) => String(call.body.text).split('\n')[0]!.split(': ')[1]), ['glm-5.3 withdrawn', 'glm-5.3 back', 'glm-5.3 withdrawn'], 'the new outage goes out; the stale recovery resend does not');
  alerts.close();
});

test('delivery is tracked per channel', async () => {
  const { alerts, calls, failWhen } = harness({ telegram: { chatId: '42' }, webhook: { url: 'https://hooks.example/x' }, cooldownMinutes: 30 });
  failWhen((url) => url.includes('hooks.example'));
  await alerts.record(down);
  failWhen(() => false);
  await alerts.record(down);
  assert.deepEqual(calls.map((call) => call.url.includes('hooks.example') ? 'webhook' : 'telegram'), ['telegram', 'webhook', 'webhook']);
  await alerts.record(up);
  assert.equal(calls.length, 5, 'both channels got the alert, both get the recovery');
});

test('upstreams sharing a plugin name keep separate incidents', async () => {
  const { alerts, calls } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 });
  await alerts.record({ ...down, providerId: 'kimi' });
  await alerts.record({ ...down, providerId: 'openrouter' });
  assert.equal(calls.length, 2, "one upstream's alert does not silence the other's");
  await alerts.record({ ...up, providerId: 'kimi' });
  await alerts.record({ ...down, providerId: 'openrouter' });
  assert.equal(calls.length, 3, 'a recovery on one leaves the other in its cooldown');
});

test('a recovery recorded while its alert is still sending follows it, and the next incident alerts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const titles: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const alerts = new SellerAlerts({
    dataDir, config: { telegram: { chatId: '42' }, cooldownMinutes: 30 }, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' },
    fetch: (async (_url: string, init: RequestInit) => {
      titles.push(String(JSON.parse(String(init.body)).text));
      if (first) { first = false; await held; }
      return new Response('{}');
    }) as typeof fetch,
  });
  const idle = alerts.record({ kind: 'idle', severity: 'warning', title: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const active = alerts.record({ kind: 'active', severity: 'info', title: 'active' });
  release();
  await Promise.all([idle, active]);
  assert.deepEqual(titles.map((text) => text.split(': ')[1]), ['idle', 'active']);
  await alerts.record({ kind: 'idle', severity: 'warning', title: 'idle again' });
  assert.equal(titles.length, 2, 'the next incident inside the cooldown waits for it');
  alerts.close();
});

test('a recovery queued behind a slow send cancels the alert a failure queued ahead of it held', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const titles: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const alerts = new SellerAlerts({
    dataDir, config: { telegram: { chatId: '42' }, cooldownMinutes: 0.001 }, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' },
    fetch: (async (_url: string, init: RequestInit) => {
      titles.push(String(JSON.parse(String(init.body)).text));
      if (first) { first = false; await held; }
      return new Response('{}');
    }) as typeof fetch,
  });
  // low, ok, low, ok: all but the first queue behind the stalled first send.
  const queued = [alerts.record(down)];
  await new Promise((resolve) => setTimeout(resolve, 10));
  queued.push(alerts.record(up), alerts.record(down), alerts.record(up));
  // Let all three reach the queue (each journals first) before the stalled send finishes.
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.all(queued);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(titles.map((text) => text.split('\n')[0]!.split(': ')[1]), ['glm-5.3 withdrawn', 'glm-5.3 back'], 'no stale outage alert after the cooldown');
  alerts.close();
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
  await writeAlertSecrets(dataDir, { telegramBotToken: 'file-token', webhookUrl: 'https://hooks.example/abc' });
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
  await writeAlertOverrides(dataDir, { telegramChatId: '2', idleMinutes: null, webhookFromConfig: false });
  now += 3_000;
  assert.equal(alerts.settings.telegram?.chatId, '2');
  assert.equal(alerts.idleMinutes(), undefined, 'null turns the config value off');
  assert.deepEqual(alerts.channels(), ['telegram']);
});

test('a hand-edited alerts block with wrong types never throws: a numeric chat id works, the rest is left out', async () => {
  const { writeFileSync } = await import('node:fs');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: 42 }, idleMinutes: 30 } } }));
  let now = 0;
  const alerts = new SellerAlerts({ dataDir, configPath, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' }, now: () => now });
  assert.equal(alerts.settings.telegram?.chatId, '42');
  assert.deepEqual(alerts.channels(), ['telegram']);
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: { id: 1 } }, idleMinutes: 'soon', minSeverity: 7 } } }));
  now += 3_000;
  assert.equal(alerts.idleMinutes(), undefined);
  assert.deepEqual(alerts.channels(), []);
});

test('shutdown waits for a stalled stopped alert only briefly', async () => {
  const { waitAtMost } = await import('../../../seller-alerts/lifecycle.js');
  const started = Date.now();
  await waitAtMost(new Promise(() => {}), 50);
  assert.ok(Date.now() - started < 1_000);
  await waitAtMost(Promise.reject(new Error('offline')), 50);
});

test('a config edit that is not valid JSON keeps the last good alert settings', async () => {
  const { writeFileSync } = await import('node:fs');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '42' }, webhook: { url: 'https://hooks.example/x' }, idleMinutes: 30 } } }));
  let now = 0;
  const alerts = new SellerAlerts({ dataDir, configPath, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' }, now: () => now });
  assert.deepEqual(alerts.channels(), ['telegram', 'webhook']);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    writeFileSync(configPath, '{ "seller": { "alerts": ');
    now += 3_000;
    assert.deepEqual(alerts.channels(), ['telegram', 'webhook']);
    assert.equal(alerts.idleMinutes(), 30);
  } finally {
    console.error = original;
  }
  assert.match(String(errors[0]), /Keeping the previous alert settings: .*not valid JSON/);
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { idleMinutes: 5 } } }));
  now += 3_000;
  assert.equal(alerts.idleMinutes(), 5, 'a fixed file applies again');
});

test('a changed chat starts with no history: the repeat goes to it, and the recovery only where the alert arrived', async () => {
  const { writeFileSync } = await import('node:fs');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  const chats: unknown[] = [];
  let now = 0;
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '1' }, cooldownMinutes: 30 } } }));
  const alerts = new SellerAlerts({
    dataDir, configPath, sellerName: 'S', env: { ANTSEED_ALERTS_TELEGRAM_TOKEN: 't' }, now: () => now,
    fetch: (async (_url: string, init: RequestInit) => { chats.push(JSON.parse(String(init.body)).chat_id); return new Response('{}'); }) as typeof fetch,
  });
  await alerts.record(down);
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '2' }, cooldownMinutes: 30 } } }));
  now += 3_000;
  await alerts.record(up);
  assert.deepEqual(chats, ['1'], 'chat 2 never got the alert, so no recovery there');
  await alerts.record(down);
  assert.deepEqual(chats, ['1', '2'], 'chat 1\'s cooldown does not hold back chat 2');
  await alerts.record(up);
  assert.deepEqual(chats, ['1', '2', '2']);
});

test('empty stdin never clears a saved secret', async () => {
  await assert.rejects(readSecretFromStdin('--webhook-url-stdin', 'use --clear-webhook.', async () => ''), /--webhook-url-stdin: nothing was read from stdin\. use --clear-webhook\./);
  assert.equal(await readSecretFromStdin('--webhook-url-stdin', '', async () => 'https://hooks.example/x'), 'https://hooks.example/x');
});

test('a botTokenEnv in config.json without a chat id is valid, and the chat id saved from the dashboard completes it', async () => {
  const { sellerAlertsErrors, normalizeSellerAlerts } = await import('../../../config/seller-alerts.js');
  const { applyAlertOverrides, resolveAlerts } = await import('../../../seller-alerts/settings.js');
  const block = { telegram: { botTokenEnv: 'TG_TOKEN' }, cooldownMinutes: 0 };
  assert.deepEqual(sellerAlertsErrors(block), []);
  const config = applyAlertOverrides(normalizeSellerAlerts(block), { telegramChatId: '42' });
  const resolved = resolveAlerts(config, {}, { TG_TOKEN: 'from-env' });
  assert.deepEqual(resolved.telegram, { token: 'from-env', chatId: '42', tokenSource: 'env' });
  assert.equal(resolved.config.cooldownMinutes, 0);
  assert.deepEqual(sellerAlertsErrors({ cooldownMinutes: -1, idleMinutes: 0 }), ['seller.alerts.idleMinutes must be a positive number', 'seller.alerts.cooldownMinutes must be a number of 0 or more']);
});

test('a bot token only in the running seller\'s environment shows as set, and a test from here says why it cannot send', async () => {
  const { writeFileSync } = await import('node:fs');
  const { readSellerAlertSettings } = await import('../../../seller-monitor/settings.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '42' } } } }));
  const off = await readSellerAlertSettings(configPath, dataDir, {});
  assert.deepEqual([off.telegram.tokenSet, off.telegram.active], [false, false]);
  writeFileSync(join(dataDir, 'daemon.state.json'), JSON.stringify({ updatedAt: Date.now(), alerts: { channels: ['telegram'], lastSentAt: null, lastError: null } }));
  const live = await readSellerAlertSettings(configPath, dataDir, {});
  assert.deepEqual([live.telegram.tokenSet, live.telegram.tokenSource, live.telegram.active], [true, 'env', true]);
  writeFileSync(join(dataDir, 'daemon.state.json'), JSON.stringify({ updatedAt: Date.now() - 60_000, alerts: { channels: ['telegram'] } }));
  assert.equal((await readSellerAlertSettings(configPath, dataDir, {})).telegram.tokenSet, false, 'a stopped seller reports nothing');
});

test('an upstream out of credit is critical and its top-up is sent as its recovery; a summary can skip the journal', async () => {
  const { alerts, calls, dataDir } = harness({ telegram: { chatId: '42' } });
  await alerts.record({ kind: 'upstream_credit', severity: 'critical', title: 'deepinfra is out of credit', providerId: 'deepinfra' });
  await alerts.record({ kind: 'upstream_credit_ok', severity: 'info', title: 'deepinfra has credit again', providerId: 'deepinfra' }, { journal: false });
  assert.equal(calls.length, 2);
  assert.deepEqual((await readSellerEvents(dataDir)).map((event) => event.kind), ['upstream_credit']);
  await alerts.record({ kind: 'model_down', severity: 'warning', title: 'glm withdrawn', providerId: 'deepinfra', service: 'glm' }, { notify: false });
  assert.equal(calls.length, 2, 'journaled only');
});

test('an update to an open alert goes out inside the cooldown; a plain repeat does not', async () => {
  const { alerts, calls } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 30 });
  const grouped = { kind: 'model_down', severity: 'warning', title: '1 model withdrawn', providerId: 'deepinfra' } as const;
  await alerts.record(grouped, { journal: false });
  await alerts.record({ ...grouped, title: 'still 1' }, { journal: false });
  await alerts.record({ ...grouped, title: '2 models withdrawn' }, { journal: false, update: true });
  assert.deepEqual(calls.map((call) => String(call.body.text).split(': ').slice(1).join(': ')), ['1 model withdrawn', '2 models withdrawn']);
});

test('a failed alert is resent on its own while its incident is open, only to the channel that missed it, and its recovery stops the resends', async () => {
  const { alerts, calls, failWhen } = harness({ telegram: { chatId: '42' }, webhook: { url: 'https://hooks.example/x' }, cooldownMinutes: 30 }, { retryMs: 5 });
  failWhen((url) => url.includes('hooks.example'));
  await alerts.record({ kind: 'upstream_credit', severity: 'critical', title: 'deepinfra is out of credit', providerId: 'deepinfra' });
  failWhen(() => false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.map((call) => call.url.includes('hooks.example') ? 'webhook' : 'telegram'), ['telegram', 'webhook', 'webhook'], 'resent to the webhook alone, once it took it');
  await alerts.record({ kind: 'upstream_credit_ok', severity: 'info', title: 'deepinfra has credit again', providerId: 'deepinfra' });
  assert.equal(calls.length, 5, 'both channels got the alert, both get the recovery');

  failWhen(() => true);
  await alerts.record(down);
  await alerts.record(up);
  const afterRecovery = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, afterRecovery, 'a recovered incident is not resent');
  alerts.close();
});

test('a quiet recovery closes an incident without a message', async () => {
  const { alerts, calls } = harness({ telegram: { chatId: '42' } });
  await alerts.record({ kind: 'upstream_balance_low', severity: 'warning', title: 'deepinfra is low', providerId: 'deepinfra' });
  await alerts.record({ kind: 'upstream_balance_ok', severity: 'info', title: 'deepinfra ran out', providerId: 'deepinfra' }, { journal: false, quiet: true });
  await alerts.record({ kind: 'upstream_balance_ok', severity: 'info', title: 'deepinfra is back', providerId: 'deepinfra' });
  assert.equal(calls.length, 1, 'closed quietly, so no recovery goes out later either');
});

test('a resent update goes only to the channel that missed it, and carries the newest news', async () => {
  const { alerts, calls, failWhen } = harness({ telegram: { chatId: '42' }, webhook: { url: 'https://hooks.example/x' }, cooldownMinutes: 30 }, { retryMs: 20 });
  const grouped = { kind: 'model_down', severity: 'warning', title: '1 model withdrawn', providerId: 'deepinfra' } as const;
  await alerts.record(grouped, { journal: false });
  failWhen((url) => url.includes('hooks.example'));
  await alerts.record({ ...grouped, title: '2 models withdrawn' }, { journal: false, update: true });
  await alerts.record({ ...grouped, title: '3 models withdrawn' }, { journal: false, update: true });
  failWhen(() => false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const sent = calls.map((call) => `${call.url.includes('hooks.example') ? 'webhook' : 'telegram'} ${String(call.body.text).split(': ').slice(1).join(': ')}`);
  assert.deepEqual(sent.filter((line) => line.startsWith('telegram')), ['telegram 1 model withdrawn', 'telegram 2 models withdrawn', 'telegram 3 models withdrawn'], 'telegram is not sent the resend');
  assert.equal(sent.at(-1), 'webhook 3 models withdrawn', 'the resend carries the latest count');
  alerts.close();
});

test('an alert held by the cooldown goes out with the latest news of its incident', async () => {
  const { alerts, calls, advance } = harness({ telegram: { chatId: '42' }, cooldownMinutes: 0.002 });
  const grouped = { kind: 'model_down', severity: 'warning', title: '1 model withdrawn', providerId: 'deepinfra' } as const;
  await alerts.record(grouped, { journal: false });
  await alerts.record({ kind: 'model_up', severity: 'info', title: 'all back', providerId: 'deepinfra' }, { journal: false });
  await alerts.record(grouped, { journal: false });
  await alerts.record({ ...grouped, title: '2 models withdrawn' }, { journal: false, update: true });
  assert.equal(calls.length, 2, 'the recurrence is held');
  advance(200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls.map((call) => String(call.body.text).split(': ').slice(1).join(': ')), ['1 model withdrawn', 'all back', '2 models withdrawn']);
  alerts.close();
});

test('a recovery that fails while a new outage waits behind it is not resent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-alerts-'));
  const texts: string[] = [];
  let release!: () => void;
  let stall = false;
  const alerts = new SellerAlerts({
    dataDir, config: { webhook: { url: 'https://hooks.example/x' }, cooldownMinutes: 30 }, sellerName: 'S', env: {}, retryMs: 5,
    fetch: (async (_url: string, init: RequestInit) => {
      texts.push(String(JSON.parse(String(init.body)).text).split(': ')[1]!.split('\n')[0]!);
      if (!stall) return new Response('{}', { status: 200 });
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response('{}', { status: 500 });
    }) as typeof fetch,
  });
  await alerts.record(down);
  stall = true;
  const recovering = alerts.record(up);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outage = alerts.record(down);
  stall = false;
  release();
  await Promise.all([recovering, outage]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(texts, ['glm-5.3 withdrawn', 'glm-5.3 back'], 'no stale "back" resend during the new outage');
  alerts.close();
});

test('malformed fields in the hand-editable overrides file are ignored', async () => {
  const { applyAlertOverrides } = await import('../../../seller-alerts/settings.js');
  const merged = applyAlertOverrides({ minSeverity: 'warning', lowBalanceUsd: 5 }, { minSeverity: 'warn' as never, lowBalanceUsd: 'ten' as never, idleMinutes: 15 });
  assert.deepEqual([merged.minSeverity, merged.lowBalanceUsd, merged.idleMinutes], ['warning', 5, 15]);
});
