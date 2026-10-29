import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TELEMETRY_ENABLED_ENV,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_API_KEY_ENV,
  INSTALL_SOURCE_ENV,
  createTelemetryService,
  type TelemetryService,
  uuidV7,
} from './telemetry.js';
import { sanitizeTelemetryProperties } from './sanitize.js';
import { loadTelemetryState, saveTelemetryState, defaultTelemetryState } from './state.js';
import {
  classifyServiceCategory,
  countBucket,
  depositAmountBucket,
  durationBucket,
  daysSinceFirstOpenBucket,
  firstChatDepositSnapshot,
  httpStatusBucket,
  modelPricingSnapshot,
  offersAvailableBucket,
  publicModelId,
  sessionDurationBucket,
} from './events.js';
import {
  chatFailureHttpStatus,
  classifyChatFailureReason,
  classifyChatRequestFailure,
  classifyDepositFailure,
  classifyDiscoveryFailure,
} from './classify.js';
import {
  attemptCountBucket,
  depositStepAmountBucket,
  secsSinceAppStartBucket,
  secsSinceConnectBucket,
  stepGapBucket,
  telemetryHttpStatus,
  ttftBucket,
} from './events.js';
import { classifyChatStreamFailure } from '../chat/stream-stop.js';
import { conversationsShowRequestSince } from './connected-app-requests.js';
import type { PostHogCapturePayload } from './posthog.js';
import { TELEMETRY_ACTION_SURFACES, TELEMETRY_USER_ACTIONS } from '../../shared/telemetry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_FINISHED_EXTRAS = {
  failure_reason: 'request_rejected',
  attempt_count: '1',
  answered_by_different_seller: false,
  secs_since_app_start: 'under_30s',
  peers_discovered_at_send: true,
  sellers_known_bucket: '2_3',
  free_sellers_known_bucket: '0',
  ttft_bucket: 'none',
} as const;
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const BUYER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const IMPORTED_BUYER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

async function makeTempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type Captured = { payloads: PostHogCapturePayload[] };

function captureTransport(captured: Captured) {
  return async (payload: PostHogCapturePayload) => {
    captured.payloads.push(payload);
  };
}

function baseOptions(dir: string, captured: Captured, overrides: Record<string, unknown> = {}) {
  return {
    userDataDir: dir,
    isDev: false,
    appVersion: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    getDistinctId: () => BUYER_ADDRESS,
    hadExistingIdentity: false,
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
    } as NodeJS.ProcessEnv,
    transport: captureTransport(captured),
    heartbeatIntervalMs: null,
    startupTimeoutMs: null,
    ...overrides,
  };
}

// ── Enablement ──

test('disabled in development builds', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, { isDev: true }));
  assert.equal(service.available, false);
  assert.equal(service.enabled, false);
  await service.recordAppStarted();
  assert.equal(captured.payloads.length, 0);
});

test('disabled when TELEMETRY_ENABLED is false/0/no', async (t) => {
  for (const value of ['false', '0', 'no']) {
    const dir = await makeTempDir(t);
    const captured: Captured = { payloads: [] };
    const service = await createTelemetryService(baseOptions(dir, captured, {
      env: {
        [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
        [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
        [TELEMETRY_ENABLED_ENV]: value,
      } as NodeJS.ProcessEnv,
    }));
    assert.equal(service.enabled, false, `expected disabled for ${value}`);
    await service.recordAppStarted();
    assert.equal(captured.payloads.length, 0);
  }
});

test('disabled when PostHog host or key is missing', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, { env: {} as NodeJS.ProcessEnv }));
  assert.equal(service.enabled, false);
  await service.recordAppStarted();
  assert.equal(captured.payloads.length, 0);
});

test('disabled when PostHog host is invalid or not HTTPS', async (t) => {
  for (const host of ['not a url', 'http://posthog.example.com']) {
    const dir = await makeTempDir(t);
    const captured: Captured = { payloads: [] };
    const service = await createTelemetryService(baseOptions(dir, captured, {
      env: {
        [POSTHOG_HOST_ENV]: host,
        [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      } as NodeJS.ProcessEnv,
    }));
    assert.equal(service.enabled, false, `expected disabled for ${host}`);
  }
});

test('enabled in production with valid config', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(service.available, true);
  assert.equal(service.enabled, true);
});

// ── First-open / app-started ──

test('first launch emits app_first_opened and app_started with is_first_launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted();

  assert.equal(captured.payloads.length, 2);
  assert.equal(captured.payloads[0]?.event, 'app_first_opened');
  assert.match(String(captured.payloads[0]?.properties['first_open_date']), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(captured.payloads[1]?.event, 'app_started');
  assert.equal(captured.payloads[1]?.properties['is_first_launch'], true);
});

test('app_first_opened fires exactly once per installation', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted();
  await first.recordCleanShutdown();

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();

  const firstOpenEvents = captured.payloads.filter((p) => p.event === 'app_first_opened');
  assert.equal(firstOpenEvents.length, 1);
  const startedEvents = captured.payloads.filter((p) => p.event === 'app_started');
  assert.equal(startedEvents.length, 2);
  assert.equal(startedEvents[1]?.properties['is_first_launch'], false);
});

test('legacy installs with no telemetry state do not emit app_first_opened', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    hadExistingIdentity: true,
  }));
  await service.recordAppStarted();

  assert.equal(captured.payloads.some((payload) => payload.event === 'app_first_opened'), false);
  const started = captured.payloads.find((payload) => payload.event === 'app_started');
  assert.equal(started?.properties['is_first_launch'], false);
});

test('legacy installs with invalid telemetry state do not emit app_first_opened', async (t) => {
  const dir = await makeTempDir(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'telemetry-state.json'), '{}', 'utf8');
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    hadExistingIdentity: true,
  }));
  await service.recordAppStarted();

  assert.equal(captured.payloads.some((payload) => payload.event === 'app_first_opened'), false);
  assert.equal(captured.payloads.find((payload) => payload.event === 'app_started')?.properties['is_first_launch'], false);
});

test('stored telemetry state takes precedence over the legacy identity signal', async (t) => {
  const dir = await makeTempDir(t);
  await saveTelemetryState(dir, defaultTelemetryState());
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    hadExistingIdentity: true,
  }));
  await service.recordAppStarted();

  assert.equal(captured.payloads.filter((payload) => payload.event === 'app_first_opened').length, 1);
  assert.equal(captured.payloads.find((payload) => payload.event === 'app_started')?.properties['is_first_launch'], true);
});

test('normalized on-chain address is the stable distinct identifier', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured, {
    getDistinctId: () => BUYER_ADDRESS.toUpperCase(),
  }));
  await first.recordAppStarted();
  await first.recordCleanShutdown();
  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();

  const ids = new Set(captured.payloads.map((p) => p.distinct_id));
  assert.deepEqual([...ids], [BUYER_ADDRESS]);
  assert.equal(captured.payloads.every((p) => !('install_id' in p.properties)), true);
});

test('captures are skipped without a valid on-chain address', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    getDistinctId: () => 'not-an-address',
  }));

  assert.equal(service.available, true);
  assert.equal(service.enabled, false);
  await service.recordAppStarted();
  assert.equal(captured.payloads.length, 0);
});

