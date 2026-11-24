import { isReasoningEffort, type SerializedHttpRequest, type ServiceCapabilities } from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'
import { parseJsonObject } from '@antseed/api-adapter'
import type { BuyerReasoningEffortConfig } from '../config/types.js'
import type { ServiceApiProtocol } from './service-api-adapter.js'
import { encodeRewrittenJsonBody } from './request-utils.js'

/** Request: the level for this one request, or "off". Response: the level the buyer added. */
export const DEFAULT_REASONING_EFFORT_HEADER = 'x-antseed-default-reasoning-effort'
/** The buyer's own word for "add nothing", in any letter case. Not a level. */
export const REASONING_EFFORT_OFF = 'off'
/** Request paths the buyer adds an effort to, each with its client format. */
const EFFORT_REQUEST_PATHS: ReadonlyMap<string, ServiceApiProtocol> = new Map([
  ['/v1/chat/completions', 'openai-chat-completions'],
  ['/v1/responses', 'openai-responses'],
])
/** Seller formats an added effort survives into. Add 'anthropic-messages' when translation carries it. */
const EFFORT_TARGET_PROTOCOLS: ReadonlySet<string> = new Set(['openai-chat-completions', 'openai-responses'])
/** Top-level request fields that mean the client made its own reasoning choice. */
const CLIENT_REASONING_KEYS: readonly string[] = [
  'reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget', 'thinking_config', 'include_reasoning', 'think',
]
/** Fields of a `chat_template_kwargs` object that mean the same. */
const CLIENT_TEMPLATE_REASONING_KEYS: readonly string[] = ['enable_thinking', 'thinking']

export function isReasoningEffortOff(value: string): boolean {
  return value.toLowerCase() === REASONING_EFFORT_OFF
}

/** A valid setting or header value: "off" in any letter case, or a protocol reasoning effort label. */
export function isReasoningEffortSetting(value: unknown): value is string {
  return typeof value === 'string' && (isReasoningEffortOff(value) || isReasoningEffort(value))
}

function levelOrNull(value: string): string | null {
  return isReasoningEffortSetting(value) && !isReasoningEffortOff(value) ? value : null
}

/**
 * The level the buyer wants for `model`, or null for none.
 * Order: the request header when one is sent, else `config.models` by canonical model key,
 * else `config.default`. "off", an invalid label or a null config give null. So does a header
 * that is not a valid setting: a request that tried to choose never gets the configured level.
 */
function wantedReasoningEffort(
  config: BuyerReasoningEffortConfig | null,
  model: string | null,
  header: string | undefined,
): string | null {
  if (header !== undefined) return levelOrNull(header.trim())
  if (!config) return null
  if (model) {
    const key = canonicalModelKey(model)
    for (const [configured, level] of Object.entries(config.models)) {
      if (canonicalModelKey(configured) === key) return levelOrNull(level)
    }
  }
  return levelOrNull(config.default)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function clientChoseReasoning(body: Record<string, unknown>): boolean {
  if (CLIENT_REASONING_KEYS.some((key) => hasOwn(body, key))) return true
  const kwargs = body['chat_template_kwargs']
  return isPlainObject(kwargs) && CLIENT_TEMPLATE_REASONING_KEYS.some((key) => hasOwn(kwargs, key))
}

/**
 * `request` with `effort` added in `protocol`'s own field, or the same object when the client
 * already made a reasoning choice, the body is not a JSON object, or it cannot be written again.
 * Never changes an existing key.
 */
function addReasoningEffort(
  request: SerializedHttpRequest,
  protocol: ServiceApiProtocol,
  effort: string,
): SerializedHttpRequest {
  const body = parseJsonObject(request.body)
  if (!body || clientChoseReasoning(body)) return request
  if (protocol === 'openai-chat-completions') {
    if (hasOwn(body, 'reasoning')) return request
    body['reasoning_effort'] = effort
  } else if (protocol === 'openai-responses') {
    if (!hasOwn(body, 'reasoning')) {
      body['reasoning'] = { effort }
    } else {
      const reasoning = body['reasoning']
      if (!isPlainObject(reasoning) || hasOwn(reasoning, 'effort')) return request
      body['reasoning'] = { ...reasoning, effort }
    }
  } else {
    return request
  }
  try {
    return { ...request, ...encodeRewrittenJsonBody(body, request.headers) }
  } catch {
    // Nested too deeply to serialise: the default is not worth failing the request for.
    return request
  }
}

/** The client format of a create request (`POST`, query and one trailing slash ignored), or null. */
function effortRequestProtocol(request: SerializedHttpRequest): ServiceApiProtocol | null {
  if (request.method.toUpperCase() !== 'POST') return null
  const path = request.path.split('?')[0]!
  return EFFORT_REQUEST_PATHS.get(path.endsWith('/') ? path.slice(0, -1) : path) ?? null
}

export interface DefaultReasoningEffortInput {
  config: BuyerReasoningEffortConfig | null
  /** Value of DEFAULT_REASONING_EFFORT_HEADER on the client's request. */
  header: string | undefined
  /** The model as routed (pin stripped); null uses `config.default`. */
  model: string | null
  requestProtocol: ServiceApiProtocol | null
  /** The seller's format: `selection.targetProtocol`, or the request's own on a native route. */
  targetProtocol: ServiceApiProtocol | null
  /** What the seller announces for the routed service. */
  capabilities: ServiceCapabilities | undefined
  request: SerializedHttpRequest
}

/**
 * The request to send and the level added to it (null: `request` is returned as is, same object).
 * A level is added only when the seller's announced `reasoningEfforts` contains exactly it.
 */
export function applyDefaultReasoningEffort(
  input: DefaultReasoningEffortInput,
): { request: SerializedHttpRequest; added: string | null } {
  const { request, requestProtocol, targetProtocol } = input
  const none = { request, added: null }
  if (!requestProtocol || effortRequestProtocol(request) !== requestProtocol) return none
  if (!targetProtocol || !EFFORT_TARGET_PROTOCOLS.has(targetProtocol)) return none
  const announced = input.capabilities?.reasoningEfforts
  if (!Array.isArray(announced)) return none
  const wanted = wantedReasoningEffort(input.config, input.model, input.header)
  if (wanted === null || !announced.includes(wanted)) return none
  const next = addReasoningEffort(request, requestProtocol, wanted)
  if (next === request) return none
  return { request: next, added: wanted }
}
