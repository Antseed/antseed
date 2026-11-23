import { usageForBilling } from '@antseed/node'

/**
 * The reading of one request and answer for the output-token checks (`output-cap.ts`, `output-echo.ts`):
 * what the request capped the reply at, what the answer bills as output exactly as the buyer bills it,
 * what it itemises as reasoning, and the visible answer. One pure function, so the auditor that asked,
 * `verifier submit` and anyone holding the signed bytes read the same numbers.
 *
 * Never a flag on its own: the checks decide from it.
 */
export interface OutputReadingV1 {
  /** The one reply limit of the request (`max_tokens`, `max_completion_tokens`, `max_output_tokens`); null when absent or when two disagree. */
  cap: number | null
  /** The request asks for one answer (`n` absent or 1). */
  oneAnswer: boolean
  /** The request sets stop sequences. */
  stops: boolean
  /**
   * The output tokens as the buyer bills them (`usageForBilling`). Null when the answer has no reading
   * (not one JSON object, an error sent with 200, an unknown shape).
   */
  billedOutputTokens: number | null
  /** The answer signed no usage, so the buyer billed its own estimate of the text: nothing is decided on it. */
  estimated: boolean
  /** The itemised reasoning count; null when the answer itemises none. */
  reasoningTokens: number | null
  /** The answer shows reasoning in any form: an itemised count above zero, reasoning text, a signature or details, a thinking block, a reasoning item. */
  reasoningMarker: boolean
  /** The visible answer; null for a shape this reader does not know, or more than one answer. */
  text: string | null
  /** The model stopped on its own, not on the limit or a filter. */
  finished: boolean
  /** The API shape the answer was read as. */
  shape: 'chat' | 'messages' | 'responses' | null
}

const NO_READING: Omit<OutputReadingV1, 'cap' | 'oneAnswer' | 'stops'> = Object.freeze({
  billedOutputTokens: null, estimated: false, reasoningTokens: null, reasoningMarker: false, text: null, finished: false, shape: null,
})

/** Reads one request body and the answer to it. `statusCode` other than 200 has no reading. */
export function readOutput(requestBody: Uint8Array, response: { statusCode: number; body: Uint8Array }): OutputReadingV1 {
  const request = parseObject(requestBody)
  const head = {
    cap: requestCap(request),
    oneAnswer: request !== null && (request['n'] === undefined || request['n'] === null || request['n'] === 1),
    stops: request !== null && hasStops(request['stop'] ?? request['stop_sequences']),
  }
  if (response.statusCode !== 200) return { ...head, ...NO_READING }
  const answer = parseObject(response.body)
  if (!answer) return { ...head, ...NO_READING }
  const read = readAnswer(answer)
  if (!read) return { ...head, ...NO_READING }
  // A count the seller did not sign is no count: usage with input only is billed as no output by the buyer.
  if (!signsOutputCount(answer['usage'])) return { ...head, ...NO_READING }
  const billed = usageForBilling(requestBody, response)
  const reasoningTokens = itemisedReasoning(answer['usage'])
  // A reasoning count that is not a whole number, negative or above the billed output is malformed usage: no reading.
  if (reasoningTokens !== null && (!Number.isInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > billed.usage.outputTokens)) {
    return { ...head, ...NO_READING }
  }
  return {
    ...head,
    billedOutputTokens: billed.usage.outputTokens,
    estimated: billed.estimated,
    reasoningTokens,
    reasoningMarker: read.reasoningMarker || (reasoningTokens !== null && reasoningTokens > 0),
    text: read.text,
    finished: read.finished,
    shape: read.shape,
  }
}

/**
 * The text of one answer as the randomness check reads it, independent of billing: an answer without usage is still
 * read. Tells "empty or filtered" from "no content": Chat `content: null` is empty only when the reply was filtered,
 * and a Responses message of refusal parts only is a filtered reply. `text` is null when the answer has no readable
 * text; `filtered` when it was refused.
 */