test('captures use the current on-chain address after signer import', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  let address = BUYER_ADDRESS;
  const service = await createTelemetryService(baseOptions(dir, captured, {
    getDistinctId: () => address,
  }));
  await service.recordAppStarted();
  address = IMPORTED_BUYER_ADDRESS;
  await service.recordModelSelected({
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '1',
  }, 'deepseek-v4-flash:');

  assert.equal(captured.payloads[0]?.distinct_id, BUYER_ADDRESS);
  assert.equal(captured.payloads.at(-1)?.distinct_id, IMPORTED_BUYER_ADDRESS);
});

test('envelope includes schema/platform/arch/version/install_source', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [INSTALL_SOURCE_ENV]: 'dmg',
    } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  const props = captured.payloads[0]?.properties ?? {};
  assert.equal(props['schema_version'], 2);
  assert.equal(props['product'], 'desktop');
  assert.equal(props['platform'], 'darwin');
  assert.equal(props['arch'], 'arm64');
  assert.equal(props['app_version'], '1.2.3');
  assert.equal(props['install_source'], 'dmg');
  assert.equal(typeof props['session_id'], 'string');
  assert.equal(props['$session_id'], props['session_id']);
  assert.equal(typeof props['event_ts_ms'], 'number');
  assert.equal(props['$geoip_disable'], true);
  assert.equal('$ip' in props, false);
  assert.equal(props['$process_person_profile'], false);
  assert.equal('distinct_id' in props, false);
});

test('unknown INSTALL_SOURCE falls back to unknown', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [INSTALL_SOURCE_ENV]: 'sneaky-value',
    } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  assert.equal(captured.payloads[0]?.properties['install_source'], 'unknown');
});

// ── Crash recovery ──

test('unclean previous session emits recovered app_closed with was_crash on next launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(1_000);
  // No recordCleanShutdown — simulate crash.

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted(1_000 + 60_000);

  const recovered = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(recovered);
  assert.equal(recovered.properties['was_crash'], true);
  assert.equal(recovered.properties['session_duration_bucket'], 'under_30s');
  assert.equal(recovered.properties['event_ts_ms'], 1_000);
  const started = captured.payloads.filter((payload) => payload.event === 'app_started');
  assert.equal(recovered.properties['session_id'], started[0]?.properties['session_id']);
  assert.equal(recovered.properties['$session_id'], started[0]?.properties['session_id']);
  assert.notEqual(recovered.properties['session_id'], started[1]?.properties['session_id']);
});

test('launch session id is a UUIDv7 carrying the launch timestamp', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const launchedAt = 1_800_000_000_000;
  const service = await createTelemetryService(baseOptions(dir, captured, { nowMs: () => launchedAt }));
  await service.recordAppStarted();

  const sessionId = String(captured.payloads[0]?.properties['session_id']);
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const embeddedMs = parseInt(sessionId.replace(/-/g, '').slice(0, 12), 16);
  assert.equal(embeddedMs, launchedAt);
  assert.equal(new Set(captured.payloads.map((p) => p.properties['$session_id'])).size, 1);
});

test('uuidV7 yields distinct, monotonic-prefixed ids', () => {
  const a = uuidV7(1_000);
  const b = uuidV7(2_000);
  assert.notEqual(a, b);
  assert.ok(a.replace(/-/g, '').slice(0, 12) < b.replace(/-/g, '').slice(0, 12));
});

test('crash recovery uses the last heartbeat instead of time spent offline', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(1_000);
  const state = await loadTelemetryState(dir);
  state.lastSessionHeartbeatAtMs = 91_000;
  await saveTelemetryState(dir, state);

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted(10 * DAY_MS);

  const recovered = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(recovered);
  assert.equal(recovered.properties['session_duration_bucket'], '30s_2m');
  assert.equal(recovered.properties['event_ts_ms'], 91_000);
});

test('clean shutdown emits app_closed with was_crash false and no crash event next launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(0);
  await first.recordCleanShutdown(40 * 60_000);

  const closed = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(closed);
  assert.equal(closed.properties['was_crash'], false);
  assert.equal(closed.properties['session_duration_bucket'], 'over_30m');

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();
  const closedEvents = captured.payloads.filter((p) => p.event === 'app_closed');
  assert.equal(closedEvents.length, 1);
});

test('clean shutdown waits briefly for app_closed delivery', async (t) => {
  const dir = await makeTempDir(t);
  let closeDelivered = false;
  const service = await createTelemetryService({
    ...baseOptions(dir, { payloads: [] }),
    shutdownFlushTimeoutMs: 100,
    transport: async (payload) => {
      if (payload.event !== 'app_closed') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
      closeDelivered = true;
    },
  });

  await service.recordAppStarted(0);
  await service.recordCleanShutdown(60_000);

  assert.equal(closeDelivered, true);
});

// ── Setup / deposit / chat events ──

test('setup duration is bucketed', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordSetupStarted(1_000);
  await service.recordSetupCompleted(1_000 + 90_000);

  const setup = captured.payloads.find((p) => p.event === 'setup_completed');
  assert.ok(setup);
  assert.equal(setup.properties['duration_bucket'], '30s_2m');
});

test('runtime, DHT, and first peers emit once per launch with coarse counts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordNetworkRuntimeStarted(10_000);
  await service.recordNetworkRuntimeStarted(20_000);
  await service.recordDhtStarted(0, 20_000);
  await service.recordDhtStarted(4, 40_000);
  await service.recordDhtStarted(8, 50_000);
  await service.recordPeersDiscovered(0, 0, 60_000);
  await service.recordPeersDiscovered(7, 12, 3 * 60_000);
  await service.recordPeersDiscovered(20, 30, 4 * 60_000);

  const runtime = captured.payloads.filter((payload) => payload.event === 'network_runtime_started');
  const dht = captured.payloads.filter((payload) => payload.event === 'dht_started');
  const peers = captured.payloads.filter((payload) => payload.event === 'peers_discovered');
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0]?.properties['duration_bucket'], 'under_30s');
  assert.equal(dht.length, 1);
  assert.equal(dht[0]?.properties['routing_node_count_bucket'], '2_5');
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.properties['duration_bucket'], '2m_5m');
  assert.equal(peers[0]?.properties['peer_count_bucket'], '6_20');
  assert.equal(peers[0]?.properties['service_count_bucket'], '6_20');
});

test('first model shown emits once per launch with time-to-model context', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordFirstModelShown({
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '2_3',
  }, 45_000);
  await service.recordFirstModelShown({
    public_model_id: 'claude-sonnet-4-5',
    service_category: 'chat',
    route_mode: 'pinned',
    pricing_tier: 'paid',
    has_free_eligible_offer: false,
    eligible_offer_count_bucket: '1',
  }, 60_000);

  const shown = captured.payloads.filter((payload) => payload.event === 'first_model_shown');
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.properties['public_model_id'], 'deepseek-v4-flash');
  assert.equal(shown[0]?.properties['duration_bucket'], '30s_2m');
  assert.equal(shown[0]?.properties['pricing_tier'], 'free');
});

