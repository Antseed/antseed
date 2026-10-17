/**
 * Whether a seller's successful-looking answer actually answered.
 *
 * A seller can return 200 with nothing in it: no text, no tool call. For the
 * buyer that is a failed request, and routing must treat it like one. Only
 * shapes this module parses are judged; anything it does not recognise counts
 * as an answer, so an unfamiliar protocol never makes a seller look broken.
 */

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** Accumulates what an answer contained, from a full JSON body or from stream events. */
class AnswerContent {
  recognised = false
  answered = false
  /** The answer stopped at the output cap: emptiness may be the request's max_tokens, not the seller. */
  truncated = false

  /** OpenAI chat completion, or one streamed chunk of it. */
  chatChoice(choice: Json): void {
    this.recognised = true
    for (const part of [asObject(choice['message']), asObject(choice['delta'])]) {
      if (!part) continue
      if (hasText(part['content']) || hasText(part['refusal'])
        || (Array.isArray(part['tool_calls']) && part['tool_calls'].length > 0)) this.answered = true
      if (Array.isArray(part['content']) && part['content'].some((block) => hasText(asObject(block)?.['text']))) this.answered = true
    }
    if (choice['finish_reason'] === 'length') this.truncated = true
  }

  /** Anthropic content block (full message or `content_block_start`/`content_block_delta`). */
  anthropicBlock(block: Json): void {
    this.recognised = true
    const type = block['type']
    if (type === 'tool_use' || type === 'server_tool_use' || type === 'input_json_delta') this.answered = true
    if ((type === 'text' || type === 'text_delta') && hasText(block['text'])) this.answered = true
  }

  /** OpenAI Responses output item. */
  responsesItem(item: Json): void {
    this.recognised = true
    const type = item['type']
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'image_generation_call') this.answered = true
    if (type === 'message' && Array.isArray(item['content'])
      && item['content'].some((part) => hasText(asObject(part)?.['text']) || hasText(asObject(part)?.['refusal']))) this.answered = true
  }

  stopReason(reason: unknown): void {
    if (reason === 'max_tokens' || reason === 'length' || reason === 'max_output_tokens') this.truncated = true
    // A refusal is the model's answer, even when it carries no text.
    if (reason === 'refusal') this.answered = true
  }

  feed(event: Json): void {
    if (Array.isArray(event['choices'])) {
      for (const choice of event['choices']) {
        const parsed = asObject(choice)
        if (parsed) this.chatChoice(parsed)
      }
      return
    }
    // Anthropic: a full message, or stream events.
    if (event['type'] === 'message' && Array.isArray(event['content'])) {
      this.recognised = true
      for (const block of event['content']) {
        const parsed = asObject(block)
        if (parsed) this.anthropicBlock(parsed)
      }
      this.stopReason(event['stop_reason'])
      return
    }
    if (event['type'] === 'content_block_start' || event['type'] === 'content_block_delta') {
      const block = asObject(event['content_block']) ?? asObject(event['delta'])
      if (block) this.anthropicBlock(block)
      return
    }
    if (event['type'] === 'message_delta') {
      this.stopReason(asObject(event['delta'])?.['stop_reason'])
      return
    }
    // OpenAI Responses: a full response, or stream events.
    const response = event['object'] === 'response' ? event : asObject(event['response'])
    if (response && Array.isArray(response['output'])) {
      this.recognised = true
      for (const item of response['output']) {
        const parsed = asObject(item)
        if (parsed) this.responsesItem(parsed)
      }
      this.stopReason(asObject(response['incomplete_details'])?.['reason'])
      return
    }
    if ((event['type'] === 'response.output_text.delta' || event['type'] === 'response.refusal.delta') && hasText(event['delta'])) {
      this.recognised = true
      this.answered = true
    }
    if (event['type'] === 'response.output_item.added' || event['type'] === 'response.output_item.done') {
      const item = asObject(event['item'])
      if (item) this.responsesItem(item)
    }
  }
}

/**
 * True when a 2xx inference response carried no text, no refusal and no tool call. A
 * response cut off at the output cap is not judged: the request's own
 * max_tokens may have caused it.
 */
export function isEmptyAnswer(contentType: string | undefined, body: Uint8Array): boolean {
  if (body.length > 4 * 1024 * 1024) return false
  const content = new AnswerContent()
  const text = Buffer.from(body).toString('utf8')
  if ((contentType ?? '').toLowerCase().includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const event = asObject(JSON.parse(payload))
        if (event) content.feed(event)
      } catch {
        // A partial or non-JSON event: judge on the rest.
      }
    }
  } else {
    try {
      const parsed = asObject(JSON.parse(text))
      if (parsed) content.feed(parsed)
    } catch {
      return false
    }
  }
  return content.recognised && !content.answered && !content.truncated
}

/** Receipt failures that can only be the seller's: the signed response differs from what arrived. */
export function isSellerVerificationFailure(verificationError: string | null | undefined): boolean {
  return verificationError === 'response_hash_mismatch' || verificationError === 'invalid_signature'
}