export function readAnswerText(responseBody: Uint8Array): {
  text: string | null
  filtered: boolean
  reasoningMarker: boolean
  reasoningTokens: number
  shape: OutputReadingV1['shape']
} | null {
  const answer = parseObject(responseBody)
  if (!answer) return null
  const read = readAnswer(answer)
  const counted = itemisedReasoning(answer['usage'])
  // A count is a whole number within what one reply can hold; a larger one shows reasoning but counts no tokens, so no
  // sum over replies can overflow.
  const plausible = counted !== null && Number.isSafeInteger(counted) && counted > 0 && counted <= MAX_REASONING_TOKENS_PER_REPLY
  const reasoningTokens = plausible ? counted : 0
  const oversized = counted !== null && counted > 0 && !plausible
  const choice = Array.isArray(answer['choices']) && isRecord(answer['choices'][0]) ? answer['choices'][0] : null
  if (read && read.shape === 'chat' && choice && isRecord(choice['message']) && choice['message']['content'] === null) {
    const filtered = choice['finish_reason'] === 'content_filter'
    return { text: filtered ? '' : null, filtered, reasoningMarker: read.reasoningMarker || reasoningTokens > 0 || oversized, reasoningTokens, shape: 'chat' }
  }
  if (answer['object'] === 'response' && Array.isArray(answer['output']) && answer['error'] == null) {
    const messages = (answer['output'] as unknown[]).filter((item): item is Record<string, unknown> => isRecord(item) && item['type'] === 'message')
    const parts = messages.length === 1 && Array.isArray(messages[0]!['content']) ? messages[0]!['content'] as unknown[] : null
    if (parts && parts.length > 0 && parts.every((part) => isRecord(part) && part['type'] === 'refusal')) {
      const reasoningMarker = (answer['output'] as unknown[]).some((item) => isRecord(item) && item['type'] === 'reasoning') || reasoningTokens > 0 || oversized
      return { text: '', filtered: true, reasoningMarker, reasoningTokens, shape: 'responses' }
    }
  }
  if (!read) return null
  // A Responses reply with no message has no text: no reply, not an empty one; unless it says it was filtered.
  if (read.shape === 'responses' && !(answer['output'] as unknown[]).some((item) => isRecord(item) && item['type'] === 'message')) {
    const filtered = isRecord(answer['incomplete_details']) && answer['incomplete_details']['reason'] === 'content_filter'
    return { text: filtered ? '' : null, filtered, reasoningMarker: read.reasoningMarker || reasoningTokens > 0 || oversized, reasoningTokens, shape: 'responses' }
  }
  const filtered = read.shape === 'messages' ? answer['stop_reason'] === 'refusal'
    : read.shape === 'chat' ? choice?.['finish_reason'] === 'content_filter'
      : isRecord(answer['incomplete_details']) && answer['incomplete_details']['reason'] === 'content_filter'
  return { text: read.text, filtered, reasoningMarker: read.reasoningMarker || reasoningTokens > 0 || oversized, reasoningTokens, shape: read.shape }
}

/** The most reasoning tokens one reply is taken to itemise: far above any reply limit an audit sets. */
const MAX_REASONING_TOKENS_PER_REPLY = 1_000_000

function readAnswer(answer: Record<string, unknown>): { text: string | null; finished: boolean; reasoningMarker: boolean; shape: OutputReadingV1['shape'] } | null {
  const choices = answer['choices']
  const hasError = answer['error'] !== undefined && answer['error'] !== null
  // An error sent with status 200 has no reading, whatever else it carries.
  if (hasError) return null
  if (Array.isArray(choices)) {
    // One answer only: several choices are not one reply, whatever the request asked.
    if (choices.length !== 1) return null
    const first = choices[0]
    if (!isRecord(first)) return null
    const message = isRecord(first['message']) ? first['message'] : null
    if (!message) return null
    const content = message['content']
    const text = typeof content === 'string' ? content
        : Array.isArray(content) ? textParts(content, ['text', 'output_text']) : content === null ? '' : null
    const reasoningMarker = ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking'].some((key) => present(message[key]))
      || (Array.isArray(content) && content.some((part) => isRecord(part) && (part['type'] === 'thinking' || part['type'] === 'reasoning')))
    return { text, finished: first['finish_reason'] === 'stop', reasoningMarker, shape: 'chat' }
  }
  if (answer['type'] === 'message' && Array.isArray(answer['content'])) {
    const blocks = answer['content'] as unknown[]
    const reasoningMarker = blocks.some((block) => isRecord(block) && (block['type'] === 'thinking' || block['type'] === 'redacted_thinking'))
    return { text: textParts(blocks, ['text']), finished: answer['stop_reason'] === 'end_turn', reasoningMarker, shape: 'messages' }
  }
  if (answer['object'] === 'response' && Array.isArray(answer['output'])) {
    const items = answer['output'] as unknown[]
    const messages = items.filter((item): item is Record<string, unknown> => isRecord(item) && item['type'] === 'message')
    const reasoningMarker = items.some((item) => isRecord(item) && item['type'] === 'reasoning')
    const text = messages.length !== 1 || !Array.isArray(messages[0]!['content'])
      ? (messages.length === 0 ? '' : null)
      : textParts(messages[0]!['content'] as unknown[], ['output_text'])
    return { text, finished: answer['status'] === 'completed', reasoningMarker, shape: 'responses' }
  }
  return null
}

