/**
 * Every event the buyer and the gateway may send, with the only properties and values each
 * may carry. The shared sanitizer drops anything else. Keep `docs/telemetry.md` in step with this file.
 */
import {
  ATTEMPT_COUNT_BUCKETS,
  FAILURE_REASONS,
  HTTP_STATUS_RANGE,
  PUBLIC_MODEL_ID_PATTERN,
  RANDOM_REQUEST_ID_PATTERN,
  SELLERS_TRIED_BUCKETS,
  SMALL_COUNT_BUCKETS,
  USDC_AMOUNT_BUCKETS,
  type EventCatalog,
} from '@antseed/telemetry'
import { DEFAULT_APP_PROFILES } from '@antseed/connected-apps/defaults'

const set = (...values: string[]): ReadonlySet<string> => new Set(values)

export const OUTCOMES = set('success', 'failed', 'cancelled')
export const INSTALL_SOURCES = set('installer', 'npm', 'pnpm', 'yarn', 'bun', 'volta', 'npx', 'nix', 'desktop', 'local', 'source', 'unknown')
export const REQUEST_PROTOCOLS = set(
  'anthropic-messages', 'openai-chat-completions', 'openai-completions', 'openai-responses',
  'openai-images', 'typesafe-systemone', 'video', 'unknown',
)
export const ROUTE_MODES = set('auto', 'pinned', 'router')
export const SELLER_TIERS = set('free', 'paid', 'unknown')
export const CONVERSATION_KEY_SOURCES = set('tool_session', 'prompt_cache_key', 'prompt_prefix', 'none')
export const TURN_BUCKETS = set('1', '2_5', '6_20', '21_plus', 'unknown')
export const SELLER_CHOICES = set('first_turn', 'kept_previous', 'switched', 'no_conversation', 'no_answer')
export const SWITCH_REASONS = set(
  'previous_failed', 'previous_cooling_down', 'previous_unhealthy', 'previous_unavailable', 'previous_excluded',
  'needs_funds', 'policy_route', 'pinned_elsewhere', 'router_choice', 'other',
)
export const CHOSEN_RANKS = set('1', '2', '3_plus')
/** Exact token counts: whole numbers, capped well above any model's context. */
export const TOKEN_COUNT_RANGE: readonly [number, number] = [0, 100_000_000]
/** Exact milliseconds: whole numbers, capped at a day. */
export const DURATION_MS_RANGE: readonly [number, number] = [0, 86_400_000]
/** A request's cost at the seller's listed price, in millionths of a USD (up to $10,000). */
export const COST_MICRO_USD_RANGE: readonly [number, number] = [0, 10_000_000_000]
/**
 * Which seller-selection algorithm routed the request, so a new one can be
 * compared with the current one (A/B or before/after). A new algorithm adds
 * its own value here and sets it on the requests it routes.
 */
export const ROUTING_VERSION = 'v1'
export const ROUTING_VERSIONS = set(ROUTING_VERSION)
/** A video job is one `create`, then `retrieve` calls (status polls and the download) until it is done. */
export const VIDEO_ACTIONS = set('create', 'retrieve')
export const FINISH_REASONS = set('stop', 'length', 'tool_call', 'content_filter', 'refusal', 'other', 'unknown')
/** A seller attempt's result: the request taxonomy, plus an answer with no text or tool call. */
export const ATTEMPT_FAILURE_REASONS = set(...FAILURE_REASONS, 'empty_answer')
/** 1-based position of an attempt in its request. Past 10 attempts the buyer sends the first 9 and the final one, under its real number. */
export const ATTEMPT_NUMBER_RANGE: readonly [number, number] = [1, 1_000]
/** A seller's public peer id (its EVM address, lowercase, no `0x`). */
export const SELLER_ID_PATTERN = /^[0-9a-f]{40}$/
/**
 * Connected apps, from the same list the desktop and `antseed apps` use: each
 * app's name and the tool slugs its requests carry. A new built-in app is
 * reported under its own name with no change here.
 */
export const CONNECTED_APP_TOOLS: ReadonlyArray<{ readonly name: string; readonly slugs: readonly string[] }> = DEFAULT_APP_PROFILES
  .filter((profile) => typeof profile['name'] === 'string')
  .map((profile) => {
    const name = profile['name'] as string
    const slugs = Array.isArray(profile['toolSlugs']) ? (profile['toolSlugs'] as unknown[]).filter((slug): slug is string => typeof slug === 'string') : []
    return { name, slugs: slugs.length > 0 ? slugs : [name] }
  })
/** Client tools reported by name: the connected apps plus other coding tools the proxy recognizes; anything else is `custom`. */
export const CLIENT_TOOLS = set(
  ...CONNECTED_APP_TOOLS.map((app) => app.name),
  'cursor', 'cline', 'aider', 'continue', 'openclaw', 'custom', 'none',
)

