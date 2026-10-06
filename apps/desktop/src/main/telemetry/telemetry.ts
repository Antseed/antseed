/**
 * Privacy-conscious product telemetry for the desktop app (design: the PostHog
 * activation-funnel issue).
 *
 * What this service guarantees:
 * - The normalized buyer wallet address is the PostHog distinct identifier.
 * - A fresh random session ID per launch.
 * - Only events from ./events.ts's typed catalog are sent, and every
 *   property passes through ./sanitize.ts's allowlist — unknown properties
 *   are dropped, strings truncated, numbers bounded.
 * - Disabled in development builds, when the TELEMETRY_ENABLED kill switch
 *   is falsy, when PostHog config is missing, or when the user opts out in
 *   Settings.
 * - Routine captures are fire-and-forget; clean shutdown uses a bounded flush.
 * - First-open and first-chat events fire exactly once per installation.
 */
import { randomBytes } from 'node:crypto';
import {
  TELEMETRY_SCHEMA_VERSION,
  countBucket,
  daysSinceFirstOpenBucket,
  depositAmountBucket,
  durationBucket,
  sessionDurationBucket,
  type FirstChatDepositSnapshot,
  type TelemetryEventName,
  type TelemetryEventProperties,
} from './events.js';
import { sanitizeTelemetryProperties } from './sanitize.js';
import { createPostHogTransport, type PostHogTransport } from './posthog.js';
import {
  loadTelemetryStateResult,
  saveTelemetryState,
  type TelemetryState,
} from './state.js';
import {
  BAKED_POSTHOG_HOST,
  BAKED_POSTHOG_PROJECT_API_KEY,
} from '../generated/baked-defaults.js';
import type { UserActionSignal } from '../../shared/telemetry.js';

export const TELEMETRY_ENABLED_ENV = 'TELEMETRY_ENABLED';
export const POSTHOG_HOST_ENV = 'POSTHOG_HOST';
export const POSTHOG_PROJECT_API_KEY_ENV = 'POSTHOG_PROJECT_API_KEY';
export const INSTALL_SOURCE_ENV = 'INSTALL_SOURCE';

const USDC_BASE_UNITS = 1_000_000n;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_PENDING_USER_ACTIONS = 32;
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 750;

/**
 * RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version/variant bits, 74 random
 * bits. Kept local — node:crypto only generates v4.
 */
export function uuidV7(timestampMs: number): string {
  const bytes = randomBytes(16);
  let remaining = Math.max(0, Math.floor(timestampMs));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'false' || normalized === '0' || normalized === 'no';
}

function configValue(env: NodeJS.ProcessEnv, key: string, baked: string | null): string {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    return (env[key] ?? '').trim();
  }
  return baked?.trim() ?? '';
}