/** The joined text of the parts of the given types; null when a part of another type is in it. */
function textParts(parts: readonly unknown[], types: readonly string[]): string | null {
  let text = ''
  for (const part of parts) {
    if (!isRecord(part)) return null
    if (part['type'] === 'thinking' || part['type'] === 'redacted_thinking' || part['type'] === 'reasoning') continue
    if (!types.includes(String(part['type'])) || typeof part['text'] !== 'string') return null
    text += part['text']
  }
  return text
}

/** The usage names an output count (`completion_tokens` or `output_tokens`), as a non-negative integer. */
function signsOutputCount(usage: unknown): boolean {
  if (!isRecord(usage)) return false
  // Every output count present must be a non-negative integer, whichever one billing then takes.
  const present = ['completion_tokens', 'output_tokens'].filter((key) => usage[key] !== undefined && usage[key] !== null)
  return present.length > 0 && present.every((key) => Number.isInteger(usage[key]) && (usage[key] as number) >= 0)
}

/** The texts of the user turns of a request, in each API shape the buyer proxy translates to. */
function userTexts(body: Record<string, unknown> | null): string[] {
  if (!body) return []
  const textsOf = (content: unknown): string[] => {
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []
    return content.flatMap((part) => (isRecord(part) && typeof part['text'] === 'string'
      && (part['type'] === 'text' || part['type'] === 'input_text') ? [part['text']] : []))
  }
  const turns = (value: unknown): string[] => (Array.isArray(value) ? value : []).flatMap((turn) => (
    isRecord(turn) && turn['role'] === 'user' ? textsOf(turn['content']) : []
  ))
  // Chat Completions and Messages: `messages`; Responses: `input`, a string or a list of turns.
  return [...turns(body['messages']), ...(typeof body['input'] === 'string' ? [body['input']] : turns(body['input']))]
}

/**
 * Whether the request the seller signed asks `prompt` in a user turn, in any API shape the buyer proxy translates
 * to (a Chat message's content, a Messages text block, a Responses input): the check that the seller was asked what
 * the record says it was asked.
 */
export function requestCarriesPrompt(requestBody: Uint8Array, prompt: string): boolean {
  return userTexts(parseObject(requestBody)).includes(prompt)
}

/** The reasoning count in `completion_tokens_details` or `output_tokens_details`; null when neither has one. */
function itemisedReasoning(usage: unknown): number | null {
  if (!isRecord(usage)) return null
  for (const key of ['completion_tokens_details', 'output_tokens_details']) {
    const details = usage[key]
    if (isRecord(details) && typeof details['reasoning_tokens'] === 'number') {
      return details['reasoning_tokens']
    }
  }
  return null
}

function requestCap(request: Record<string, unknown> | null): number | null {
  if (!request) return null
  const caps = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
    .map((key) => request[key])
    .filter((value) => value !== undefined && value !== null)
  if (caps.length === 0 || !caps.every((value) => typeof value === 'number' && Number.isInteger(value) && value > 0)) return null
  return caps.every((value) => value === caps[0]) ? caps[0] as number : null
}

function hasStops(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  return Array.isArray(value) && value.length > 0
}

function present(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return isRecord(value)
}

/** One JSON object and nothing else, in strict UTF-8: a stream, a cut body or text after the object has no reading. */
export function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A seller's thinking suppression (overrides and an assistant prefill), as for its questions. */
export interface OutputRequestThinking {
  overrides?: Record<string, unknown>
  assistantPrefill?: string
}

/**
 * The request of an output-token check: one user message, with the seller's thinking suppression as for its
 * questions. The check's own reply limit is set after the overrides, so no override changes it.
 */
export function outputCheckRequestBody(input: {
  service: string
  content: string
  maxTokens: number
  thinking?: OutputRequestThinking | null
}): Record<string, unknown> {
  return {
    model: input.service,
    messages: [
      { role: 'user', content: input.content },
      ...(input.thinking?.assistantPrefill ? [{ role: 'assistant', content: input.thinking.assistantPrefill }] : []),
    ],
    ...input.thinking?.overrides,
    max_tokens: input.maxTokens,
    stream: false,
  }
}
