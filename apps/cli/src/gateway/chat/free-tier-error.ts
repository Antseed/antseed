import { FREE_TIER_EXHAUSTED_ERROR_ID, readFreeTierLimit } from '@antseed/node'
import type { ChatFreeTierError } from '../console-api/types.js'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The buyer's free-tier 429 behind an AI SDK error (retries wrap it), or null. */
export function freeTierChatError(error: unknown): ChatFreeTierError | null {
  const candidates = [error, ...(Array.isArray(record(error)?.['errors']) ? record(error)!['errors'] as unknown[] : [])]
  for (const candidate of candidates.reverse()) {
    const responseBody = record(candidate)?.['responseBody']
    if (typeof responseBody !== 'string') continue
    let body: Record<string, unknown> | null = null
    try { body = record(JSON.parse(responseBody)) } catch { continue }
    const inner = record(body?.['error'])
    if (inner?.['code'] !== FREE_TIER_EXHAUSTED_ERROR_ID || typeof inner['message'] !== 'string') continue
    const freeTier = readFreeTierLimit(record(body?.['free_tier']))
    if (freeTier) return { code: FREE_TIER_EXHAUSTED_ERROR_ID, message: inner['message'], freeTier }
  }
  return null
}

/** What the chat stream sends the console for a failed turn: the free-tier limit as JSON, else the message. */
export function chatErrorText(error: unknown): string {
  const freeTier = freeTierChatError(error)
  if (freeTier) return JSON.stringify(freeTier)
  return error instanceof Error ? error.message : String(error)
}
