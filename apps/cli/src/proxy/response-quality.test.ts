import assert from 'node:assert/strict'
import test from 'node:test'
import { isEmptyAnswer } from './response-quality.js'

const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value))
const sse = (...events: unknown[]): Uint8Array => Buffer.from(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
const JSON_TYPE = 'application/json'
const SSE_TYPE = 'text/event-stream'

test('OpenAI chat: empty content with no tool call is empty; text or a tool call is an answer', () => {
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] })), true)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ choices: [{ message: { content: null, reasoning_content: 'thinking' }, finish_reason: 'stop' }] })), true)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })), false)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ choices: [{ message: { content: null, tool_calls: [{ id: 't' }] } }] })), false)
})

test('an answer cut off at the output cap is not judged', () => {
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })), false)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ type: 'message', content: [], stop_reason: 'max_tokens' })), false)
})

test('OpenAI chat streams: judged across all chunks', () => {
  assert.equal(isEmptyAnswer(SSE_TYPE, sse({ choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]')), true)
  assert.equal(isEmptyAnswer(SSE_TYPE, sse({ choices: [{ delta: { content: '' } }] }, { choices: [{ delta: { content: 'hi' } }] }, '[DONE]')), false)
  assert.equal(isEmptyAnswer(SSE_TYPE, sse({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })), false)
})

test('Anthropic messages and streams', () => {
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ type: 'message', content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' })), true)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ type: 'message', content: [{ type: 'tool_use', id: 'x' }], stop_reason: 'tool_use' })), false)
  assert.equal(isEmptyAnswer(SSE_TYPE, sse({ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })), false)
  assert.equal(isEmptyAnswer(SSE_TYPE, sse({ type: 'message_start' }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } })), false, 'unrecognised: no content events at all')
})

test('OpenAI Responses', () => {
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ object: 'response', output: [{ type: 'reasoning' }] })), true)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] })), false)
})

test('unrecognised or unparseable bodies count as answers', () => {
  assert.equal(isEmptyAnswer(JSON_TYPE, Buffer.from('not json')), false)
  assert.equal(isEmptyAnswer(JSON_TYPE, json({ data: [{ b64_json: 'x' }] })), false)
  assert.equal(isEmptyAnswer('video/mp4', Buffer.from([0, 1, 2])), false)
})