test('user actions identify the first meaningful action per launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordUserAction({ action: 'view_opened', surface: 'model' }, 10_000);
  await service.recordUserAction({ action: 'model_picker_open', surface: 'model' }, 40_000);

  const actions = captured.payloads.filter((payload) => payload.event === 'user_action');
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.properties['is_first_action'], true);
  assert.equal(actions[0]?.properties['duration_bucket'], 'under_30s');
  assert.equal(actions[1]?.properties['is_first_action'], false);
  assert.equal(actions[1]?.properties['duration_bucket'], '30s_2m');
});

test('app connect actions carry the app name and are not coalesced across apps', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'claude-desktop' }, 1_000);
  await service.recordUserAction({ action: 'app_connect', surface: 'apps', app: 'cursor' as never }, 2_000);
  await service.recordUserAction({ action: 'app_disconnect', surface: 'apps', app: 'telegram' }, 3_000);
  await service.recordUserAction({ action: 'chat_send', surface: 'chat' }, 4_000);

  let drainAttempts = 0;
  while (captured.payloads.filter((payload) => payload.event === 'user_action').length < 4) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    drainAttempts += 1;
    assert.ok(drainAttempts < 100, 'user action queue did not drain');
  }

  const actions = captured.payloads.filter((payload) => payload.event === 'user_action');
  assert.equal(actions.length, 4);
  assert.equal(actions[0]?.properties['app'], 'claude-desktop');
  assert.equal(actions[1]?.properties['app'], 'cursor');
  assert.equal(actions[2]?.properties['app'], 'telegram');
  assert.equal('app' in (actions[3]?.properties ?? {}), false);
});

test('setup completion requires a started transition and emits once across restarts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(0);
  await first.recordSetupCompleted(5_000);
  assert.equal(captured.payloads.some((p) => p.event === 'setup_completed'), false);

  await first.recordSetupStarted(10_000);
  await first.recordSetupCompleted(50_000);
  await first.recordSetupCompleted(60_000);

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordSetupStarted(70_000);
  await second.recordSetupCompleted(80_000);
  assert.equal(captured.payloads.filter((p) => p.event === 'setup_completed').length, 1);
});

test('deposit_completed sends buckets only, never exact amounts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('12345678', 0); // $12.345678

  const deposit = captured.payloads.find((p) => p.event === 'deposit_completed');
  assert.ok(deposit);
  assert.equal(deposit.properties['amount_bucket'], '5_25');
  assert.equal(deposit.properties['is_first_deposit'], true);
  assert.equal(deposit.properties['days_since_first_open'], '0');
  // The exact amount must appear nowhere in the event properties.
  const serialized = JSON.stringify(deposit.properties);
  assert.equal(serialized.includes('12345678'), false);
  assert.equal(serialized.includes('12.345678'), false);
});

test('deposit_completed is_first_deposit flips after the first deposit', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('1000000', 0);
  await service.recordDepositCredited('200000000', 0);

  const deposits = captured.payloads.filter((p) => p.event === 'deposit_completed');
  assert.equal(deposits.length, 2);
  assert.equal(deposits[0]?.properties['is_first_deposit'], true);
  assert.equal(deposits[1]?.properties['is_first_deposit'], false);
});

test('deposit_failed sends only a fixed failure taxonomy', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  const rawError = 'No deposit relayers are reachable for peer 12D3KooSecret at 0xabc123';
  await service.recordDepositFailed(classifyDepositFailure(rawError), 0);

  const failed = captured.payloads.find((payload) => payload.event === 'deposit_failed');
  assert.ok(failed);
  assert.equal(failed.properties['method_category'], 'usdc');
  assert.equal(failed.properties['failure_code'], 'relayer_unreachable');
  assert.equal(failed.properties['failure_stage'], 'dispatch');
  assert.equal(failed.properties['retryable'], true);
  assert.equal(JSON.stringify(failed).includes('12D3KooSecret'), false);
  assert.equal(JSON.stringify(failed).includes('0xabc123'), false);
});

test('chat_request_finished records model failures without raw peer errors', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  const rawError = 'Service "deepseek-v4-flash" is not served by this peer 12D3KooSecret.';
  const failure = classifyChatRequestFailure({
    kind: 'http_error',
    source: 'upstream',
    retryable: false,
    statusCode: 400,
  }, rawError);
  await service.recordChatRequestFinished({
    request_id: REQUEST_ID,
    outcome: 'failed',
    failure_code: failure.failureCode,
    failure_stage: failure.failureStage,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    offers_available_bucket: '2_3',
    http_status_bucket: '4xx',
    retryable: failure.retryable,
    automatic_retry_attempted: true,
    automatic_retry_succeeded: false,
    had_partial_output: false,
    duration_bucket: 'under_30s',
    has_attachments: false,
    ...CHAT_FINISHED_EXTRAS,
  }, 0);

  const finished = captured.payloads.find((payload) => payload.event === 'chat_request_finished');
  assert.ok(finished);
  assert.equal(finished.properties['failure_code'], 'model_not_served_by_peer');
  assert.equal(finished.properties['failure_stage'], 'request_validation');
  assert.equal(finished.properties['retryable'], true);
  assert.equal(JSON.stringify(finished).includes('12D3KooSecret'), false);
  assert.equal(JSON.stringify(finished).includes('not served'), false);
});

test('model selection and chat start share privacy-safe pricing context', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordModelSelected({
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'mixed',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '2_3',
  }, 'deepseek-v4-flash:', 0);
  await service.recordChatRequestStarted({
    request_id: REQUEST_ID,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'mixed',
    has_free_eligible_offer: true,
    offers_available_bucket: '2_3',
    has_attachments: false,
  }, 1);

  const selected = captured.payloads.find((payload) => payload.event === 'model_selected');
  const started = captured.payloads.find((payload) => payload.event === 'chat_request_started');
  assert.ok(selected);
  assert.ok(started);
  assert.equal(selected.properties['pricing_tier'], 'mixed');
  assert.equal(selected.properties['has_free_eligible_offer'], true);
  assert.equal(started.properties['request_id'], REQUEST_ID);
});

test('paired model persistence paths emit one effective selection', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  const selection = {
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat' as const,
    route_mode: 'pinned' as const,
    pricing_tier: 'paid' as const,
    has_free_eligible_offer: false,
    eligible_offer_count_bucket: '1' as const,
  };

  await service.recordModelSelected(selection, 'deepseek-v4-flash:peer-a', 0);
  await service.recordModelSelected(selection, 'deepseek-v4-flash:peer-a', 1);
  await service.recordModelSelected(selection, 'deepseek-v4-flash:peer-b', 2);

  assert.equal(captured.payloads.filter((payload) => payload.event === 'model_selected').length, 2);
});

test('discovery_failed records only a fixed failure code and duration', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordDiscoveryFailed({
    duration_bucket: '30s_2m',
    failure_code: 'timeout',
  }, 0);

  const discovery = captured.payloads.find((payload) => payload.event === 'discovery_failed');
  assert.ok(discovery);
  assert.deepEqual({
    duration_bucket: discovery.properties['duration_bucket'],
    failure_code: discovery.properties['failure_code'],
  }, {
    duration_bucket: '30s_2m',
    failure_code: 'timeout',
  });
});

