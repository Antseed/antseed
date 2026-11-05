import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTRIBUTION_ENDPOINT_ENV,
  INSTALLER_NAME_FILE,
  createAttributionReporter,
  installTokenFromFilename,
  readInstallToken,
} from './attribution.js';
import { POSTHOG_HOST_ENV, POSTHOG_PROJECT_API_KEY_ENV, createTelemetryService } from './telemetry.js';
import { loadTelemetryState } from './state.js';

const TOKEN = '1.MTIzNDU2Nzg5MC4xMjM0NTY3ODkwfDE3NTc0OTkwMDB8MTc1NzUwMDAwMA.AAAAAAAAAAAAAAAAAAAAAA';
const BUYER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

type Sent = { url: string; body: Record<string, unknown> };

function fakeFetch(sent: Sent[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

async function makeTempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-attribution-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ── Stamp parsing ──

test('reads the token out of a stamped filename and nothing else', () => {
  assert.equal(installTokenFromFilename(`AntSeed-VPR-Setup-0.2.38.a-${TOKEN}.exe`), TOKEN);
  assert.equal(installTokenFromFilename(`AntSeed-VPR-0.2.38-x64.a-${TOKEN}.AppImage`), TOKEN);
  assert.equal(installTokenFromFilename('AntSeed-VPR-Setup-0.2.38.exe'), null);
  assert.equal(installTokenFromFilename(`AntSeed-VPR-Setup-0.2.38.a-${TOKEN} (1).exe`), null);
});

test('locates the stamp per platform', async () => {
  const files: Record<string, string> = {
    [join('/apps/AntSeed VPR', INSTALLER_NAME_FILE)]: `AntSeed-VPR-Setup-0.2.38.a-${TOKEN}.exe\r\n`,
  };
  const readTextFile = async (file: string) => {
    if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[file]!;
  };
  assert.equal(
    await readInstallToken({ platform: 'win32', execPath: '/apps/AntSeed VPR/AntSeed VPR.exe', env: {}, readTextFile }),
    TOKEN,
  );
  assert.equal(
    await readInstallToken({ platform: 'win32', execPath: '/elsewhere/AntSeed VPR.exe', env: {}, readTextFile }),
    null,
  );
  assert.equal(
    await readInstallToken({
      platform: 'linux',
      execPath: '/tmp/.mount/app',
      env: { APPIMAGE: `/home/u/Downloads/AntSeed-VPR-0.2.38-x64.a-${TOKEN}.AppImage` },
      readTextFile,
    }),
    TOKEN,
  );
  assert.equal(await readInstallToken({ platform: 'darwin', execPath: '/Applications/AntSeed VPR.app', env: {}, readTextFile }), null);
});

// ── Reporter ──

test('reporter posts milestones with token, install id and context, once when asked', async () => {
  const sent: Sent[] = [];
  const marked: string[] = [];
  let enabled = true;
  const reporter = createAttributionReporter({
    endpoint: 'https://download.example.com/',
    isEnabled: () => enabled,
    context: () => ({ platform: 'win32', arch: 'x64', appVersion: '1.2.3', installSource: 'nsis' }),
    getToken: () => TOKEN,
    getInstallId: () => '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b',
    hasSent: (name) => marked.includes(name),
    markSent: (name) => { marked.push(name); },
    fetchImpl: fakeFetch(sent),
  });
  await reporter.report('app_activated', { kind: 'tool_connected' }, { once: true });
  await reporter.report('app_activated', { kind: 'first_chat' }, { once: true });
  await reporter.report('deposit_completed', { amount_bucket: '5_25' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.url, 'https://download.example.com/app-events');
  assert.deepEqual(sent[0]!.body, {
    token: TOKEN,
    install_id: '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b',
    events: [{ name: 'app_activated', params: { platform: 'win32', arch: 'x64', app_version: '1.2.3', install_source: 'nsis', kind: 'tool_connected' } }],
  });
  assert.equal((sent[1]!.body['events'] as Array<{ name: string }>)[0]!.name, 'deposit_completed');

  enabled = false;
  await reporter.report('first_chat_started');
  assert.equal(sent.length, 2);
});

test('reporter swallows network failures', async () => {
  const reporter = createAttributionReporter({
    endpoint: 'https://download.example.com',
    isEnabled: () => true,
    context: () => ({ platform: 'linux', arch: 'x64', appVersion: '1.2.3', installSource: 'appimage' }),
    getToken: () => null,
    getInstallId: () => '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b',
    hasSent: () => false,
    markSent: () => {},
    fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
  });
  await reporter.report('app_first_opened');
});

// ── Integration with the telemetry service ──

function serviceOptions(dir: string, sent: Sent[], overrides: Record<string, unknown> = {}) {
  return {
    userDataDir: dir,
    isDev: false,
    appVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
    getDistinctId: () => BUYER_ADDRESS,
    hadExistingIdentity: false,
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [ATTRIBUTION_ENDPOINT_ENV]: 'https://download.example.com',
      APPIMAGE: `/home/u/Downloads/AntSeed-VPR-0.2.38-x64.a-${TOKEN}.AppImage`,
    } as NodeJS.ProcessEnv,
    transport: async () => {},
    heartbeatIntervalMs: null,
    execPath: '/tmp/.mount/app',
    attributionFetch: fakeFetch(sent),
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const names = (sent: Sent[]) => sent.map((s) => (s.body['events'] as Array<{ name: string; params: Record<string, unknown> }>)[0]!);

test('milestones flow from telemetry to the proxy, each once per install', async (t) => {
  const dir = await makeTempDir(t);
  const sent: Sent[] = [];
  const service = await createTelemetryService(serviceOptions(dir, sent));
  await service.recordAppStarted();
  await service.recordSetupStarted();
  await service.recordSetupCompleted();
  await service.recordDhtStarted(3);
  await service.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'codex' });
  await service.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'droid' });
  await service.recordUserAction({ action: 'route_mode_change', surface: 'model' });
  await service.recordFirstChatStarted({ serviceCategory: 'chat', hasAttachments: false }, async () => ({ hadDeposit: false, depositBucket: 'none' }));
  await service.recordDepositCredited('10000000');
  await service.recordDepositCredited('20000000');
  await settle();

  const events = names(sent);
  assert.deepEqual(events.map((e) => e.name), [
    'app_first_opened',
    'app_onboarded',
    'tool_connected',
    'app_activated',
    'first_chat_started',
    'deposit_completed',
    'deposit_completed',
  ]);
  assert.equal(events[3]!.params['kind'], 'tool_connected');
  assert.equal(events[2]!.params['app'], 'codex');
  assert.equal(events[5]!.params['is_first_deposit'], true);
  assert.equal(events[6]!.params['is_first_deposit'], false);
  assert.equal(sent[0]!.body['token'], TOKEN);

  const state = await loadTelemetryState(dir);
  assert.equal(state.attributionToken, TOKEN);
  assert.match(state.attributionInstallId ?? '', /^[0-9a-f-]{36}$/);
  assert.deepEqual(state.attributionSent, ['app_first_opened', 'app_onboarded', 'tool_connected', 'app_activated', 'first_chat_started']);

  // A second launch of the same install reports nothing it already sent.
  const again = await createTelemetryService(serviceOptions(dir, sent));
  await again.recordAppStarted();
  await again.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'codex' });
  await settle();
  assert.equal(sent.length, 7);
});

