/**
 * Typed catalog of every telemetry event the desktop app may emit.
 *
 * This file is the single source of truth for what leaves the device. The
 * PostHog transport (./posthog.ts) only forwards events listed here, and
 * ./sanitize.ts drops any property not declared on the event. Both the event
 * names and their property sets are mirrored in the public privacy doc
 * (docs/telemetry.md) — keep them in sync.
 *
 * Hard rules (see the telemetry design issue):
 * - Never prompts, chat contents, assistant responses, file names or paths.
 * - The buyer wallet address is used only as the PostHog distinct identifier.
 * - Never transaction hashes or exact balances/amounts.
 * - Never peer IDs, env vars, command lines, logs, or stack traces.
 * - Only coarse buckets for durations and amounts.
 */

import { createHash } from 'node:crypto';
import type { TelemetryActionSurface, TelemetryAppName, TelemetryUserAction } from '../../shared/telemetry.js';
import { modelMetadataFor } from '@antseed/node/model-metadata';

/** 2: adds `product`, shared with the CLI, buyer and gateway (docs/telemetry.md). */
export const TELEMETRY_SCHEMA_VERSION = 2;

export type DurationBucket = 'under_30s' | '30s_2m' | '2m_5m' | 'over_5m';
export type SessionDurationBucket = DurationBucket | 'over_30m';
export type DepositAmountBucket = 'under_5' | '5_25' | '25_100' | '100_plus';
export type DaysSinceFirstOpen = '0' | '1_7' | '8_30' | '31_plus';
export type ServiceCategory = 'chat' | 'image' | 'other';
export type CountBucket = '0' | '1' | '2_5' | '6_20' | '21_plus';
export type OffersAvailableBucket = '0' | '1' | '2_3' | '4_plus';
export type HttpStatusBucket = 'none' | '4xx' | '5xx' | 'other';
export type DepositFailureCode =
  | 'payments_disabled'
  | 'deposit_relay_unavailable'
  | 'relayer_unreachable'
  | 'relayer_declined'
  | 'confirmation_timeout'
  | 'domain_mismatch'
  | 'rpc_unavailable'
  | 'watcher_unavailable'
  | 'unknown';
export type DepositFailureStage = 'preflight' | 'signing' | 'dispatch' | 'confirmation' | 'sweep';
export type ChatRequestOutcome = 'success' | 'failed' | 'cancelled';
export type ChatFailureCode =
  | 'none'
  | 'payment_required'
  | 'user_aborted'
  | 'timeout'
  | 'model_not_served_by_peer'
  | 'rate_limited'
  | 'http_4xx'
  | 'http_5xx'
  | 'network_error'
  | 'stream_error'
  | 'unknown';
export type ChatFailureStage = 'none' | 'request_validation' | 'payment' | 'user' | 'transport' | 'upstream' | 'streaming';
/**
 * Why a chat request failed, decided on-device from the classified stop
 * reason and local context. Raw error text never leaves the device.
 */
export type ChatFailureReasonCode =
  | 'none'
  | 'out_of_credits'
  | 'model_needs_paid'
  | 'seller_dropped_before_output'
  | 'seller_dropped_mid_answer'
  | 'seller_5xx'
  | 'request_rejected'
  | 'rate_limited'
  | 'no_seller_available'
  | 'no_seller_yet'
  | 'seller_unreachable'
  | 'timeout'
  | 'local_error'
  | 'unknown';
export type AttemptCountBucket = '1' | '2' | '3_plus';
export type SecsSinceAppStartBucket = 'under_30s' | '30s_2m' | '2_10m' | 'over_10m';
export type TtftBucket = 'none' | 'under_1s' | '1_3s' | '3_10s' | 'over_10s';
export type DepositStep =
  | 'method_shown'
  | 'method_chosen'
  | 'checkout_opened'
  | 'checkout_reopened'
  | 'checkout_abandoned'
  | 'region_unsupported'
  | 'card_declined'
  | 'payment_submitted'
  | 'credited';
/**
 * How the buyer funded. `card` = Crossmint/Stripe card checkout;
 * `crypto_wallet` = USDC sent to the deposit address (QR), a connected wallet
 * or a cross-chain wallet page; `payment_app` = Peer Pay (bank or payment
 * app); `exchange` is reserved — an exchange withdrawal to the QR address is
 * indistinguishable from a wallet transfer on device.
 */