test('first_chat_started fires once and records the immediate deposit snapshot', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('10000000', 0);
  let snapshotCalls = 0;
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: false,
  }, async () => {
    snapshotCalls += 1;
    return { hadDeposit: true, depositBucket: '5_25' };
  }, DAY_MS);
  await service.recordFirstChatStarted({
    serviceCategory: 'image',
    hasAttachments: true,
  }, async () => {
    snapshotCalls += 1;
    return { hadDeposit: true, depositBucket: '100_plus' };
  }, DAY_MS);

  const chats = captured.payloads.filter((p) => p.event === 'first_chat_started');
  assert.equal(snapshotCalls, 1);
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.properties['had_deposit'], true);
  assert.equal(chats[0]?.properties['deposit_bucket'], '5_25');
  assert.equal(chats[0]?.properties['days_since_first_open'], '1_7');
  assert.equal(chats[0]?.properties['service_category'], 'chat');
  assert.equal(chats[0]?.properties['has_attachments'], false);
});

test('first_chat_started without a deposit reports had_deposit false', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: true,
  }, async () => ({ hadDeposit: false, depositBucket: 'none' }), 0);

  const chat = captured.payloads.find((p) => p.event === 'first_chat_started');
  assert.ok(chat);
  assert.equal(chat.properties['had_deposit'], false);
  assert.equal(chat.properties['deposit_bucket'], 'none');
});

test('first_chat_started uses the immediate balance snapshot, not deposit event history', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('10000000', 0);
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: false,
  }, async () => ({ hadDeposit: false, depositBucket: 'none' }), 0);

  const chat = captured.payloads.find((p) => p.event === 'first_chat_started');
  assert.ok(chat);
  assert.equal(chat.properties['had_deposit'], false);
  assert.equal(chat.properties['deposit_bucket'], 'none');
});

test('first_chat_started skips deposit snapshots when unavailable, opted out, or already recorded', async (t) => {
  const unavailableDir = await makeTempDir(t);
  const unavailable = await createTelemetryService(baseOptions(
    unavailableDir,
    { payloads: [] },
    { isDev: true },
  ));
  let snapshotCalls = 0;
  const snapshot = async () => {
    snapshotCalls += 1;
    return { hadDeposit: false, depositBucket: 'none' } as const;
  };

  await unavailable.recordFirstChatStarted({ serviceCategory: 'chat', hasAttachments: false }, snapshot);

  const optedOutDir = await makeTempDir(t);
  const optedOut = await createTelemetryService(baseOptions(optedOutDir, { payloads: [] }));
  await optedOut.setUserOptedOut(true);
  await optedOut.recordFirstChatStarted({ serviceCategory: 'chat', hasAttachments: false }, snapshot);

  const recordedDir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(recordedDir, captured));
  await first.recordFirstChatStarted({ serviceCategory: 'chat', hasAttachments: false }, snapshot);
  const second = await createTelemetryService(baseOptions(recordedDir, captured));
  await second.recordFirstChatStarted({ serviceCategory: 'image', hasAttachments: true }, snapshot);

  assert.equal(snapshotCalls, 1);
  assert.equal(captured.payloads.filter((payload) => payload.event === 'first_chat_started').length, 1);
});

test('first_chat_started claims the snapshot before concurrent chats can read it', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  let snapshotCalls = 0;
  let resolveSnapshot: ((snapshot: { hadDeposit: true; depositBucket: '5_25' }) => void) | undefined;
  const pendingSnapshot = new Promise<{ hadDeposit: true; depositBucket: '5_25' }>((resolve) => {
    resolveSnapshot = resolve;
  });
  const snapshot = async () => {
    snapshotCalls += 1;
    return pendingSnapshot;
  };

  const first = service.recordFirstChatStarted({ serviceCategory: 'chat', hasAttachments: false }, snapshot);
  const second = service.recordFirstChatStarted({ serviceCategory: 'image', hasAttachments: true }, snapshot);
  assert.equal(snapshotCalls, 1);

  resolveSnapshot?.({ hadDeposit: true, depositBucket: '5_25' });
  await Promise.all([first, second]);

  const chats = captured.payloads.filter((payload) => payload.event === 'first_chat_started');
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.properties['service_category'], 'chat');
});

test('first_chat_started releases its claim after snapshot failure, null data, or opt-out', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));

  await assert.rejects(
    service.recordFirstChatStarted(
      { serviceCategory: 'chat', hasAttachments: false },
      async () => { throw new Error('RPC unavailable'); },
    ),
  );
  await service.recordFirstChatStarted(
    { serviceCategory: 'chat', hasAttachments: false },
    async () => null,
  );

  let resolveSnapshot: ((snapshot: { hadDeposit: false; depositBucket: 'none' }) => void) | undefined;
  const pendingSnapshot = new Promise<{ hadDeposit: false; depositBucket: 'none' }>((resolve) => {
    resolveSnapshot = resolve;
  });
  const pending = service.recordFirstChatStarted(
    { serviceCategory: 'chat', hasAttachments: false },
    async () => pendingSnapshot,
  );
  await service.setUserOptedOut(true);
  resolveSnapshot?.({ hadDeposit: false, depositBucket: 'none' });
  await pending;
  assert.equal(captured.payloads.filter((payload) => payload.event === 'first_chat_started').length, 0);

  await service.setUserOptedOut(false);
  await service.recordFirstChatStarted(
    { serviceCategory: 'image', hasAttachments: true },
    async () => ({ hadDeposit: true, depositBucket: '25_100' }),
  );
  const chats = captured.payloads.filter((payload) => payload.event === 'first_chat_started');
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.properties['service_category'], 'image');
});

test('user action delivery has one in-flight request and a bounded pending queue', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const pendingDeliveries: Array<() => void> = [];
  let activeDeliveries = 0;
  let maxActiveDeliveries = 0;
  const service = await createTelemetryService(baseOptions(dir, captured, {
    transport: async (payload: PostHogCapturePayload) => {
      captured.payloads.push(payload);
      activeDeliveries += 1;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
      await new Promise<void>((resolve) => {
        pendingDeliveries.push(() => {
          activeDeliveries -= 1;
          resolve();
        });
      });
    },
  }));

  for (let index = 0; index < 40; index += 1) {
    await service.recordUserAction({
      action: TELEMETRY_USER_ACTIONS[index % TELEMETRY_USER_ACTIONS.length]!,
      surface: TELEMETRY_ACTION_SURFACES[Math.floor(index / TELEMETRY_USER_ACTIONS.length)]!,
    }, index);
  }

  let drainAttempts = 0;
  while (
    captured.payloads.filter((payload) => payload.event === 'user_action').length < 33
    || activeDeliveries > 0
  ) {
    pendingDeliveries.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    drainAttempts += 1;
    assert.ok(drainAttempts < 100, 'user action queue did not drain');
  }

  const actions = captured.payloads.filter((payload) => payload.event === 'user_action');
  assert.equal(maxActiveDeliveries, 1);
  assert.equal(actions.length, 33);
  assert.equal(actions.at(-1)?.properties['event_ts_ms'], 39);
});