test('onboarded fires only once setup is complete and the network joined, in either order', async (t) => {
  const dir = await makeTempDir(t);
  const sent: Sent[] = [];
  const service = await createTelemetryService(serviceOptions(dir, sent));
  await service.recordAppStarted();
  await service.recordDhtStarted(2);
  await settle();
  assert.deepEqual(names(sent).map((e) => e.name), ['app_first_opened']);
  await service.recordSetupStarted();
  await service.recordSetupCompleted();
  await settle();
  assert.deepEqual(names(sent).map((e) => e.name), ['app_first_opened', 'app_onboarded']);
});

test('no reports when telemetry is opted out or disabled', async (t) => {
  const dir = await makeTempDir(t);
  const sent: Sent[] = [];
  const service = await createTelemetryService(serviceOptions(dir, sent));
  await service.setUserOptedOut(true);
  await service.recordAppStarted();
  await settle();
  assert.equal(sent.length, 0);

  const dev = await createTelemetryService(serviceOptions(await makeTempDir(t), sent, { isDev: true }));
  await dev.recordAppStarted();
  await settle();
  assert.equal(sent.length, 0);
});

test('an install without a stamp still reports, under its install id only', async (t) => {
  const dir = await makeTempDir(t);
  const sent: Sent[] = [];
  const service = await createTelemetryService(serviceOptions(dir, sent, {
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [ATTRIBUTION_ENDPOINT_ENV]: 'https://download.example.com',
    } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body['token'], null);
  assert.match(String(sent[0]!.body['install_id']), /^[0-9a-f-]{36}$/);
});

test('no endpoint configured means no reports and no install id', async (t) => {
  const dir = await makeTempDir(t);
  const sent: Sent[] = [];
  const service = await createTelemetryService(serviceOptions(dir, sent, {
    env: { [POSTHOG_HOST_ENV]: 'https://posthog.example.com', [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test' } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  await service.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'codex' });
  await settle();
  assert.equal(sent.length, 0);
  assert.equal((await loadTelemetryState(dir)).attributionInstallId, null);
});
