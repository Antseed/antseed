import { isDeepStrictEqual } from 'node:util'
import {
  KBF_THINKING_SUPPRESSION_FIELDS,
  buildKbfPrompt,
  getKbfPromptVariant,
  type KbfProbe,
} from '@antseed/fingerprints'
import type { EnvelopeSliceV1 } from './types.js'

type Turn = { role: 'system' | 'user' | 'assistant'; text: string }
type Body = Record<string, unknown>

/** Fields that never change what the model answers. */
const NEUTRAL_FIELDS = new Set(['model', 'service', 'stream', 'stream_options', 'metadata', 'user', 'prompt_cache_key'])
const TOKEN_FIELDS = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])
const THINKING_FIELDS = new Set<string>(KBF_THINKING_SUPPRESSION_FIELDS)
const PROTOCOL_FIELDS = {
  chat: new Set(['messages']),
  messages: new Set(['system', 'messages']),
  responses: new Set(['instructions', 'input']),
} as const
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])
const TEXT_PART_FIELDS = new Set(['type', 'text', 'cache_control'])

/**
 * Checks that a signed request is exactly the planned audit request, in any of the wire formats
 * the buyer may translate it to on the way to the seller (Chat Completions, Anthropic Messages,
 * Responses): the planned system and user messages and nothing else (no extra instructions,
 * tools or content), at most the reference's assistant prefill, temperature 0 or none, the
 * reference's max tokens, and only the reference's thinking-suppression settings. Without
 * this a collector could ask the planned questions next to instructions that make an honest
 * seller answer wrong.
 *
 * Returns null when the request is acceptable, otherwise the reason it is not.
 */
export function auditRequestProblem(input: {
  path: string
  body: Uint8Array
  service: string
  probes: readonly KbfProbe[]
  promptVariantId: string
  settings: EnvelopeSliceV1['request']
}): string | null {
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(input.body).toString('utf8'))
  } catch {
    return 'request body is not JSON'
  }
  if (!isRecord(body)) return 'request body is not a JSON object'
  const protocol = protocolOf(input.path)
  if (!protocol) return `unexpected request path ${input.path}`

  for (const [field, value] of Object.entries(body)) {
    const problem = fieldProblem(field, value, protocol, input)
    if (problem) return problem
  }

  const turns = protocol === 'chat' ? chatTurns(body) : protocol === 'messages' ? messagesTurns(body) : responsesTurns(body)
  if (typeof turns === 'string') return turns
  const expected: Turn[] = [
    { role: 'system', text: getKbfPromptVariant(input.promptVariantId).systemPrompt },
    { role: 'user', text: buildKbfPrompt(input.probes, 0, input.promptVariantId) },
  ]
  const prefill = input.settings.assistantPrefill
  const matches = isDeepStrictEqual(turns, expected)
    || (prefill !== null && isDeepStrictEqual(turns, [...expected, { role: 'assistant', text: prefill }]))
  return matches ? null : 'request messages differ from the planned audit prompt'
}

function protocolOf(path: string): keyof typeof PROTOCOL_FIELDS | null {
  const bare = path.split('?')[0]!.replace(/\/+$/, '')
  if (bare.endsWith('/chat/completions')) return 'chat'
  if (bare.endsWith('/messages')) return 'messages'
  if (bare.endsWith('/responses')) return 'responses'
  return null
}

function fieldProblem(
  field: string,
  value: unknown,
  protocol: keyof typeof PROTOCOL_FIELDS,
  input: { service: string; settings: EnvelopeSliceV1['request'] },
): string | null {
  if (PROTOCOL_FIELDS[protocol].has(field)) return null
  if (TOKEN_FIELDS.has(field)) return value === input.settings.maxTokens ? null : `${field} is not ${input.settings.maxTokens}`
  if (field === 'temperature') return value === 0 ? null : 'temperature is not 0'
  if (THINKING_FIELDS.has(field)) return thinkingProblem(field, value, input.settings.thinkingOverrides)
  if (!NEUTRAL_FIELDS.has(field)) return `unexpected request field ${field}`
  if ((field === 'model' || field === 'service')
    && (typeof value !== 'string' || value.trim().toLowerCase() !== input.service.trim().toLowerCase())) {
    return `${field} is not the audited service`
  }
  if (field === 'stream' && typeof value !== 'boolean') return 'stream is not a boolean'
  if (field === 'stream_options' && (!isRecord(value) || Object.keys(value).some((key) => key !== 'include_usage'))) {
    return 'unexpected stream_options'
  }
  return null
}

/** Thinking fields must carry the reference's own values; Responses spells reasoning_effort as reasoning.effort. */
function thinkingProblem(field: string, value: unknown, overrides: Record<string, unknown>): string | null {
  if (overrides[field] !== undefined && isDeepStrictEqual(value, overrides[field])) return null
  if (field === 'reasoning' && overrides['reasoning_effort'] !== undefined
    && isDeepStrictEqual(value, { effort: overrides['reasoning_effort'] })) {
    return null
  }
  return `${field} differs from the reference's thinking settings`
}

function chatTurns(body: Body): Turn[] | string {
  if (!Array.isArray(body['messages'])) return 'messages is not a list'
  const turns: Turn[] = []
  for (const message of body['messages']) {
    if (!isRecord(message) || Object.keys(message).some((key) => key !== 'role' && key !== 'content')) return 'unexpected message shape'
    const role = turnRole(message['role'])
    const text = textOf(message['content'])
    if (!role || text === null) return 'unexpected message role or content'
    turns.push({ role, text })
  }
  return turns
}

function messagesTurns(body: Body): Turn[] | string {
  const turns: Turn[] = []
  if (body['system'] !== undefined) {
    const system = textOf(body['system'])
    if (system === null) return 'unexpected system content'
    turns.push({ role: 'system', text: system })
  }
  if (!Array.isArray(body['messages'])) return 'messages is not a list'
  for (const message of body['messages']) {
    if (!isRecord(message) || Object.keys(message).some((key) => key !== 'role' && key !== 'content')) return 'unexpected message shape'
    const role = message['role'] === 'user' || message['role'] === 'assistant' ? message['role'] : null
    const text = textOf(message['content'])
    if (!role || text === null) return 'unexpected message role or content'
    turns.push({ role, text })
  }
  return turns
}

function responsesTurns(body: Body): Turn[] | string {
  const turns: Turn[] = []
  if (body['instructions'] !== undefined) {
    if (typeof body['instructions'] !== 'string') return 'instructions is not text'
    turns.push({ role: 'system', text: body['instructions'] })
  }
  const items = body['input']
  if (typeof items === 'string') return [...turns, { role: 'user', text: items }]
  if (!Array.isArray(items)) return 'input is not a list'
  for (const item of items) {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== 'type' && key !== 'role' && key !== 'content')) return 'unexpected input item'
    if (item['type'] !== undefined && item['type'] !== 'message') return 'unexpected input item'
    const role = turnRole(item['role'])
    const text = textOf(item['content'])
    if (!role || text === null) return 'unexpected input role or content'
    turns.push({ role, text })
  }
  return turns
}

function turnRole(role: unknown): Turn['role'] | null {
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'user' || role === 'assistant') return role
  return null
}

/** A string, or a list of text parts only (no images, tools or other blocks). */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  let text = ''
  for (const part of content) {
    if (!isRecord(part) || typeof part['type'] !== 'string' || !TEXT_PART_TYPES.has(part['type']) || typeof part['text'] !== 'string') return null
    if (Object.keys(part).some((key) => !TEXT_PART_FIELDS.has(key))) return null
    text += part['text']
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