test('user action delivery coalesces duplicate pending action and surface pairs', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const pendingDeliveries: Array<() => void> = [];
  const service = await createTelemetryService(baseOptions(dir, captured, {
    transport: async (payload: PostHogCapturePayload) => {
      captured.payloads.push(payload);
      await new Promise<void>((resolve) => pendingDeliveries.push(resolve));
    },
  }));

  await service.recordUserAction({ action: 'chat_send', surface: 'chat' }, 1);
  await service.recordUserAction({ action: 'routing_preferences_change', surface: 'preferences' }, 2);
  await service.recordUserAction({ action: 'routing_preferences_change', surface: 'preferences' }, 3);
  await service.recordUserAction({ action: 'routing_preferences_change', surface: 'preferences' }, 4);

  pendingDeliveries.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captured.payloads.filter((payload) => payload.event === 'user_action').length, 2);
  assert.equal(captured.payloads.at(-1)?.properties['event_ts_ms'], 4);

  pendingDeliveries.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

// ── Opt-out ──

test('user opt-out disables telemetry and persists across restarts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(first.isUserOptedOut(), false);
  await first.recordAppStarted();
  const beforeOptOut = captured.payloads.length;

  await first.setUserOptedOut(true);
  assert.equal(first.enabled, false);
  await first.recordCleanShutdown();
  assert.equal(captured.payloads.length, beforeOptOut);

  const second = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(second.isUserOptedOut(), true);
  assert.equal(second.enabled, false);
  await second.recordAppStarted();
  assert.equal(captured.payloads.length, beforeOptOut);
});

test('opt-in again re-enables telemetry', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.setUserOptedOut(true);
  await service.setUserOptedOut(false);
  assert.equal(service.enabled, true);
});

test('session milestones remain observable after opting in mid-session', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.setUserOptedOut(true);
  await service.recordNetworkRuntimeStarted(1_000);
  await service.recordDhtStarted(3, 2_000);
  await service.recordPeersDiscovered(2, 4, 3_000);
  await service.setUserOptedOut(false);
  await service.recordNetworkRuntimeStarted(4_000);
  await service.recordDhtStarted(3, 5_000);
  await service.recordPeersDiscovered(2, 4, 6_000);

  assert.equal(captured.payloads.filter((payload) => payload.event === 'network_runtime_started').length, 1);
  assert.equal(captured.payloads.filter((payload) => payload.event === 'dht_started').length, 1);
  assert.equal(captured.payloads.filter((payload) => payload.event === 'peers_discovered').length, 1);
});

// ── Sanitizer ──

test('sanitizer drops unknown properties and unsupported types', () => {
  const sanitized = sanitizeTelemetryProperties('app_started', {
    is_first_launch: true,
    ...({ wallet_address: '0xabc', nested: { a: 1 }, list: [1, 2] } as object),
  } as never);
  assert.deepEqual(sanitized, { is_first_launch: true });
});

test('sanitizer drops a value of the wrong type for an enum or pattern key', () => {
  const sanitized = sanitizeTelemetryProperties('chat_request_finished', {
    ...({ outcome: true, failure_reason: 7, public_model_id: 123, request_id: false, http_status: '503' } as object),
  } as never);
  assert.deepEqual(sanitized, {});
});

test('sanitizer truncates long strings and bounds numbers', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_completed', {
    method_category: 'x'.repeat(500),
    amount_bucket: 'under_5',
    is_first_deposit: false,
    days_since_first_open: '0',
    ...({ huge: Number.POSITIVE_INFINITY } as object),
  } as never);
  assert.equal(String(sanitized['method_category']).length, 64);
  assert.equal('huge' in sanitized, false);
});

test('sanitizer drops invalid bucket values', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_completed', {
    method_category: 'usdc',
    amount_bucket: 'exactly_42_dollars',
    is_first_deposit: true,
    days_since_first_open: '0',
  } as never);
  assert.equal('amount_bucket' in sanitized, false);
});

test('sanitizer applies event-specific failure enums', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_failed', {
    method_category: 'usdc',
    failure_code: 'model_not_served_by_peer',
    failure_stage: 'request_validation',
    retryable: true,
  } as never);
  assert.deepEqual(sanitized, { method_category: 'usdc', retryable: true });
});

test('discovery failures are reduced to fixed local categories', () => {
  assert.equal(classifyDiscoveryFailure('Request timed out after 30 seconds'), 'timeout');
  assert.equal(classifyDiscoveryFailure('Unexpected token while parsing JSON'), 'invalid_data');
  assert.equal(classifyDiscoveryFailure('ENOENT while reading peer state file'), 'io_error');
  assert.equal(classifyDiscoveryFailure('Discovery failed'), 'unknown');
});

test('sanitizer accepts only fixed user action and surface values', () => {
  assert.deepEqual(sanitizeTelemetryProperties('user_action', {
    action: 'chat_send',
    surface: 'chat',
    duration_bucket: 'under_30s',
    is_first_action: true,
  }), {
    action: 'chat_send',
    surface: 'chat',
    duration_bucket: 'under_30s',
    is_first_action: true,
  });
  assert.deepEqual(sanitizeTelemetryProperties('user_action', {
    action: 'raw_button_label',
    surface: '/private/path',
    duration_bucket: 'under_30s',
    is_first_action: false,
  } as never), {
    duration_bucket: 'under_30s',
    is_first_action: false,
  });
});

test('sanitizer accepts only random UUID request correlation IDs', () => {
  const valid = sanitizeTelemetryProperties('chat_request_started', {
    request_id: REQUEST_ID,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    offers_available_bucket: '1',
    has_attachments: false,
  });
  assert.equal(valid['request_id'], REQUEST_ID);

  const invalid = sanitizeTelemetryProperties('chat_request_started', {
    request_id: 'conversation-or-wallet-derived-id',
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    offers_available_bucket: '1',
    has_attachments: false,
  });
  assert.equal('request_id' in invalid, false);
});

// ── State persistence ──

test('corrupt state file falls back to milestone defaults', async (t) => {
  const dir = await makeTempDir(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'telemetry-state.json'), 'not json at all', 'utf8');
  const state = await loadTelemetryState(dir);
  assert.equal(state.hasEmittedFirstOpen, false);
});

test('legacy install id is ignored while milestones are preserved', async (t) => {
  const dir = await makeTempDir(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'telemetry-state.json'), JSON.stringify({
    ...defaultTelemetryState(),
    installId: 'legacy-random-id',
    hasCompletedSetup: true,
  }), 'utf8');
  const loaded = await loadTelemetryState(dir);
  assert.equal('installId' in loaded, false);
  assert.equal(loaded.hasCompletedSetup, true);
});

// ── Bucket helpers ──

