/**
 * Strict property sanitizer for telemetry events.
 *
 * Every property value passes through here before leaving the device:
 * - keys not in the event's allowlist are dropped;
 * - strings are truncated;
 * - numbers are bounded to safe, finite integers;
 * - unsupported value types (objects, arrays, functions) are dropped.
 */
import {
  ATTEMPT_COUNT_BUCKETS,
  CHAT_FAILURE_REASONS,
  CONNECTED_APP_OUTCOMES,
  DEPOSIT_METHODS,
  DEPOSIT_STEPS,
  DEPOSIT_STEP_AMOUNT_BUCKETS,
  PREMIUM_BLOCKED_FOLLOWUPS,
  SECS_SINCE_APP_START_BUCKETS,
  SECS_SINCE_CONNECT_BUCKETS,
  STARTUP_FAILURE_STAGES,
  STARTUP_OUTCOMES,
  STEP_GAP_BUCKETS,
  TTFT_BUCKETS,
  CHAT_FAILURE_CODES,
  CHAT_FAILURE_STAGES,
  CHAT_REQUEST_OUTCOMES,
  COUNT_BUCKETS,
  DAYS_SINCE_FIRST_OPEN_BUCKETS,
  DEPOSIT_FAILURE_CODES,
  DEPOSIT_FAILURE_STAGES,
  DEPOSIT_AMOUNT_BUCKETS,
  DISCOVERY_FAILURE_CODES,
  DURATION_BUCKETS,
  HTTP_STATUS_BUCKETS,
  MODEL_PRICING_TIERS,
  OFFERS_AVAILABLE_BUCKETS,
  ROUTE_MODES,
  SERVICE_CATEGORIES,
  SESSION_DURATION_BUCKETS,
  TELEMETRY_EVENT_ALLOWLIST,
  type TelemetryEventName,
  type TelemetryEventProperties,
} from './events.js';
import { TELEMETRY_ACTION_SURFACES, TELEMETRY_APP_NAMES, TELEMETRY_USER_ACTIONS } from '../../shared/telemetry.js';

const MAX_STRING_LENGTH = 64;
const MAX_ABS_NUMBER = Number.MAX_SAFE_INTEGER;

function sanitizeString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
}

function sanitizeNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(-MAX_ABS_NUMBER, Math.min(MAX_ABS_NUMBER, value));
  return Math.round(clamped);
}

const PROPERTY_VALIDATORS: Record<string, ReadonlySet<string>> = {
  duration_bucket: DURATION_BUCKETS,
  session_duration_bucket: SESSION_DURATION_BUCKETS,
  amount_bucket: DEPOSIT_AMOUNT_BUCKETS,
  deposit_bucket: new Set(['none', ...DEPOSIT_AMOUNT_BUCKETS]),
  days_since_first_open: DAYS_SINCE_FIRST_OPEN_BUCKETS,
  service_category: SERVICE_CATEGORIES,
  route_mode: ROUTE_MODES,
  offers_available_bucket: OFFERS_AVAILABLE_BUCKETS,
  http_status_bucket: HTTP_STATUS_BUCKETS,
  routing_node_count_bucket: COUNT_BUCKETS,
  eligible_offer_count_bucket: OFFERS_AVAILABLE_BUCKETS,
  pricing_tier: MODEL_PRICING_TIERS,
  action: new Set(TELEMETRY_USER_ACTIONS),
  surface: new Set(TELEMETRY_ACTION_SURFACES),
  method: DEPOSIT_METHODS,
  failure_reason: CHAT_FAILURE_REASONS,
  attempt_count: ATTEMPT_COUNT_BUCKETS,
  secs_since_app_start: SECS_SINCE_APP_START_BUCKETS,
  sellers_known_bucket: OFFERS_AVAILABLE_BUCKETS,
  free_sellers_known_bucket: OFFERS_AVAILABLE_BUCKETS,
  ttft_bucket: TTFT_BUCKETS,
  step: DEPOSIT_STEPS,
  secs_since_prev_step: STEP_GAP_BUCKETS,
  secs_since_connect: SECS_SINCE_CONNECT_BUCKETS,
  next_action: PREMIUM_BLOCKED_FOLLOWUPS,
};

const EVENT_PROPERTY_VALIDATORS: Partial<Record<TelemetryEventName, Record<string, ReadonlySet<string>>>> = {
  deposit_failed: {
    failure_code: DEPOSIT_FAILURE_CODES,
    failure_stage: DEPOSIT_FAILURE_STAGES,
  },
  chat_request_finished: {
    outcome: CHAT_REQUEST_OUTCOMES,
    failure_code: CHAT_FAILURE_CODES,
    failure_stage: CHAT_FAILURE_STAGES,
  },
  discovery_failed: {
    failure_code: DISCOVERY_FAILURE_CODES,
  },
  deposit_step: {
    amount_bucket: DEPOSIT_STEP_AMOUNT_BUCKETS,
  },
  startup_finished: {
    outcome: STARTUP_OUTCOMES,
    failure_stage: STARTUP_FAILURE_STAGES,
  },
  connected_app_first_request: {
    app: new Set(TELEMETRY_APP_NAMES),
    outcome: CONNECTED_APP_OUTCOMES,
  },
};

const PUBLIC_MODEL_ID_PATTERN = /^(?:custom_or_unknown|[a-z0-9][a-z0-9._:/-]{0,63})$/;
const RANDOM_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Keys checked against a pattern below: strings only. */
const STRING_PATTERN_KEYS: ReadonlySet<string> = new Set(['public_model_id', 'request_id']);

export function sanitizeTelemetryProperties<K extends TelemetryEventName>(
  event: K,
  properties: TelemetryEventProperties[K],
): Record<string, string | number | boolean> {
  const allowlist = TELEMETRY_EVENT_ALLOWLIST[event];
  const out: Record<string, string | number | boolean> = {};
  const raw = (properties ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowlist.has(key)) continue;
    if (key === 'http_status' && (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599)) continue;
    // A key with allowed values or a pattern takes only strings.
    const propertyValidator = EVENT_PROPERTY_VALIDATORS[event]?.[key] ?? PROPERTY_VALIDATORS[key];
    if ((propertyValidator || STRING_PATTERN_KEYS.has(key)) && typeof value !== 'string') continue;
    if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      const num = sanitizeNumber(value);
      if (num !== null) out[key] = num;
    } else if (typeof value === 'string') {
      if (propertyValidator && !propertyValidator.has(value)) continue;
      if (key === 'public_model_id' && !PUBLIC_MODEL_ID_PATTERN.test(value)) continue;
      if (key === 'request_id' && !RANDOM_REQUEST_ID_PATTERN.test(value)) continue;
      out[key] = sanitizeString(value);
    }
    // Objects/arrays/null/undefined/functions are dropped.
  }
  return out;
}
