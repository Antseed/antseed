import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResponseUsageReader } from './response-usage.js'

/** Feeds `body` in chunks of `size` bytes (splitting lines and multi-byte characters). */
function read(contentType: string | undefined, body: string, size = 7) {
  const reader = new ResponseUsageReader(contentType)
  const bytes = Buffer.from(body, 'utf8')
  for (let offset = 0; offset < bytes.length; offset += size) reader.push(bytes.subarray(offset, offset + size))
  return reader.result()
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('')
}

test('OpenAI chat completion JSON: prompt tokens include cached ones', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'héllo — ✓' } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
  })
  assert.deepEqual(read('application/json; charset=utf-8', body), { inputTokens: 120, cachedInputTokens: 100, outputTokens: 30 })
})

test('OpenAI chat completion SSE: the final usage chunk', () => {
  const body = sse([
    { data: { choices: [{ delta: { content: 'hi ✓' } }], usage: null } },
    { data: { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } } } },
    { data: '[DONE]' },
  ])
  assert.deepEqual(read('text/event-stream', body), { inputTokens: 50, cachedInputTokens: 10, outputTokens: 7 })
})

test('OpenAI chat SSE without include_usage reports nothing', () => {
  const body = sse([{ data: { choices: [{ delta: { content: 'hi' } }] } }, { data: '[DONE]' }])
  assert.equal(read('text/event-stream', body), null)
})

test('OpenAI Responses SSE: response.completed', () => {
  const body = sse([
    { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', usage: null } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'usage is "usage"' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 80, output_tokens: 12, input_tokens_details: { cached_tokens: 64 } } } } },
  ])
  assert.deepEqual(read('text/event-stream; charset=utf-8', body), { inputTokens: 80, cachedInputTokens: 64, outputTokens: 12 })
})

test('OpenAI Responses JSON', () => {
  const body = JSON.stringify({ id: 'resp_1', output: [], usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } })
  assert.deepEqual(read('application/json', body), { inputTokens: 9, cachedInputTokens: 0, outputTokens: 3 })
})

test('Anthropic messages SSE: input from message_start, output from the last message_delta', () => {
  const body = sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, cache_read_input_tokens: 200, output_tokens: 1 } } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ünïcode' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
  // Anthropic input_tokens excludes cache reads; the total logical input includes them.
  assert.deepEqual(read('text/event-stream', body, 3), { inputTokens: 205, cachedInputTokens: 200, outputTokens: 42 })
})

test('Anthropic messages JSON', () => {
  const body = JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 11, cache_read_input_tokens: 4, output_tokens: 6 } })
  assert.deepEqual(read('application/json', body), { inputTokens: 15, cachedInputTokens: 4, outputTokens: 6 })
})

test('a body without content type is sniffed', () => {
  assert.deepEqual(read(undefined, JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } })), { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 })
  assert.deepEqual(read(undefined, sse([{ data: { usage: { prompt_tokens: 3, completion_tokens: 4 } } }])), { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 })
})

test('a JSON body too large to keep is read from its tail', () => {
  const big = 'x'.repeat(2 * 1024 * 1024)
  const body = JSON.stringify({ data: [{ b64_json: big, note: '{"usage":{"prompt_tokens":999}}' }], usage: { prompt_tokens: 7, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } } })
  assert.deepEqual(read('application/json', body, 64 * 1024), { inputTokens: 7, cachedInputTokens: 2, outputTokens: 8 })
})

test('an oversized SSE line is skipped and later events still count', () => {
  const body = `data: {"blob":"${'y'.repeat(1_200_000)}"}\n\n${sse([{ data: { usage: { prompt_tokens: 3, completion_tokens: 1 } } }])}`
  assert.deepEqual(read('text/event-stream', body, 100_000), { inputTokens: 3, cachedInputTokens: 0, outputTokens: 1 })
})

test('malformed bodies report nothing', () => {
  assert.equal(read('application/json', '{"usage": {"prompt_tokens": 1'), null)
  assert.equal(read('application/json', '{"choices": []}'), null)
  assert.equal(read('text/event-stream', 'data: {"usage": nope}\n\n'), null)
})