test('bucket helpers classify correctly', () => {
  assert.equal(durationBucket(10_000), 'under_30s');
  assert.equal(durationBucket(60_000), '30s_2m');
  assert.equal(durationBucket(3 * 60_000), '2m_5m');
  assert.equal(durationBucket(6 * 60_000), 'over_5m');
  assert.equal(sessionDurationBucket(60 * 60_000), 'over_30m');
  assert.equal(depositAmountBucket(3), 'under_5');
  assert.equal(depositAmountBucket(10), '5_25');
  assert.equal(depositAmountBucket(50), '25_100');
  assert.equal(depositAmountBucket(500), '100_plus');
  assert.equal(daysSinceFirstOpenBucket(0), '0');
  assert.equal(daysSinceFirstOpenBucket(3), '1_7');
  assert.equal(daysSinceFirstOpenBucket(20), '8_30');
  assert.equal(daysSinceFirstOpenBucket(90), '31_plus');
  assert.equal(countBucket(0), '0');
  assert.equal(countBucket(4), '2_5');
  assert.equal(countBucket(21), '21_plus');
  assert.equal(offersAvailableBucket(3), '2_3');
  assert.equal(httpStatusBucket(400), '4xx');
  assert.equal(httpStatusBucket(503), '5xx');
  assert.equal(publicModelId('DeepSeek-V4-Flash', true), 'deepseek-v4-flash');
  assert.equal(publicModelId('private model name', true), 'custom_or_unknown');
  assert.equal(publicModelId('seller-specific-campaign-abc123', true), 'custom_or_unknown');
  assert.equal(publicModelId('deepseek-v4-flash', false), 'custom_or_unknown');
  // Every spelling is one model, and a made-up vendor path is never sent.
  assert.equal(publicModelId('anthropic/claude-opus-4-6', true), 'claude-opus-4.6');
  assert.equal(publicModelId('acme-secret-corp/claude-opus-4-6', true), 'claude-opus-4.6');
  assert.equal(publicModelId('claude-opus-4.6', true), 'claude-opus-4.6');
  assert.deepEqual(modelPricingSnapshot([
    { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  ]), {
    pricingTier: 'mixed',
    hasFreeEligibleOffer: true,
    eligibleOfferCountBucket: '2_3',
  });
  assert.deepEqual(modelPricingSnapshot([]), {
    pricingTier: 'unknown',
    hasFreeEligibleOffer: false,
    eligibleOfferCountBucket: '0',
  });
  assert.deepEqual(modelPricingSnapshot([
    { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.5 },
  ]), {
    pricingTier: 'paid',
    hasFreeEligibleOffer: false,
    eligibleOfferCountBucket: '1',
  });
  assert.equal(classifyServiceCategory('claude-sonnet-4-5'), 'chat');
  assert.equal(classifyServiceCategory('dall-e-3'), 'image');
  assert.equal(classifyServiceCategory('flux-schnell'), 'image');
  assert.equal(classifyServiceCategory('whisper-large-v3'), 'other');
  assert.deepEqual(firstChatDepositSnapshot('0'), { hadDeposit: false, depositBucket: 'none' });
  assert.deepEqual(firstChatDepositSnapshot('12.5'), { hadDeposit: true, depositBucket: '5_25' });
  assert.equal(firstChatDepositSnapshot('not-a-number'), null);
});

test('failure classifiers cover deposit and chat failure modes', () => {
  assert.deepEqual(classifyDepositFailure('', 'payments-disabled'), {
    failureCode: 'payments_disabled',
    failureStage: 'preflight',
    retryable: false,
  });
  assert.deepEqual(classifyDepositFailure('USDC EIP-712 domain mismatch'), {
    failureCode: 'domain_mismatch',
    failureStage: 'signing',
    retryable: false,
  });
  assert.deepEqual(classifyChatRequestFailure({
    kind: 'http_error',
    source: 'upstream',
    retryable: false,
    statusCode: 400,
  }, 'data: {"error":{"code":"model_not_found"}}'), {
    failureCode: 'model_not_served_by_peer',
    failureStage: 'request_validation',
    retryable: true,
    statusCode: 400,
  });
  assert.deepEqual(classifyChatRequestFailure({
    kind: 'stream_error',
    source: 'upstream',
    retryable: false,
  }, 'The stream stopped before completion: 400 data: {"error":{"code":"model_not_found"}}'), {
    failureCode: 'model_not_served_by_peer',
    failureStage: 'request_validation',
    retryable: true,
    statusCode: 400,
  });
});

// ── Transport failure isolation ──

test('transport failures never reject or throw', async (t) => {
  const dir = await makeTempDir(t);
  const service: TelemetryService = await createTelemetryService({
    ...baseOptions(dir, { payloads: [] }),
    transport: async () => { throw new Error('PostHog down'); },
  });
  await service.recordAppStarted();
  await service.recordCleanShutdown();
});

// ── Funnel and reliability events ──

function eventsNamed(captured: Captured, name: string) {
  return captured.payloads.filter((payload) => payload.event === name);
}

test('deposit_step tracks the chosen method, reopened checkouts and step gaps', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositStep({ step: 'method_shown' }, 1_000);
  await service.recordDepositStep({ step: 'method_chosen', method: 'card', amountUsdc: 20 }, 5_000);
  await service.recordDepositStep({ step: 'checkout_opened', method: 'card', amountUsdc: 20 }, 30_000);
  await service.recordDepositStep({ step: 'checkout_opened', method: 'card' }, 200_000);
  await service.recordDepositCredited('20000000', 600_000);

  const steps = eventsNamed(captured, 'deposit_step').map((payload) => payload.properties);
  assert.deepEqual(steps.map((props) => props['step']), [
    'method_shown', 'method_chosen', 'checkout_opened', 'checkout_reopened', 'credited',
  ]);
  assert.equal(steps[0]?.['method'], 'unknown');
  assert.equal(steps[0]?.['secs_since_prev_step'], 'first');
  assert.equal(steps[1]?.['method'], 'card');
  assert.equal(steps[1]?.['amount_bucket'], '10_50');
  assert.equal(steps[1]?.['secs_since_prev_step'], 'under_10s');
  assert.equal(steps[2]?.['secs_since_prev_step'], '10s_1m');
  assert.equal(steps[3]?.['secs_since_prev_step'], '1m_5m');
  assert.equal('amount_bucket' in (steps[3] ?? {}), false);
  assert.equal(steps[4]?.['method'], 'card');
  assert.equal(steps[4]?.['amount_bucket'], '10_50');
  assert.equal(steps[4]?.['secs_since_prev_step'], 'over_5m');
  assert.equal(JSON.stringify(steps).includes('20000000'), false);

  const completed = eventsNamed(captured, 'deposit_completed')[0];
  assert.equal(completed?.properties['method'], 'card');
  assert.equal(completed?.properties['method_category'], 'usdc');
});

test('deposit_completed reports unknown method when no method was chosen', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('5000000', 0);
  assert.equal(eventsNamed(captured, 'deposit_completed')[0]?.properties['method'], 'unknown');
});

test('startup_finished reports success once at the first visible model', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordNetworkRuntimeStarted(1_000);
  await service.recordDhtStarted(3, 2_000);
  await service.recordPeersDiscovered(4, 4, 10_000);
  const model = {
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '2_3',
  } as const;
  await service.recordFirstModelShown(model, 40_000);
  await service.recordStartupFinished({ outcome: 'failed', failureStage: 'models' }, 50_000);

  const finished = eventsNamed(captured, 'startup_finished');
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0]?.properties && {
    outcome: finished[0].properties['outcome'],
    failure_stage: finished[0].properties['failure_stage'],
    duration_bucket: finished[0].properties['duration_bucket'],
  }, { outcome: 'success', failure_stage: 'none', duration_bucket: '30s_2m' });
});