export type DepositMethod = 'card' | 'crypto_wallet' | 'payment_app' | 'exchange' | 'unknown';
export type DepositStepAmountBucket = 'le_5' | '5_10' | '10_50' | 'over_50';
export type StepGapBucket = 'first' | 'under_10s' | '10s_1m' | '1m_5m' | 'over_5m';
export type StartupFailureStage = 'none' | 'runtime' | 'dht' | 'peer_search' | 'models';
export type ConnectedAppFirstRequestOutcome = 'request_seen' | 'no_request';
export type SecsSinceConnectBucket = 'under_1m' | '1_5m' | '5_30m' | 'none';
export type PremiumBlockedFollowup = 'deposited' | 'switched_free_model' | 'left';
export type RouteMode = 'auto' | 'pinned';
export type ModelPricingTier = 'free' | 'paid' | 'mixed' | 'unknown';
export type DiscoveryFailureCode = 'timeout' | 'invalid_data' | 'io_error' | 'unknown';
export type FirstChatDepositSnapshot = {
  hadDeposit: boolean;
  depositBucket: DepositAmountBucket | 'none';
};

export type TelemetryEventProperties = {
  /** Emitted exactly once per local installation, on first launch. */
  app_first_opened: {
    first_open_date: string;
  };
  /** Emitted once per application launch. */
  app_started: {
    is_first_launch: boolean;
  };
  /** Emitted once per launch when the buyer runtime control plane responds. */
  network_runtime_started: {
    duration_bucket: DurationBucket;
  };
  /** Emitted once per launch when the DHT has at least one routing node. */
  dht_started: {
    duration_bucket: DurationBucket;
    routing_node_count_bucket: CountBucket;
  };
  /** Emitted once per launch when the buyer first reports discovered peers. */
  peers_discovered: {
    duration_bucket: DurationBucket;
    peer_count_bucket: CountBucket;
    service_count_bucket: CountBucket;
  };
  /** Emitted once per launch when the first selected model is visibly rendered. */
  first_model_shown: {
    duration_bucket: DurationBucket;
    public_model_id: string;
    service_category: ServiceCategory;
    route_mode: RouteMode;
    pricing_tier: ModelPricingTier;
    has_free_eligible_offer: boolean;
    eligible_offer_count_bucket: OffersAvailableBucket;
  };
  /** Emitted for every allowlisted meaningful user action. */
  user_action: {
    action: TelemetryUserAction;
    surface: TelemetryActionSurface;
    duration_bucket: DurationBucket;
    is_first_action: boolean;
    /** app_connect / app_disconnect only: which app (fixed taxonomy). */
    app?: TelemetryAppName;
  };
  /** Emitted when first-run setup completes. */
  setup_completed: {
    duration_bucket: DurationBucket;
  };
  /** Emitted when a deposit is observed credited. */
  deposit_completed: {
    /** The funded asset; always `usdc`. Kept for existing queries. */
    method_category: string;
    /** The funding method last chosen in this launch (see DepositMethod). */
    method: DepositMethod;
    amount_bucket: DepositAmountBucket;
    is_first_deposit: boolean;
    days_since_first_open: DaysSinceFirstOpen;
  };
  /** Emitted when an automatic deposit attempt or watcher setup fails. */
  deposit_failed: {
    method_category: 'usdc';
    failure_code: DepositFailureCode;
    failure_stage: DepositFailureStage;
    retryable: boolean;
  };
  /** Emitted exactly once per installation, on the first valid chat request. */
  first_chat_started: {
    had_deposit: boolean;
    deposit_bucket: DepositAmountBucket | 'none';
    days_since_first_open: DaysSinceFirstOpen;
    service_category: ServiceCategory;
    has_attachments: boolean;
  };
  /** Emitted when the effective default or conversation model changes. */
  model_selected: {
    public_model_id: string;
    service_category: ServiceCategory;
    route_mode: RouteMode;
    pricing_tier: ModelPricingTier;
    has_free_eligible_offer: boolean;
    eligible_offer_count_bucket: OffersAvailableBucket;
  };
  /** Emitted immediately before each valid remote chat attempt. */
  chat_request_started: {
    request_id: string;
    public_model_id: string;
    service_category: ServiceCategory;
    route_mode: RouteMode;
    pricing_tier: ModelPricingTier;
    has_free_eligible_offer: boolean;
    offers_available_bucket: OffersAvailableBucket;
    has_attachments: boolean;
  };
  /** Emitted once for every valid remote chat attempt, including failures. */
  chat_request_finished: {
    request_id: string;
    outcome: ChatRequestOutcome;
    failure_code: ChatFailureCode;
    failure_stage: ChatFailureStage;
    public_model_id: string;
    service_category: ServiceCategory;
    route_mode: RouteMode;
    offers_available_bucket: OffersAvailableBucket;
    http_status_bucket: HttpStatusBucket;
    retryable: boolean;
    automatic_retry_attempted: boolean;
    automatic_retry_succeeded: boolean;
    had_partial_output: boolean;
    duration_bucket: DurationBucket;
    has_attachments: boolean;
    /** Fixed on-device reason; `none` for success and cancellation. */
    failure_reason: ChatFailureReasonCode;
    /** Exact HTTP status of the last attempt's failure (100–599), when known. */
    http_status?: number;
    /** Agent-level attempts: 1 + automatic retries. */
    attempt_count: AttemptCountBucket;
    /** A retry succeeded on a seller other than the one preferred at send. */
    answered_by_different_seller: boolean;
    secs_since_app_start: SecsSinceAppStartBucket;
    peers_discovered_at_send: boolean;
    sellers_known_bucket: OffersAvailableBucket;
    free_sellers_known_bucket: OffersAvailableBucket;
    /** Omitted when the balance has not been read yet. */
    buyer_balance_zero?: boolean;
    /** Pending privacy sign-off: only sent when TELEMETRY_SELLER_HASH_ENABLED. */
    seller_hash?: string;
    ttft_bucket: TtftBucket;
  };
  /** Funnel step through the deposit flow. */
  deposit_step: {
    step: DepositStep;
    method: DepositMethod;
    amount_bucket?: DepositStepAmountBucket;
    secs_since_prev_step: StepGapBucket;
  };
  /** Once per launch: the first model became visible, or startup stalled. */
  startup_finished: {
    outcome: 'success' | 'failed';
    failure_stage: StartupFailureStage;
    duration_bucket: DurationBucket;
  };
  /** Once per connect: whether the connected app sent a request through the buyer. */
  connected_app_first_request: {
    app: TelemetryAppName;
    outcome: ConnectedAppFirstRequestOutcome;
    secs_since_connect: SecsSinceConnectBucket;
  };
  /** An unfunded buyer asked for a model only paid sellers serve. */
  premium_blocked: {
    public_model_id: string;
    service_category: ServiceCategory;
  };
  /** What the buyer did next after premium_blocked, within the same launch. */
  premium_blocked_followup: {
    next_action: PremiumBlockedFollowup;
  };
  withdraw_started: Record<string, never>;
  withdraw_completed: Record<string, never>;
  /** Windows/Linux: closing the last window quits the app and stops the buyer runtime. */
  runtime_stopped_on_window_close: {
    runtime_was_running: boolean;
  };
  /** Emitted only when a discovery request fails. */
  discovery_failed: {
    duration_bucket: DurationBucket;
    failure_code: DiscoveryFailureCode;
  };
  /**
   * Emitted on clean shutdown (was_crash=false), or recovered on the next
   * launch after an unclean shutdown (was_crash=true, describing the
   * previous session).
   */
  app_closed: {
    was_crash: boolean;
    session_duration_bucket: SessionDurationBucket;
  };
};

