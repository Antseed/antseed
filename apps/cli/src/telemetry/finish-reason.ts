/**
 * Why a successful answer ended, read from the response's own finish or stop
 * reason, for telemetry only (never used to route or change a response).
 * Unrecognized shapes are `unknown`; an unfamiliar reason is `other`.
 */
import type { FinishReason } from './buyer.js'
import { visitBodyEvents } from './body-events.js'

type Json = Record<string, unknown>


function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

/** Maps one provider reason onto the fixed set. */
export function normalizeFinishReason(reason: unknown): FinishReason | null {
  if (typeof reason !== 'string' || reason.length === 0) return null
  switch (reason.toLowerCase()) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case 'completed':
      return 'stop'
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_call'
    case 'content_filter':
      return 'content_filter'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

/** The reason one JSON body or stream event carries, if any. */
function reasonOf(event: Json): FinishReason | null {
  // OpenAI chat and legacy completions: the last choice that says.
  if (Array.isArray(event['choices'])) {
    let found: FinishReason | null = null
    for (const choice of event['choices']) {
      const reason = normalizeFinishReason(asObject(choice)?.['finish_reason'])
      if (reason) found = reason
    }
    return found
  }
  // Anthropic: a full message, or the stream's message_delta.
  if (event['type'] === 'message') return normalizeFinishReason(event['stop_reason'])
  if (event['type'] === 'message_delta') return normalizeFinishReason(asObject(event['delta'])?.['stop_reason'])
  // OpenAI Responses: a full response, or the stream's final response event.
  const response = event['object'] === 'response' ? event : asObject(event['response'])
  if (response && typeof response['status'] === 'string') {
    if (response['status'] === 'incomplete') {
      return normalizeFinishReason(asObject(response['incomplete_details'])?.['reason']) ?? 'other'
    }
    if (response['status'] !== 'completed') return null
    const output = Array.isArray(response['output']) ? response['output'] : []
    const calledTool = output.some((item) => {
      const type = asObject(item)?.['type']
      return type === 'function_call' || type === 'custom_tool_call'
    })
    return calledTool ? 'tool_call' : 'stop'
  }
  return null
}

/** Why the answer ended; `unknown` when the body says nothing this recognizes. */
export function finishReasonFromBody(contentType: string | undefined, body: Uint8Array): FinishReason {
  let found: FinishReason | null = null
  visitBodyEvents(contentType, body, (event) => {
    const reason = reasonOf(event)
    if (reason) found = reason
  })
  return found ?? 'unknown'
}