test('startup_finished failure names the first stage not reached', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordNetworkRuntimeStarted(1_000);
  await service.recordDhtStarted(0, 2_000);
  await service.recordStartupFinished({ outcome: 'failed', failureStage: 'none' }, 180_000);

  const finished = eventsNamed(captured, 'startup_finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.properties['outcome'], 'failed');
  assert.equal(finished[0]?.properties['failure_stage'], 'dht');
  assert.equal(finished[0]?.properties['duration_bucket'], '2m_5m');
});

test('startup timer reports a stalled startup as failed', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, { startupTimeoutMs: 20 }));
  await service.recordAppStarted();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const finished = eventsNamed(captured, 'startup_finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.properties['outcome'], 'failed');
  assert.equal(finished[0]?.properties['failure_stage'], 'runtime');
  await service.recordCleanShutdown();
});

test('premium_blocked follow-up resolves once: deposit, free model, or left', async (t) => {
  const premium = { public_model_id: 'claude-sonnet-4-5', service_category: 'chat' } as const;
  const freeSelection = {
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '1',
  } as const;

  for (const [label, act, expected] of [
    ['deposit', (s: TelemetryService) => s.recordDepositCredited('10000000', 2_000), 'deposited'],
    ['free model', (s: TelemetryService) => s.recordModelSelected(freeSelection, 'free:', 2_000), 'switched_free_model'],
    ['left', (s: TelemetryService) => s.recordCleanShutdown(2_000), 'left'],
  ] as const) {
    const dir = await makeTempDir(t);
    const captured: Captured = { payloads: [] };
    const service = await createTelemetryService(baseOptions(dir, captured));
    await service.recordAppStarted(0);
    await service.recordPremiumBlocked(premium, 1_000);
    await act(service);
    await service.recordCleanShutdown(3_000);
    const blocked = eventsNamed(captured, 'premium_blocked');
    assert.equal(blocked.length, 1, label);
    assert.equal(blocked[0]?.properties['public_model_id'], 'claude-sonnet-4-5');
    const followups = eventsNamed(captured, 'premium_blocked_followup');
    assert.equal(followups.length, 1, label);
    assert.equal(followups[0]?.properties['next_action'], expected, label);
  }
});

test('withdraw_completed only follows a withdraw started this launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordWithdrawCompleted(1_000);
  assert.equal(eventsNamed(captured, 'withdraw_completed').length, 0);
  await service.recordWithdrawStarted(2_000);
  await service.recordWithdrawCompleted(3_000);
  await service.recordWithdrawCompleted(4_000);
  assert.equal(eventsNamed(captured, 'withdraw_started').length, 1);
  assert.equal(eventsNamed(captured, 'withdraw_completed').length, 1);
});

test('an abandoned withdraw is not completed by a later deposit', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordWithdrawStarted(1_000);
  // The user leaves the withdraw page and opens a deposit page instead.
  service.clearPendingWithdraw();
  await service.recordWithdrawCompleted(2_000);
  assert.equal(eventsNamed(captured, 'withdraw_started').length, 1);
  assert.equal(eventsNamed(captured, 'withdraw_completed').length, 0);
});

test('connected_app_first_request reports the first request or none at shutdown', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordConnectedAppConnected('opencode', 1_000);
  await service.recordConnectedAppConnected('codex', 1_000);
  await service.recordConnectedAppRequest('opencode', 100_000);
  await service.recordConnectedAppRequest('opencode', 200_000);
  await service.recordCleanShutdown(300_000);

  const events = eventsNamed(captured, 'connected_app_first_request').map((payload) => payload.properties);
  assert.equal(events.length, 2);
  const opencode = events.find((props) => props['app'] === 'opencode');
  const codex = events.find((props) => props['app'] === 'codex');
  assert.equal(opencode?.['outcome'], 'request_seen');
  assert.equal(opencode?.['secs_since_connect'], '1_5m');
  assert.equal(codex?.['outcome'], 'no_request');
  assert.equal(codex?.['secs_since_connect'], 'none');
});

test('runtime_stopped_on_window_close waits for delivery', async (t) => {
  const dir = await makeTempDir(t);
  let delivered: unknown = null;
  const service = await createTelemetryService({
    ...baseOptions(dir, { payloads: [] }),
    shutdownFlushTimeoutMs: 100,
    transport: async (payload) => {
      if (payload.event !== 'runtime_stopped_on_window_close') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
      delivered = payload.properties['runtime_was_running'];
    },
  });
  await service.recordAppStarted(0);
  await service.recordRuntimeStoppedOnWindowClose(true, 1_000);
  assert.equal(delivered, true);
});

test('sanitizer drops seller fields (the buyer reports the seller) and validates new enums', () => {
  const sanitized = sanitizeTelemetryProperties('chat_request_finished', {
    request_id: REQUEST_ID,
    failure_reason: 'seller_5xx',
    http_status: 502,
    seller_hash: 'abc123abc123',
    attempt_count: '2',
    sellers_tried: '1',
    seller_tier: 'paid',
    fell_back: true,
    ttft_bucket: 'under_1s',
  } as never);
  assert.equal('seller_hash' in sanitized, false);
  assert.equal(sanitized['failure_reason'], 'seller_5xx');
  assert.equal(sanitized['http_status'], 502);
  assert.equal(sanitized['attempt_count'], '2');
  // The buyer reports which sellers were tried; the desktop no longer sends its guesses.
  assert.equal('sellers_tried' in sanitized, false);
  assert.equal('seller_tier' in sanitized, false);
  assert.equal('fell_back' in sanitized, false);
  assert.equal(sanitized['ttft_bucket'], 'under_1s');

  const badStatus = sanitizeTelemetryProperties('chat_request_finished', {
    failure_reason: 'raw peer text',
    http_status: 42,
  } as never);
  assert.deepEqual(badStatus, {});

  const step = sanitizeTelemetryProperties('deposit_step', {
    step: 'checkout_opened',
    method: 'card',
    amount_bucket: 'under_5',
    secs_since_prev_step: 'first',
  } as never);
  assert.deepEqual(step, { step: 'checkout_opened', method: 'card', secs_since_prev_step: 'first' });

  const startup = sanitizeTelemetryProperties('startup_finished', {
    outcome: 'cancelled',
    failure_stage: 'peer_search',
    duration_bucket: 'under_30s',
  } as never);
  assert.deepEqual(startup, { failure_stage: 'peer_search', duration_bucket: 'under_30s' });

  const app = sanitizeTelemetryProperties('connected_app_first_request', {
    app: 'my-secret-app',
    outcome: 'request_seen',
    secs_since_connect: 'under_1m',
  } as never);
  assert.deepEqual(app, { outcome: 'request_seen', secs_since_connect: 'under_1m' });
});