export type TelemetryEventName = keyof TelemetryEventProperties;

/** Allowlisted property keys per event — anything else is dropped. */
export const TELEMETRY_EVENT_ALLOWLIST: { readonly [K in TelemetryEventName]: ReadonlySet<string> } = {
  app_first_opened: new Set(['first_open_date']),
  app_started: new Set(['is_first_launch']),
  network_runtime_started: new Set(['duration_bucket']),
  dht_started: new Set(['duration_bucket', 'routing_node_count_bucket']),
  peers_discovered: new Set(['duration_bucket', 'peer_count_bucket', 'service_count_bucket']),
  first_model_shown: new Set([
    'duration_bucket',
    'public_model_id',
    'service_category',
    'route_mode',
    'pricing_tier',
    'has_free_eligible_offer',
    'eligible_offer_count_bucket',
  ]),
  user_action: new Set(['action', 'surface', 'duration_bucket', 'is_first_action', 'app']),
  setup_completed: new Set(['duration_bucket']),
  deposit_completed: new Set(['method_category', 'method', 'amount_bucket', 'is_first_deposit', 'days_since_first_open']),
  deposit_failed: new Set(['method_category', 'failure_code', 'failure_stage', 'retryable']),
  first_chat_started: new Set(['had_deposit', 'deposit_bucket', 'days_since_first_open', 'service_category', 'has_attachments']),
  model_selected: new Set([
    'public_model_id',
    'service_category',
    'route_mode',
    'pricing_tier',
    'has_free_eligible_offer',
    'eligible_offer_count_bucket',
  ]),
  chat_request_started: new Set([
    'request_id',
    'public_model_id',
    'service_category',
    'route_mode',
    'pricing_tier',
    'has_free_eligible_offer',
    'offers_available_bucket',
    'has_attachments',
  ]),
  chat_request_finished: new Set([
    'request_id',
    'outcome',
    'failure_code',
    'failure_stage',
    'public_model_id',
    'service_category',
    'route_mode',
    'offers_available_bucket',
    'http_status_bucket',
    'retryable',
    'automatic_retry_attempted',
    'automatic_retry_succeeded',
    'had_partial_output',
    'duration_bucket',
    'has_attachments',
    'failure_reason',
    'http_status',
    'attempt_count',
    'answered_by_different_seller',
    'secs_since_app_start',
    'peers_discovered_at_send',
    'sellers_known_bucket',
    'free_sellers_known_bucket',
    'buyer_balance_zero',
    'seller_hash',
    'ttft_bucket',
  ]),
  deposit_step: new Set(['step', 'method', 'amount_bucket', 'secs_since_prev_step']),
  startup_finished: new Set(['outcome', 'failure_stage', 'duration_bucket']),
  connected_app_first_request: new Set(['app', 'outcome', 'secs_since_connect']),
  premium_blocked: new Set(['public_model_id', 'service_category']),
  premium_blocked_followup: new Set(['next_action']),
  withdraw_started: new Set([]),
  withdraw_completed: new Set([]),
  runtime_stopped_on_window_close: new Set(['runtime_was_running']),
  discovery_failed: new Set(['duration_bucket', 'failure_code']),
  app_closed: new Set(['was_crash', 'session_duration_bucket']),
};

