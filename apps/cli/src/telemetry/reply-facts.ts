/**
 * What a seller's successful answer held, for telemetry only (never used to
 * route or change a response): how many tool calls, whether it had text, and
 * the reasoning tokens its usage itemised. Read from the seller's own body, a
 * whole JSON answer or its event stream, in the seller's protocol. Only the
 * counts leave this module; the text is never kept.
 */

type Json = Record<string, unknown>

const MAX_BODY_BYTES = 4 * 1024 * 1024

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

  private responsesItem(item: Json, fallbackKey: string): void {
    const type = item['type']
    if (type === 'function_call' || type === 'custom_tool_call') {
      const key = [item['call_id'], item['id']].find((value) => typeof value === 'string' && value.length > 0)
      this.calls.add(`item:${key ?? fallbackKey}`)
    }
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
      if (item) this.responsesItem(item, `output:${String(event['output_index'] ?? this.calls.size)}`)
    }
  }
}

/**
 * The facts of one successful answer, or null when the body is too large or
 * holds nothing this reader recognises. `protocol` is the seller's: it picks
 * where the usage itemises reasoning, so another API's field is never read.
 */
export function replyFacts(contentType: string | undefined, body: Uint8Array, protocol: string | null): ReplyFacts | null {
  if (body.length === 0 || body.length > MAX_BODY_BYTES) return null
  const reader = new ReplyReader(protocol ? REASONING_TOKEN_FIELDS[protocol] ?? null : null)
  const text = Buffer.from(body).toString('utf8')
  let recognised = false
  const feed = (payload: string): void => {
    try {
      const event = asObject(JSON.parse(payload))
      if (!event) return
      recognised = true
      reader.feed(event)
    } catch {
      // A partial or non-JSON event: read the rest.
    }
  }
  if ((contentType ?? '').toLowerCase().includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload && payload !== '[DONE]') feed(payload)
    }
  } else {
    feed(text)
  }
  return recognised ? { toolCalls: reader.toolCalls, hasText: reader.text, reasoningTokens: reader.reasoningTokens } : null
}

function parseBody(body: Uint8Array): Json | null {
  if (body.length === 0 || body.length > 16 * MAX_BODY_BYTES) return null
  try {
    return asObject(JSON.parse(Buffer.from(body).toString('utf8')))
  } catch {
    return null
  }
}

/** Reasoning items a Responses client sent back in its request's `input`. */
export function reasoningItemsInRequest(body: Uint8Array): number {
  const input = parseBody(body)?.['input']
  return Array.isArray(input) ? input.filter((item) => asObject(item)?.['type'] === 'reasoning').length : 0
}

/**
 * Earlier reasoning the request carries on to its seller, in the seller's API:
 * Responses `reasoning` items, chat assistant messages with `reasoning_content`
 * (or `reasoning`), and Anthropic `thinking` blocks.
 */
export function reasoningSentToSeller(body: Uint8Array): number {
  const parsed = parseBody(body)
  if (!parsed) return 0
  let count = 0
  if (Array.isArray(parsed['input'])) {
    count += parsed['input'].filter((item) => asObject(item)?.['type'] === 'reasoning').length
  }
  if (Array.isArray(parsed['messages'])) {
    for (const message of parsed['messages']) {
      const entry = asObject(message)
      if (!entry || entry['role'] !== 'assistant') continue
      if (hasText(entry['reasoning_content']) || hasText(entry['reasoning'])) count += 1
      if (Array.isArray(entry['content'])) {
        count += entry['content'].filter((block) => {
          const type = asObject(block)?.['type']
          return type === 'thinking' || type === 'redacted_thinking'
        }).length
      }
    }
  }
  return count
}