function normalizeInstallSource(value: string | undefined, platform: string, env: NodeJS.ProcessEnv): string {
  if (!value) {
    if (platform === 'darwin') return 'dmg';
    if (platform === 'win32') return 'nsis';
    if (platform === 'linux') return env['APPIMAGE'] ? 'appimage' : 'deb';
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  return ['dmg', 'nsis', 'appimage', 'deb'].includes(normalized) ? normalized : 'unknown';
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeDistinctId(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

export type TelemetryContext = {
  platform: string;
  arch: string;
  appVersion: string;
  installSource: string;
};

export type TelemetryService = {
  readonly available: boolean;
  readonly enabled: boolean;
  context: () => TelemetryContext;
  /** Emits app_first_opened (once) and app_started; handles crash recovery. */
  recordAppStarted: (nowMs?: number) => Promise<void>;
  recordNetworkRuntimeStarted: (nowMs?: number) => Promise<void>;
  recordDhtStarted: (routingNodeCount: number, nowMs?: number) => Promise<void>;
  recordPeersDiscovered: (peerCount: number, serviceCount: number, nowMs?: number) => Promise<void>;
  recordFirstModelShown: (
    input: Omit<TelemetryEventProperties['first_model_shown'], 'duration_bucket'>,
    nowMs?: number,
  ) => Promise<void>;
  recordUserAction: (input: UserActionSignal, nowMs?: number) => Promise<void>;
  /** Arms the setup-duration clock. Call when first-run setup begins. */
  recordSetupStarted: (nowMs?: number) => Promise<void>;
  recordSetupCompleted: (nowMs?: number) => Promise<void>;
  /** Deposit observed credited; amount never leaves the device, only a bucket. */
  recordDepositCredited: (amountBaseUnits: string, nowMs?: number) => Promise<void>;
  recordDepositFailed: (input: {
    failureCode: TelemetryEventProperties['deposit_failed']['failure_code'];
    failureStage: TelemetryEventProperties['deposit_failed']['failure_stage'];
    retryable: boolean;
  }, nowMs?: number) => Promise<void>;
  /** Fires at most once per installation. */
  recordFirstChatStarted: (input: {
    serviceCategory: TelemetryEventProperties['first_chat_started']['service_category'];
    hasAttachments: boolean;
  }, getDepositSnapshot: () => Promise<FirstChatDepositSnapshot | null>, nowMs?: number) => Promise<void>;
  recordModelSelected: (
    input: TelemetryEventProperties['model_selected'],
    selectionKey: string,
    nowMs?: number,
  ) => Promise<void>;
  recordChatRequestStarted: (
    input: TelemetryEventProperties['chat_request_started'],
    nowMs?: number,
  ) => Promise<void>;
  recordChatRequestFinished: (
    input: TelemetryEventProperties['chat_request_finished'],
    nowMs?: number,
  ) => Promise<void>;
  recordDiscoveryFailed: (
    input: TelemetryEventProperties['discovery_failed'],
    nowMs?: number,
  ) => Promise<void>;
  /** Clean shutdown: emits app_closed and clears the crash flag. */
  recordCleanShutdown: (nowMs?: number) => Promise<void>;
  isUserOptedOut: () => boolean;
  setUserOptedOut: (disabled: boolean) => Promise<void>;
};

export type CreateTelemetryServiceOptions = {
  userDataDir: string;
  isDev: boolean;
  appVersion: string;
  platform: string;
  arch: string;
  getDistinctId: () => string | null;
  hadExistingIdentity: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  transport?: PostHogTransport;
  heartbeatIntervalMs?: number | null;
  shutdownFlushTimeoutMs?: number;
};

export async function createTelemetryService(
  options: CreateTelemetryServiceOptions,
): Promise<TelemetryService> {
  const env = options.env ?? process.env;
  const now = options.nowMs ?? (() => Date.now());

  const envDisabled = isFalsyEnv(env[TELEMETRY_ENABLED_ENV]);
  const host = configValue(env, POSTHOG_HOST_ENV, BAKED_POSTHOG_HOST);
  const apiKey = configValue(env, POSTHOG_PROJECT_API_KEY_ENV, BAKED_POSTHOG_PROJECT_API_KEY);
  const configMissing = host.length === 0 || apiKey.length === 0 || !isValidHttpsUrl(host);
  const staticDisabled = options.isDev || envDisabled || configMissing;

  const context: TelemetryContext = {
    platform: options.platform,
    arch: options.arch,
    appVersion: options.appVersion,
    installSource: normalizeInstallSource(env[INSTALL_SOURCE_ENV], options.platform, env),
  };

  // State loads even when statically disabled so the in-app toggle answers
  // correctly and nothing crashes in dev.
  const loadedState = await loadTelemetryStateResult(options.userDataDir);
  const state: TelemetryState = loadedState.state;
  if (loadedState.source !== 'stored' && options.hadExistingIdentity) {
    state.hasEmittedFirstOpen = true;
  }

  const transport: PostHogTransport = options.transport
    ?? createPostHogTransport({ host: host || 'https://localhost', projectApiKey: apiKey || 'disabled' });

  // UUIDv7 on purpose: PostHog's Sessions explorer keys on `$session_id` and
  // derives the session start from the v7 timestamp bits, silently ignoring
  // other UUID versions.
  const sessionId = uuidV7(now());
  let saveQueue = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = { ...state };
    const pending = saveQueue.then(() => saveTelemetryState(options.userDataDir, snapshot));
    saveQueue = pending.catch(() => {});
    return pending;
  };
  const heartbeatIntervalMs = options.heartbeatIntervalMs === undefined
    ? DEFAULT_HEARTBEAT_INTERVAL_MS
    : options.heartbeatIntervalMs;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let hasEmittedNetworkRuntimeStarted = false;
  let hasEmittedDhtStarted = false;
  let hasEmittedPeersDiscovered = false;
  let hasEmittedFirstModelShown = false;
  let hasEmittedFirstUserAction = false;
  let lastModelSelectionKey: string | null = null;
  let firstChatClaimed = false;

  type PendingUserAction = {
    input: UserActionSignal;
    nowMs: number;
  };
  const pendingUserActions: PendingUserAction[] = [];
  let userActionDelivery: Promise<void> | null = null;

  const available = !staticDisabled;
  const isEnabled = () => (
    available
    && !state.telemetryDisabled
    && normalizeDistinctId(options.getDistinctId()) !== null
  );

  const capture = <K extends TelemetryEventName>(
    event: K,
    properties: TelemetryEventProperties[K],
    eventTsMs = now(),
    captureSessionId: string = sessionId,
  ): Promise<void> | null => {
    if (!isEnabled()) return null;
    const distinctId = normalizeDistinctId(options.getDistinctId());
    if (!distinctId) return null;
    const payload = {
      event,
      distinct_id: distinctId,
      timestamp: new Date(eventTsMs).toISOString(),
      properties: {
        $geoip_disable: true,
        $process_person_profile: false,
        schema_version: TELEMETRY_SCHEMA_VERSION,
        event_ts_ms: eventTsMs,
        session_id: captureSessionId,
        $session_id: captureSessionId,
        app_version: context.appVersion,
        platform: context.platform,
        arch: context.arch,
        install_source: context.installSource,
        ...sanitizeTelemetryProperties(event, properties),
      },
    };
    return transport(payload).catch(() => {});
  };

  const track = <K extends TelemetryEventName>(
    event: K,
    properties: TelemetryEventProperties[K],
    eventTsMs = now(),
    captureSessionId: string = sessionId,
  ): boolean => {
    const delivery = capture(event, properties, eventTsMs, captureSessionId);
    if (!delivery) return false;
    void delivery;
    return true;
  };

  const awaitShutdownDelivery = async (delivery: Promise<void> | null): Promise<void> => {
    if (!delivery) return;
    const timeoutMs = options.shutdownFlushTimeoutMs ?? DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    await Promise.race([
      delivery,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const userActionKey = (input: UserActionSignal): string => `${input.action}:${input.surface}:${input.app ?? ''}`;

  const deliverNextUserAction = (): void => {
    if (userActionDelivery) return;
    if (!isEnabled()) {
      pendingUserActions.length = 0;
      return;
    }
    const next = pendingUserActions.shift();
    if (!next) return;

    const isFirstAction = !hasEmittedFirstUserAction;
    const delivery = capture('user_action', {
      ...next.input,
      duration_bucket: durationBucket(durationSinceSessionStart(next.nowMs)),
      is_first_action: isFirstAction,
    }, next.nowMs);
    if (!delivery) {
      pendingUserActions.length = 0;
      return;
    }
    if (isFirstAction) hasEmittedFirstUserAction = true;

    userActionDelivery = delivery.finally(() => {
      userActionDelivery = null;
      deliverNextUserAction();
    });
    void userActionDelivery;
  };

  const enqueueUserAction = (input: UserActionSignal, nowMs: number): void => {
    if (!isEnabled()) return;
    const key = userActionKey(input);
    const duplicateIndex = pendingUserActions.findIndex((pending) => userActionKey(pending.input) === key);
    if (duplicateIndex >= 0) {
      pendingUserActions[duplicateIndex] = { input, nowMs };
    } else {
      if (pendingUserActions.length >= MAX_PENDING_USER_ACTIONS) pendingUserActions.shift();
      pendingUserActions.push({ input, nowMs });
    }
    deliverNextUserAction();
  };

  const daysSinceFirstOpen = (nowMs: number): number => {
    if (state.firstOpenedAtMs === null) return 0;
    return Math.max(0, Math.floor((nowMs - state.firstOpenedAtMs) / MS_PER_DAY));
  };

  const durationSinceSessionStart = (nowMs: number): number => (
    state.lastSessionStartedAtMs !== null ? Math.max(0, nowMs - state.lastSessionStartedAtMs) : 0
  );

  const startHeartbeat = (): void => {
    if (heartbeatTimer || heartbeatIntervalMs === null || heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      if (!state.sessionActive) return;
      state.lastSessionHeartbeatAtMs = now();
      void save();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  };

  const stopHeartbeat = (): void => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  return {
    get available() {
      return available;
    },

    get enabled() {
      return isEnabled();
    },

    context: () => ({ ...context }),

    async recordAppStarted(nowMs = now()) {
      // Crash recovery: a previous session left its flag behind.
      const wasCrash = state.sessionActive;
      const previousSessionId = state.lastSessionId;
      const previousSessionStartedAtMs = state.lastSessionStartedAtMs;
      const previousSessionHeartbeatAtMs = state.lastSessionHeartbeatAtMs;
      // Clear before awaiting anything so a crash during this launch still
      // reads as a crash next time (flag re-armed below).
      if (wasCrash) {
        const recoveredAtMs = previousSessionHeartbeatAtMs ?? previousSessionStartedAtMs ?? nowMs;
        track('app_closed', {
          was_crash: true,
          session_duration_bucket: sessionDurationBucket(
            previousSessionStartedAtMs !== null ? Math.max(0, recoveredAtMs - previousSessionStartedAtMs) : 0,
          ),
        }, recoveredAtMs, previousSessionId ?? sessionId);
      }

      const isFirstLaunch = !state.hasEmittedFirstOpen;
      if (isFirstLaunch) {
        state.hasEmittedFirstOpen = true;
        state.firstOpenedAtMs = nowMs;
        state.firstOpenDate = new Date(nowMs).toISOString().slice(0, 10);
        track('app_first_opened', { first_open_date: state.firstOpenDate }, nowMs);
      }

      state.sessionActive = true;
      state.lastSessionId = sessionId;
      state.lastSessionStartedAtMs = nowMs;
      state.lastSessionHeartbeatAtMs = nowMs;
      track('app_started', { is_first_launch: isFirstLaunch }, nowMs);
      await save();
      startHeartbeat();
    },

    async recordNetworkRuntimeStarted(nowMs = now()) {
      if (hasEmittedNetworkRuntimeStarted) return;
      hasEmittedNetworkRuntimeStarted = track('network_runtime_started', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
      }, nowMs);
    },

    async recordDhtStarted(routingNodeCount, nowMs = now()) {
      if (hasEmittedDhtStarted || routingNodeCount <= 0) return;
      hasEmittedDhtStarted = track('dht_started', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
        routing_node_count_bucket: countBucket(routingNodeCount),
      }, nowMs);
    },

    async recordPeersDiscovered(peerCount, serviceCount, nowMs = now()) {
      if (hasEmittedPeersDiscovered || peerCount <= 0) return;
      hasEmittedPeersDiscovered = track('peers_discovered', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
        peer_count_bucket: countBucket(peerCount),
        service_count_bucket: countBucket(serviceCount),
      }, nowMs);
    },

    async recordFirstModelShown(input, nowMs = now()) {
      if (hasEmittedFirstModelShown) return;
      hasEmittedFirstModelShown = track('first_model_shown', {
        ...input,
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
      }, nowMs);
    },

    async recordUserAction(input, nowMs = now()) {
      enqueueUserAction(input, nowMs);
    },

    async recordSetupStarted(nowMs = now()) {
      if (state.hasCompletedSetup || state.setupStartedAtMs !== null) return;
      state.setupStartedAtMs = nowMs;
      await save();
    },

    async recordSetupCompleted(nowMs = now()) {
      if (state.hasCompletedSetup || state.setupStartedAtMs === null) return;
      const startedAt = state.setupStartedAtMs;
      state.hasCompletedSetup = true;
      state.setupStartedAtMs = null;
      track('setup_completed', {
        duration_bucket: durationBucket(startedAt !== null ? Math.max(0, nowMs - startedAt) : 0),
      }, nowMs);
      await save();
    },

    async recordDepositCredited(amountBaseUnits: string, nowMs = now()) {
      let amountUsdc = 0;
      try {
        amountUsdc = Number(BigInt(amountBaseUnits)) / Number(USDC_BASE_UNITS);
      } catch {
        // Malformed amount: still record the deposit, bucket as unknown-low.
      }
      const bucket = depositAmountBucket(amountUsdc);
      const isFirstDeposit = !state.hasCompletedDeposit;
      state.hasCompletedDeposit = true;
      track('deposit_completed', {
        method_category: 'usdc',
        amount_bucket: bucket,
        is_first_deposit: isFirstDeposit,
        days_since_first_open: daysSinceFirstOpenBucket(daysSinceFirstOpen(nowMs)),
      }, nowMs);
      await save();
    },

    async recordDepositFailed(input, nowMs = now()) {
      track('deposit_failed', {
        method_category: 'usdc',
        failure_code: input.failureCode,
        failure_stage: input.failureStage,
        retryable: input.retryable,
      }, nowMs);
    },

    async recordFirstChatStarted(input, getDepositSnapshot, nowMs = now()) {
      if (!isEnabled() || state.hasEmittedFirstChat || firstChatClaimed) return;
      firstChatClaimed = true;
      try {
        const deposit = await getDepositSnapshot();
        if (!deposit || !isEnabled() || state.hasEmittedFirstChat) return;
        state.hasEmittedFirstChat = true;
        track('first_chat_started', {
          had_deposit: deposit.hadDeposit,
          deposit_bucket: deposit.depositBucket,
          days_since_first_open: daysSinceFirstOpenBucket(daysSinceFirstOpen(nowMs)),
          service_category: input.serviceCategory,
          has_attachments: input.hasAttachments,
        }, nowMs);
        await save();
      } finally {
        firstChatClaimed = false;
      }
    },

    async recordModelSelected(input, selectionKey, nowMs = now()) {
      if (selectionKey === lastModelSelectionKey) return;
      if (track('model_selected', input, nowMs)) {
        lastModelSelectionKey = selectionKey;
      }
    },

    async recordChatRequestStarted(input, nowMs = now()) {
      track('chat_request_started', input, nowMs);
    },

    async recordChatRequestFinished(input, nowMs = now()) {
      track('chat_request_finished', input, nowMs);
    },

    async recordDiscoveryFailed(input, nowMs = now()) {
      track('discovery_failed', input, nowMs);
    },

    async recordCleanShutdown(nowMs = now()) {
      if (!state.sessionActive) return;
      stopHeartbeat();
      const delivery = capture('app_closed', {
        was_crash: false,
        session_duration_bucket: sessionDurationBucket(
          state.lastSessionStartedAtMs !== null ? Math.max(0, nowMs - state.lastSessionStartedAtMs) : 0,
        ),
      }, nowMs);
      state.sessionActive = false;
      state.lastSessionId = null;
      state.lastSessionStartedAtMs = null;
      state.lastSessionHeartbeatAtMs = null;
      await Promise.all([save(), awaitShutdownDelivery(delivery)]);
    },

    isUserOptedOut: () => state.telemetryDisabled,

    async setUserOptedOut(disabled: boolean) {
      state.telemetryDisabled = Boolean(disabled);
      if (state.telemetryDisabled) pendingUserActions.length = 0;
      await save();
    },
  };
}