export const DEPOSIT_AMOUNT_BUCKETS: ReadonlySet<string> = new Set(['under_5', '5_25', '25_100', '100_plus']);
export const DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m']);
export const SESSION_DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m', 'over_30m']);
export const DAYS_SINCE_FIRST_OPEN_BUCKETS: ReadonlySet<string> = new Set(['0', '1_7', '8_30', '31_plus']);
export const SERVICE_CATEGORIES: ReadonlySet<string> = new Set(['chat', 'image', 'other']);
export const COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_5', '6_20', '21_plus']);
export const OFFERS_AVAILABLE_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_3', '4_plus']);
export const HTTP_STATUS_BUCKETS: ReadonlySet<string> = new Set(['none', '4xx', '5xx', 'other']);
export const DISCOVERY_FAILURE_CODES: ReadonlySet<string> = new Set(['timeout', 'invalid_data', 'io_error', 'unknown']);
export const DEPOSIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'payments_disabled',
  'deposit_relay_unavailable',
  'relayer_unreachable',
  'relayer_declined',
  'confirmation_timeout',
  'domain_mismatch',
  'rpc_unavailable',
  'watcher_unavailable',
  'unknown',
]);
export const DEPOSIT_FAILURE_STAGES: ReadonlySet<string> = new Set(['preflight', 'signing', 'dispatch', 'confirmation', 'sweep']);
export const CHAT_REQUEST_OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled']);
export const CHAT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'none',
  'payment_required',
  'user_aborted',
  'timeout',
  'model_not_served_by_peer',
  'rate_limited',
  'http_4xx',
  'http_5xx',
  'network_error',
  'stream_error',
  'unknown',
]);
export const CHAT_FAILURE_STAGES: ReadonlySet<string> = new Set([
  'none',
  'request_validation',
  'payment',
  'user',
  'transport',
  'upstream',
  'streaming',
]);
export const CHAT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'none',
  'out_of_credits',
  'model_needs_paid',
  'seller_dropped_before_output',
  'seller_dropped_mid_answer',
  'seller_5xx',
  'request_rejected',
  'rate_limited',
  'no_seller_available',
  'no_seller_yet',
  'seller_unreachable',
  'timeout',
  'local_error',
  'unknown',
]);
export const ATTEMPT_COUNT_BUCKETS: ReadonlySet<string> = new Set(['1', '2', '3_plus']);
export const SECS_SINCE_APP_START_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2_10m', 'over_10m']);
export const TTFT_BUCKETS: ReadonlySet<string> = new Set(['none', 'under_1s', '1_3s', '3_10s', 'over_10s']);
export const DEPOSIT_STEPS: ReadonlySet<string> = new Set([
  'method_shown',
  'method_chosen',
  'checkout_opened',
  'checkout_reopened',
  'checkout_abandoned',
  'region_unsupported',
  'card_declined',
  'payment_submitted',
  'credited',
]);
export const DEPOSIT_METHODS: ReadonlySet<string> = new Set(['card', 'crypto_wallet', 'payment_app', 'exchange', 'unknown']);
export const DEPOSIT_STEP_AMOUNT_BUCKETS: ReadonlySet<string> = new Set(['le_5', '5_10', '10_50', 'over_50']);
export const STEP_GAP_BUCKETS: ReadonlySet<string> = new Set(['first', 'under_10s', '10s_1m', '1m_5m', 'over_5m']);
export const STARTUP_OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed']);
export const STARTUP_FAILURE_STAGES: ReadonlySet<string> = new Set(['none', 'runtime', 'dht', 'peer_search', 'models']);
export const CONNECTED_APP_OUTCOMES: ReadonlySet<string> = new Set(['request_seen', 'no_request']);
export const SECS_SINCE_CONNECT_BUCKETS: ReadonlySet<string> = new Set(['under_1m', '1_5m', '5_30m', 'none']);
export const PREMIUM_BLOCKED_FOLLOWUPS: ReadonlySet<string> = new Set(['deposited', 'switched_free_model', 'left']);
export const ROUTE_MODES: ReadonlySet<string> = new Set(['auto', 'pinned']);
export const MODEL_PRICING_TIERS: ReadonlySet<string> = new Set(['free', 'paid', 'mixed', 'unknown']);

