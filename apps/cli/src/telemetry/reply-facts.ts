/**
 * What a seller's successful answer held, for telemetry only (never used to
 * route or change a response): how many tool calls, whether it had text, and
 * the reasoning tokens its usage itemised. Read from the seller's own body, a
 * whole JSON answer or its event stream, in the seller's protocol. Only the
 * counts leave this module; the text is never kept.
 */

import { MAX_BODY_BYTES, visitBodyEvents } from './body-events.js'

type Json = Record<string, unknown>

export type ReplyFacts = {
  toolCalls: number
  hasText: boolean
  /** Null when the answer's usage itemises no reasoning; a reported 0 is kept. */
  reasoningTokens: number | null
}

/** Where each API itemises reasoning in its usage object (the same fields the adapter reads). */
const REASONING_TOKEN_FIELDS: Record<string, readonly [string, string]> = {
  'openai-chat-completions': ['completion_tokens_details', 'reasoning_tokens'],
  'openai-responses': ['output_tokens_details', 'reasoning_tokens'],
  'anthropic-messages': ['output_tokens_details', 'thinking_tokens'],
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

class ReplyReader {
  /** Tool calls by a key unique within the answer (chat index, block index, item id). */
  private readonly calls = new Set<string>()
  text = false
  reasoningTokens: number | null = null

  constructor(private readonly reasoningField: readonly [string, string] | null) {}

  get toolCalls(): number {
    return this.calls.size
  }

  private usage(usage: unknown): void {
    if (!this.reasoningField) return
    const details = asObject(asObject(usage)?.[this.reasoningField[0]])
    const count = details?.[this.reasoningField[1]]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) this.reasoningTokens = Math.floor(count)
  }

  private chatChoice(choice: Json, choiceIndex: number): void {
    for (const part of [asObject(choice['message']), asObject(choice['delta'])]) {
      if (!part) continue
      if (hasText(part['content'])) this.text = true
      if (Array.isArray(part['content']) && part['content'].some((block) => hasText(asObject(block)?.['text']))) this.text = true
      if (asObject(part['function_call'])) this.calls.add(`chat:${choiceIndex}:function_call`)
      if (!Array.isArray(part['tool_calls'])) continue
      part['tool_calls'].forEach((call, position) => {
        const index = asObject(call)?.['index']
        this.calls.add(`chat:${choiceIndex}:${typeof index === 'number' ? index : position}`)
      })
    }
  }

  private anthropicBlock(block: Json, index: unknown): void {
    const type = block['type']
    if (type === 'tool_use' || type === 'server_tool_use') this.calls.add(`block:${typeof index === 'number' ? index : this.calls.size}`)
    if ((type === 'text' || type === 'text_delta') && hasText(block['text'])) this.text = true
  }

  /** `key` names the item's place in the answer, so its added, done and final copies count once. */
  private responsesItem(item: Json, key: string): void {
    const type = item['type']
    // Calls of the client's own tools; built-in tools (web search and the like) are the seller's.
    if (type === 'function_call' || type === 'custom_tool_call') this.calls.add(key)
    if (type === 'message' && Array.isArray(item['content'])
      && item['content'].some((part) => hasText(asObject(part)?.['text']))) this.text = true
  }

  feed(event: Json): void {
    if (Array.isArray(event['choices'])) {
      event['choices'].forEach((choice, position) => {
        const parsed = asObject(choice)
        if (parsed) this.chatChoice(parsed, typeof parsed['index'] === 'number' ? parsed['index'] : position)
      })
      this.usage(event['usage'])
      return
    }
    // Anthropic: a whole message, or the stream's events.
    if (event['type'] === 'message' && Array.isArray(event['content'])) {
      event['content'].forEach((block, index) => {
        const parsed = asObject(block)
        if (parsed) this.anthropicBlock(parsed, index)
      })
      this.usage(event['usage'])
      return
    }
    if (event['type'] === 'message_start') {
      this.usage(asObject(event['message'])?.['usage'])
      return
    }
    if (event['type'] === 'content_block_start' || event['type'] === 'content_block_delta') {
      const block = asObject(event['content_block']) ?? asObject(event['delta'])
      if (block) this.anthropicBlock(block, event['index'])
      return
    }
    if (event['type'] === 'message_delta') {
      this.usage(event['usage'])
      return
    }
    // OpenAI Responses: a whole response, or the stream's events.
    const response = event['object'] === 'response' ? event : asObject(event['response'])
    if (response) {
      if (Array.isArray(response['output'])) {
        response['output'].forEach((item, index) => {
          const parsed = asObject(item)
          if (parsed) this.responsesItem(parsed, `output:${index}`)
        })
      }
      this.usage(response['usage'])
      return
    }
    if (event['type'] === 'response.output_text.delta' && hasText(event['delta'])) this.text = true
    if (event['type'] === 'response.output_item.added' || event['type'] === 'response.output_item.done') {
      const item = asObject(event['item'])
      if (!item) return
      const index = event['output_index']
      const id = [item['call_id'], item['id']].find((value) => typeof value === 'string' && value.length > 0)
      this.responsesItem(item, typeof index === 'number' ? `output:${index}` : `item:${String(id ?? this.calls.size)}`)
    }
  }
}

