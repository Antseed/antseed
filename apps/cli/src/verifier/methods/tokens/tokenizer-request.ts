import { isRecord, parseObject } from '../shared/output-usage.js'

/**
 * The top-level members a tokenizer request may carry: what the pre-check sends and what the buyer proxy writes when it
 * translates that request to Chat Completions, Messages or Responses (`@antseed/api-adapter`), none of which adds input
 * the model counts. Any other member (a system prompt, tools, a response schema, a stored prompt, an earlier response
 * it continues, MCP servers, ...) may, so a request that holds one is not the round's text alone.
 */
const TOKENIZER_REQUEST_MEMBERS: ReadonlySet<string> = new Set([
  'model', 'messages', 'input', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
  'temperature', 'top_p', 'stop', 'stop_sequences', 'reasoning', 'reasoning_effort', 'metadata', 'user', 'prompt_cache_key',
])
/** Members of the one turn: its role, its type (Responses), and its content. A `name` is input too. */
const TOKENIZER_TURN_MEMBERS: ReadonlySet<string> = new Set(['role', 'type', 'content'])
/** Members of the one text part: a cache breakpoint the proxy adds to Messages counts nothing. */
const TOKENIZER_PART_MEMBERS: ReadonlySet<string> = new Set(['type', 'text', 'cache_control'])

/**
 * Whether the request the seller signed asks `prompt` and nothing else, in any API shape the buyer proxy translates to:
 * only known members (`TOKENIZER_REQUEST_MEMBERS`), exactly one turn, the user's, whose content is `prompt` as a string
 * or as one text part. The tokenizer pre-check's binding of a signed count to the text it counts: a count signed for
 * more input than that text is not it.
 */
export function requestAsksOnly(requestBody: Uint8Array, prompt: string): boolean {
  const body = parseObject(requestBody)
  if (!body || Object.keys(body).some((key) => !TOKENIZER_REQUEST_MEMBERS.has(key))) return false
  // Chat Completions and Messages: `messages`; Responses: `input`, a string or a list of turns. Never both.
  if (body['messages'] !== undefined && body['input'] !== undefined) return false
  if (typeof body['input'] === 'string') return body['input'] === prompt
  const turns = body['messages'] ?? body['input']
  if (!Array.isArray(turns) || turns.length !== 1) return false
  const turn: unknown = turns[0]
  if (!isRecord(turn) || Object.keys(turn).some((key) => !TOKENIZER_TURN_MEMBERS.has(key))) return false
  if (turn['role'] !== 'user' || (turn['type'] !== undefined && turn['type'] !== 'message')) return false
  const content = turn['content']
  if (typeof content === 'string') return content === prompt
  if (!Array.isArray(content) || content.length !== 1) return false
  const part: unknown = content[0]
  return isRecord(part) && Object.keys(part).every((key) => TOKENIZER_PART_MEMBERS.has(key))
    && (part['type'] === 'text' || part['type'] === 'input_text') && part['text'] === prompt
}