test('new bucket helpers classify correctly', () => {
  assert.equal(attemptCountBucket(1), '1');
  assert.equal(attemptCountBucket(2), '2');
  assert.equal(attemptCountBucket(5), '3_plus');
  assert.equal(secsSinceAppStartBucket(10_000), 'under_30s');
  assert.equal(secsSinceAppStartBucket(5 * 60_000), '2_10m');
  assert.equal(secsSinceAppStartBucket(11 * 60_000), 'over_10m');
  assert.equal(ttftBucket(null), 'none');
  assert.equal(ttftBucket(500), 'under_1s');
  assert.equal(ttftBucket(2_000), '1_3s');
  assert.equal(ttftBucket(12_000), 'over_10s');
  assert.equal(depositStepAmountBucket(0), null);
  assert.equal(depositStepAmountBucket(5), 'le_5');
  assert.equal(depositStepAmountBucket(10), '5_10');
  assert.equal(depositStepAmountBucket(50), '10_50');
  assert.equal(depositStepAmountBucket(50.01), 'over_50');
  assert.equal(stepGapBucket(null), 'first');
  assert.equal(stepGapBucket(400_000), 'over_5m');
  assert.equal(secsSinceConnectBucket(30_000), 'under_1m');
  assert.equal(secsSinceConnectBucket(10 * 60_000), '5_30m');
  assert.equal(telemetryHttpStatus(502), 502);
  assert.equal(telemetryHttpStatus(42), undefined);
  assert.equal(telemetryHttpStatus(undefined), undefined);
});

// Real error strings seen from the buyer proxy and agent SDKs.
const OUT_OF_CREDITS = '402 You are out of AntSeed credits for this request. Add funds in the AntSeed app, or run "antseed buyer deposit <amount>" from the CLI, then retry.';
const INSUFFICIENT_DEPOSITS = '402 {"error":"payment_required","code":"insufficient_deposits","message":"Deposit more USDC"}';
const PINNED_UNREACHABLE = '502 Pinned peer 1d90f467689d... is not reachable right now. It may be offline, not announcing, or temporarily unreachable.';
const P2P_FAILED = '502 P2P request failed: Connection to 1d90f467 failed';
const OOPS_502 = '502 Oops, peer could not complete the request.\nAntseed is a peer-to-peer network. Try another peer or use Auto routing.';
const MODEL_NOT_FOUND = '502 {"error":{"type":"model_not_found","message":"No policy-allowed peer currently serves model claude-x"}}';
const PAYMENTS_INACTIVE = '503 {"error":{"type":"buyer_request_failed","code":"payments_inactive","message":"Payments are not active"}}';

const KNOWN_CONTEXT = {
  hadPartialOutput: false,
  peersDiscoveredAtSend: true,
  sellersKnown: 2,
  freeSellersKnown: 1,
  buyerBalanceZero: false,
};

function reasonFor(message: string, context: Partial<typeof KNOWN_CONTEXT> = {}) {
  const stop = classifyChatStreamFailure({ error: new Error(message), stopReason: 'error' });
  return {
    stop,
    reason: classifyChatFailureReason(stop, message, { ...KNOWN_CONTEXT, ...context }),
    httpStatus: chatFailureHttpStatus(stop, message),
  };
}

test('failure_reason classifies the real buyer-proxy error strings', () => {
  assert.deepEqual(
    [reasonFor(OUT_OF_CREDITS).reason, reasonFor(OUT_OF_CREDITS).httpStatus],
    ['out_of_credits', 402],
  );
  assert.equal(
    reasonFor(OUT_OF_CREDITS, { buyerBalanceZero: true, freeSellersKnown: 0 }).reason,
    'model_needs_paid',
  );
  assert.deepEqual(
    [reasonFor(INSUFFICIENT_DEPOSITS).reason, reasonFor(INSUFFICIENT_DEPOSITS).httpStatus],
    ['out_of_credits', 402],
  );
  assert.equal(
    reasonFor(INSUFFICIENT_DEPOSITS, { buyerBalanceZero: true, freeSellersKnown: 0 }).reason,
    'model_needs_paid',
  );
  assert.deepEqual(
    [reasonFor(PINNED_UNREACHABLE).reason, reasonFor(PINNED_UNREACHABLE).httpStatus],
    ['seller_unreachable', 502],
  );
  assert.deepEqual([reasonFor(P2P_FAILED).reason, reasonFor(P2P_FAILED).httpStatus], ['seller_unreachable', 502]);
  assert.deepEqual([reasonFor(OOPS_502).reason, reasonFor(OOPS_502).httpStatus], ['seller_5xx', 502]);
  assert.equal(reasonFor(MODEL_NOT_FOUND).reason, 'no_seller_available');
  assert.equal(reasonFor(MODEL_NOT_FOUND, { peersDiscoveredAtSend: false }).reason, 'no_seller_yet');
  assert.deepEqual(
    [reasonFor(PAYMENTS_INACTIVE).reason, reasonFor(PAYMENTS_INACTIVE).httpStatus],
    ['local_error', 503],
  );
  assert.equal(reasonFor('Connection error.').reason, 'seller_dropped_before_output');
  assert.equal(reasonFor('Connection error.', { hadPartialOutput: true }).reason, 'seller_dropped_mid_answer');
  assert.equal(reasonFor('terminated').reason, 'seller_dropped_before_output');
  assert.equal(reasonFor('terminated', { hadPartialOutput: true }).reason, 'seller_dropped_mid_answer');
  assert.equal(reasonFor('Request timed out.').reason, 'timeout');
  assert.deepEqual([reasonFor('504 Gateway Timeout').reason, reasonFor('504 Gateway Timeout').httpStatus], ['timeout', 504]);
  assert.equal(
    classifyChatFailureReason({ kind: 'aborted', source: 'user', retryable: false }, '', KNOWN_CONTEXT),
    'none',
  );
  assert.equal(
    classifyChatFailureReason({ kind: 'http_error', source: 'upstream', retryable: true, statusCode: 429 }, '', KNOWN_CONTEXT),
    'rate_limited',
  );
  assert.equal(
    classifyChatFailureReason({ kind: 'http_error', source: 'upstream', retryable: false, statusCode: 400 }, '', KNOWN_CONTEXT),
    'request_rejected',
  );
});

test('connected-app request matcher needs a matching slug active since connect', () => {
  const conversations = [
    { tool: 'OpenCode', lastActiveAt: 5_000 },
    { tool: 'codex', lastActiveAt: 500 },
    { tool: 42, lastActiveAt: 9_000 },
  ];
  assert.equal(conversationsShowRequestSince(conversations, ['opencode'], 1_000), true);
  assert.equal(conversationsShowRequestSince(conversations, ['codex'], 1_000), false);
  assert.equal(conversationsShowRequestSince(conversations, [], 0), false);
  assert.equal(conversationsShowRequestSince(null, ['opencode'], 0), false);
});

test('connected-app request matcher counts the app\'s client variants', () => {
  const since = 1_000;
  for (const tool of ['codex-exec', 'codex-desktop', 'codex-cli-rs', 'Codex']) {
    assert.equal(conversationsShowRequestSince([{ tool, lastActiveAt: 2_000 }], ['codex'], since), true, tool);
  }
  assert.equal(conversationsShowRequestSince([{ tool: 'hermes-agent', lastActiveAt: 2_000 }], ['hermes', 'hermes-agent'], since), true);
  assert.equal(conversationsShowRequestSince([{ tool: 'codexfoo', lastActiveAt: 2_000 }], ['codex'], since), false, 'a name that only starts the same');
  assert.equal(conversationsShowRequestSince([{ tool: 'codex-exec', lastActiveAt: 500 }], ['codex'], since), false, 'before connecting');
  assert.equal(conversationsShowRequestSince([{ tool: 'codex', lastActiveAt: 2_000 }], [''], since), false, 'an empty slug matches nothing');
});