/**
 * The facts of one successful answer, or null when the body is too large or
 * holds nothing this reader recognises. `protocol` is the seller's: it picks
 * where the usage itemises reasoning, so another API's field is never read.
 */
export function replyFacts(contentType: string | undefined, body: Uint8Array, protocol: string | null): ReplyFacts | null {
  // Only a chat answer is a reply: an image, speech or decision answer has no text or tool calls to count.
  const reasoningField = protocol ? REASONING_TOKEN_FIELDS[protocol] : undefined
  if (!reasoningField) return null
  const reader = new ReplyReader(reasoningField)
  let recognised = false
  visitBodyEvents(contentType, body, (event) => {
    recognised = true
    reader.feed(event)
  })
  return recognised ? { toolCalls: reader.toolCalls, hasText: reader.text, reasoningTokens: reader.reasoningTokens } : null
}

function parseBody(body: Uint8Array): Json | null {
  if (body.length === 0 || body.length > MAX_BODY_BYTES) return null
  try {
    return asObject(JSON.parse(Buffer.from(body).toString('utf8')))
  } catch {
    return null
  }
}

/**
 * The `reasoning` items a Responses client sent back in its request's `input`,
 * each as its reasoning text ('' when it has none the buyer can read, such as
 * another provider's encrypted state). Null when the body is not read: too
 * large, or not JSON. Only counts derived from it leave the process.
 */
export function requestReasoningTexts(body: Uint8Array): string[] | null {
  const parsed = parseBody(body)
  if (!parsed) return null
  const input = parsed['input']
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const entry = asObject(item)
    if (entry?.['type'] !== 'reasoning') return []
    const content = Array.isArray(entry['content']) ? entry['content'] : []
    return [content
      .map((part) => asObject(part))
      .filter((part): part is Json => part?.['type'] === 'reasoning_text' && typeof part['text'] === 'string')
      .map((part) => part['text'] as string)
      .join('')]
  })
}

/**
 * How many of the client's reasoning items (`texts`) went on to the seller in
 * `body`, the request the buyer sent: Responses `reasoning` items as they are,
 * and for a chat seller each item whose text the assistant messages'
 * `reasoning_content` carries (the adapter joins a turn's items into one
 * message, so items are matched by text, not counted by message). Null when
 * the body is not read.
 */
export function reasoningReplayed(texts: readonly string[], body: Uint8Array): number | null {
  const parsed = parseBody(body)
  if (!parsed) return null
  if (Array.isArray(parsed['input'])) {
    return parsed['input'].filter((item) => asObject(item)?.['type'] === 'reasoning').length
  }
  const carried: string[] = []
  let thinkingBlocks = 0
  for (const message of Array.isArray(parsed['messages']) ? parsed['messages'] : []) {
    const entry = asObject(message)
    if (!entry || entry['role'] !== 'assistant') continue
    for (const field of ['reasoning_content', 'reasoning']) {
      if (hasText(entry[field])) carried.push(entry[field] as string)
    }
    if (Array.isArray(entry['content'])) {
      thinkingBlocks += entry['content'].filter((block) => {
        const type = asObject(block)?.['type']
        return type === 'thinking' || type === 'redacted_thinking'
      }).length
    }
  }
  const matched = texts.filter((text) => text.length > 0 && carried.some((sent) => sent.includes(text))).length
  return Math.min(texts.length, matched + thinkingBlocks)
}