export const CLI_EVENT_CATALOG: EventCatalog = {
  buyer_started: {
    keys: set('payments_enabled', 'verifier_enabled', 'owns_proxy_port'),
  },
  buyer_deposit_credited: {
    keys: set('amount_bucket'),
    values: { amount_bucket: USDC_AMOUNT_BUCKETS },
  },
  buyer_request_finished: {
    keys: set(
      'request_id', 'protocol', 'public_model_id', 'route_mode', 'client_tool', 'outcome', 'failure_reason', 'http_status',
      'attempt_count', 'sellers_tried', 'fell_back', 'seller_tier', 'streamed',
      'seller_id', 'conversation_key_source', 'turn_bucket', 'seller_choice', 'switch_reason', 'candidates_bucket',
      'chosen_rank', 'input_tokens', 'cached_input_tokens', 'usage_reported',
      'ttft_ms', 'duration_ms', 'output_tokens', 'finish_reason', 'estimated_cost_micro_usd',
      'client_retry', 'video_action', 'seller_ttft_ms', 'failed_attempts_ms', 'rate_limited', 'routing_version',
    ),
    values: {
      protocol: REQUEST_PROTOCOLS,
      route_mode: ROUTE_MODES,
      client_tool: CLIENT_TOOLS,
      outcome: OUTCOMES,
      failure_reason: FAILURE_REASONS,
      attempt_count: ATTEMPT_COUNT_BUCKETS,
      sellers_tried: SELLERS_TRIED_BUCKETS,
      seller_tier: SELLER_TIERS,
      conversation_key_source: CONVERSATION_KEY_SOURCES,
      turn_bucket: TURN_BUCKETS,
      seller_choice: SELLER_CHOICES,
      switch_reason: SWITCH_REASONS,
      candidates_bucket: SMALL_COUNT_BUCKETS,
      chosen_rank: CHOSEN_RANKS,
      finish_reason: FINISH_REASONS,
      video_action: VIDEO_ACTIONS,
      routing_version: ROUTING_VERSIONS,
    },
    patterns: { request_id: RANDOM_REQUEST_ID_PATTERN, public_model_id: PUBLIC_MODEL_ID_PATTERN, seller_id: SELLER_ID_PATTERN },
    ranges: {
      http_status: HTTP_STATUS_RANGE,
      input_tokens: TOKEN_COUNT_RANGE,
      cached_input_tokens: TOKEN_COUNT_RANGE,
      output_tokens: TOKEN_COUNT_RANGE,
      ttft_ms: DURATION_MS_RANGE,
      seller_ttft_ms: DURATION_MS_RANGE,
      failed_attempts_ms: DURATION_MS_RANGE,
      duration_ms: DURATION_MS_RANGE,
      estimated_cost_micro_usd: COST_MICRO_USD_RANGE,
    },
  },
  // One per seller a request was sent to, in order, so every seller's
  // failures count, not only the last one's. Joined to its request by `request_id`.
  buyer_seller_attempt: {
    keys: set(
      'request_id', 'attempt_number', 'seller_id', 'seller_tier', 'protocol', 'public_model_id', 'route_mode',
      'client_tool', 'routing_version', 'outcome', 'failure_reason', 'http_status', 'empty_answer', 'streamed',
      'duration_ms', 'seller_ttft_ms',
    ),
    values: {
      seller_tier: SELLER_TIERS,
      protocol: REQUEST_PROTOCOLS,
      route_mode: ROUTE_MODES,
      client_tool: CLIENT_TOOLS,
      routing_version: ROUTING_VERSIONS,
      outcome: OUTCOMES,
      failure_reason: ATTEMPT_FAILURE_REASONS,
    },
    patterns: { request_id: RANDOM_REQUEST_ID_PATTERN, public_model_id: PUBLIC_MODEL_ID_PATTERN, seller_id: SELLER_ID_PATTERN },
    ranges: {
      attempt_number: ATTEMPT_NUMBER_RANGE,
      http_status: HTTP_STATUS_RANGE,
      duration_ms: DURATION_MS_RANGE,
      seller_ttft_ms: DURATION_MS_RANGE,
    },
  },
}

/** The gateway's setup funnel, in the order a team usually goes through it. */
export const GATEWAY_STEPS = set(
  'gateway_started', 'console_claimed', 'workspace_created', 'key_created', 'member_invited', 'invite_accepted', 'signed_in',
)

export const GATEWAY_EVENT_CATALOG: EventCatalog = {
  gateway_step: {
    keys: set('step'),
    values: { step: GATEWAY_STEPS },
  },
}