export function durationBucket(ms: number): DurationBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 5 * 60_000) return '2m_5m';
  return 'over_5m';
}

export function sessionDurationBucket(ms: number): SessionDurationBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 5 * 60_000) return '2m_5m';
  if (ms < 30 * 60_000) return 'over_5m';
  return 'over_30m';
}

export function attemptCountBucket(attempts: number): AttemptCountBucket {
  if (attempts <= 1) return '1';
  if (attempts === 2) return '2';
  return '3_plus';
}

export function secsSinceAppStartBucket(ms: number): SecsSinceAppStartBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 10 * 60_000) return '2_10m';
  return 'over_10m';
}

export function ttftBucket(ms: number | null): TtftBucket {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'none';
  if (ms < 1_000) return 'under_1s';
  if (ms < 3_000) return '1_3s';
  if (ms < 10_000) return '3_10s';
  return 'over_10s';
}

export function depositStepAmountBucket(amountUsdc: number): DepositStepAmountBucket | null {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;
  if (amountUsdc <= 5) return 'le_5';
  if (amountUsdc <= 10) return '5_10';
  if (amountUsdc <= 50) return '10_50';
  return 'over_50';
}

export function stepGapBucket(ms: number | null): StepGapBucket {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'first';
  if (ms < 10_000) return 'under_10s';
  if (ms < 60_000) return '10s_1m';
  if (ms < 5 * 60_000) return '1m_5m';
  return 'over_5m';
}

export function secsSinceConnectBucket(ms: number | null): SecsSinceConnectBucket {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'none';
  if (ms < 60_000) return 'under_1m';
  if (ms < 5 * 60_000) return '1_5m';
  return '5_30m';
}

/** HTTP status as sent: an integer in 100–599, else undefined. */
export function telemetryHttpStatus(statusCode: number | undefined): number | undefined {
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : undefined;
}

