/**
 * Every event the CLI, the buyer and the gateway may send, with the only
 * properties and values each may carry. The shared sanitizer drops anything
 * else. Keep `docs/telemetry.md` in step with this file.
 */
import {
  ATTEMPT_COUNT_BUCKETS,
  COUNT_BUCKETS,
  DURATION_BUCKETS,
  FAILURE_REASONS,
  HTTP_STATUS_RANGE,
  PUBLIC_MODEL_ID_PATTERN,
  REQUEST_DURATION_BUCKETS,
  SELLERS_TRIED_BUCKETS,
  TTFT_BUCKETS,
  USDC_AMOUNT_BUCKETS,
  type EventCatalog,
} from '@antseed/telemetry'

const set = (...values: string[]): ReadonlySet<string> => new Set(values)

export const OUTCOMES = set('success', 'failed', 'cancelled')
export const INSTALL_SOURCES = set('installer', 'npm', 'pnpm', 'yarn', 'bun', 'volta', 'npx', 'nix', 'desktop', 'local', 'source', 'unknown')
export const REQUEST_PROTOCOLS = set(
  'anthropic-messages', 'openai-chat-completions', 'openai-completions', 'openai-responses',
  'openai-images', 'typesafe-systemone', 'video', 'unknown',
)
export const ROUTE_MODES = set('auto', 'pinned', 'router')
export const JOURNEY_MOMENTS = set('first_success', 'failure', 'cancelled', 'fell_back', 'recovered')
export const SELLER_TIERS = set('free', 'paid', 'unknown')
/** Coding tools the proxy recognizes by their own session headers; anything else is `custom`. */
export const CLIENT_TOOLS = set(
  'claude-code', 'codex', 'opencode', 'droid', 'pi', 'zed', 'goose', 'crush', 'hermes', 'cursor',
  'cline', 'aider', 'continue', 'openclaw', 't3code', 'custom', 'none',
)
/** `name`: a hostname whose reach is not known from the name alone. */
export const LISTEN_EXPOSURES = set('loopback', 'private', 'public', 'any', 'name')
export const TOPUP_OUTCOMES = set('settled', 'rejected', 'failed')

export const CLI_EVENT_CATALOG: EventCatalog = {
  cli_command_run: {
    keys: set('command', 'outcome', 'duration_bucket', 'is_first_run'),
    values: {
      outcome: set('success', 'failed'),
      duration_bucket: DURATION_BUCKETS,
    },
    patterns: { command: /^[a-z][a-z0-9-]{0,31}(?: [a-z][a-z0-9-]{0,31}){0,3}$/ },
  },
  buyer_started: {
    keys: set('payments_enabled', 'verifier_enabled', 'owns_proxy_port'),
  },
  buyer_request_finished: {
    keys: set(
      'protocol', 'public_model_id', 'route_mode', 'client_tool', 'outcome', 'failure_reason', 'http_status',
      'attempt_count', 'sellers_tried', 'fell_back', 'seller_tier', 'ttft_bucket', 'duration_bucket', 'streamed',
      'journey_moment',
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
      ttft_bucket: TTFT_BUCKETS,
      duration_bucket: REQUEST_DURATION_BUCKETS,
      journey_moment: JOURNEY_MOMENTS,
    },
    patterns: { public_model_id: PUBLIC_MODEL_ID_PATTERN },
    ranges: { http_status: HTTP_STATUS_RANGE },
  },
  gateway_started: {
    keys: set('listen_exposure', 'console_enabled', 'x402_enabled', 'workspace_count_bucket', 'key_count_bucket', 'member_count_bucket'),
    values: {
      listen_exposure: LISTEN_EXPOSURES,
      workspace_count_bucket: COUNT_BUCKETS,
      key_count_bucket: COUNT_BUCKETS,
      member_count_bucket: COUNT_BUCKETS,
    },
  },
  gateway_daily: {
    keys: set('workspace_count_bucket', 'key_count_bucket', 'member_count_bucket', 'uptime_days'),
    values: {
      workspace_count_bucket: COUNT_BUCKETS,
      key_count_bucket: COUNT_BUCKETS,
      member_count_bucket: COUNT_BUCKETS,
    },
    ranges: { uptime_days: [0, 3_650] },
  },
  gateway_topup: {
    keys: set('outcome', 'amount_bucket'),
    values: { outcome: TOPUP_OUTCOMES, amount_bucket: USDC_AMOUNT_BUCKETS },
  },
}