/**
 * Salted one-way seller identifier. PENDING PRIVACY SIGN-OFF: docs/telemetry.md
 * promises peer IDs are never sent, and peer IDs are public on the DHT, so a
 * fixed salt can be reversed by hashing every announced peer. Keep this OFF
 * until that is decided; the sanitizer also drops `seller_hash` while off.
 */
export const TELEMETRY_SELLER_HASH_ENABLED = false;
const SELLER_HASH_SALT = 'antseed-desktop-telemetry-seller-v1:';

export function sellerHash(peerId: string): string {
  return createHash('sha256').update(SELLER_HASH_SALT + peerId.trim().toLowerCase()).digest('hex').slice(0, 12);
}

export function depositAmountBucket(amountUsdc: number): DepositAmountBucket {
  if (amountUsdc < 5) return 'under_5';
  if (amountUsdc < 25) return '5_25';
  if (amountUsdc < 100) return '25_100';
  return '100_plus';
}

/** Converts a local exact balance into the only coarse values telemetry accepts. */
export function firstChatDepositSnapshot(balanceUsdc: string): FirstChatDepositSnapshot | null {
  const amountUsdc = Number(balanceUsdc);
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) return null;
  if (amountUsdc === 0) return { hadDeposit: false, depositBucket: 'none' };
  return { hadDeposit: true, depositBucket: depositAmountBucket(amountUsdc) };
}

export function daysSinceFirstOpenBucket(days: number): DaysSinceFirstOpen {
  if (days <= 0) return '0';
  if (days <= 7) return '1_7';
  if (days <= 30) return '8_30';
  return '31_plus';
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  return '21_plus';
}

export function offersAvailableBucket(count: number): OffersAvailableBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2_3';
  return '4_plus';
}

export function httpStatusBucket(statusCode?: number): HttpStatusBucket {
  if (typeof statusCode !== 'number') return 'none';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return 'other';
}

const PUBLIC_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;

export function publicModelId(serviceId: string, isCurrentlyAdvertised: boolean): string {
  const normalized = serviceId.trim().toLowerCase();
  return isCurrentlyAdvertised
    && modelMetadataFor(serviceId) !== null
    && PUBLIC_MODEL_ID_PATTERN.test(normalized)
    ? normalized
    : 'custom_or_unknown';
}

type ModelOfferPricing = {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  minImageUsdPerImage?: number;
  maxImageUsdPerImage?: number;
};

export type ModelPricingSnapshot = {
  pricingTier: ModelPricingTier;
  hasFreeEligibleOffer: boolean;
  eligibleOfferCountBucket: OffersAvailableBucket;
};

export function offerPricingKind(offer: ModelOfferPricing): 'free' | 'paid' | 'unknown' {
  const textPrices = [offer.inputUsdPerMillion, offer.outputUsdPerMillion, offer.cachedInputUsdPerMillion]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const imagePrices = [offer.minImageUsdPerImage, offer.maxImageUsdPerImage]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const prices = textPrices.length > 0 ? textPrices : imagePrices;
  if (prices.length === 0) return 'unknown';
  return prices.every((price) => price === 0) ? 'free' : 'paid';
}

/** Classifies only buyer-eligible catalog offers; exact prices never leave the device. */
export function modelPricingSnapshot(offers: ModelOfferPricing[]): ModelPricingSnapshot {
  const kinds = offers.map(offerPricingKind);
  const hasFree = kinds.includes('free');
  const hasPaid = kinds.includes('paid');
  return {
    pricingTier: hasFree && hasPaid ? 'mixed' : hasFree ? 'free' : hasPaid ? 'paid' : 'unknown',
    hasFreeEligibleOffer: hasFree,
    eligibleOfferCountBucket: offersAvailableBucket(offers.length),
  };
}

const IMAGE_SERVICE_PATTERN = /image|dall|flux|sdxl|stable[-_]?diffusion|midjourney|imagen/i;
const CHAT_SERVICE_PATTERN = /chat|claude|gpt|llama|qwen|deepseek|mistral|gemini|kimi|glm|grok|command|o[13]/i;

/** Coarse category used independently of the separately guarded public model ID. */
export function classifyServiceCategory(serviceId: string): ServiceCategory {
  if (IMAGE_SERVICE_PATTERN.test(serviceId)) return 'image';
  if (CHAT_SERVICE_PATTERN.test(serviceId)) return 'chat';
  return 'other';
}
