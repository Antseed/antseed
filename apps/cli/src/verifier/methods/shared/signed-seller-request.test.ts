import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { ConcurrencyLimiter } from '../../audit-concurrency.js'
import { SIGNED_REQUEST_RETRY_WAIT, askSellerSigned, signedRetryWaitMs, type SignedSellerRequestInput } from './signed-seller-request.js'

const PEER = 'ab'.repeat(32)

/**
 * A seller behind a fake buyer proxy that answers each try with the next of `answers` (a status, and its headers), and
 * signs a 200. A fake clock records every wait between tries and lets `onWait` act during it.
 */
function seller(answers: ReadonlyArray<{ status: number; headers?: Record<string, string>; noRequestId?: true }>, onWait?: (ms: number) => void) {
  const signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  const events: string[] = []
  let call = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const answer = answers[Math.min(call, answers.length - 1)]!
    call += 1
    events.push(`try ${answer.status}`)
    const requestId = new Headers(init?.headers).get('x-antseed-request-id')!
    if (answer.status !== 200) return new Response('busy', { status: answer.status, headers: answer.headers ?? {} })
    const body = JSON.stringify({ object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
    signed.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: init!.body as Uint8Array }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(body) }),
    })
    return new Response(body, { status: 200, headers: answer.noRequestId ? {} : { 'x-antseed-request-id': requestId } })
  }
  const responseAuthReader = {
    async waitForVerified(input: { requestId: string; sellerPeerId: string; advertisedService: string }) {
      const bytes = signed.get(input.requestId)!
      return {
        requestId: input.requestId, status: 'verified' as const, failureReason: null,
        responseAuth: { requestId: input.requestId, sellerPeerId: input.sellerPeerId, advertisedService: input.advertisedService },
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const, signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          requestBase64: Buffer.from(bytes.request).toString('base64'), responseBase64: Buffer.from(bytes.response).toString('base64'),
          responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
        },
      }
    },
    close() {},
  } as unknown as SignedSellerRequestInput['responseAuthReader']
  const input = (extra: Partial<SignedSellerRequestInput> = {}): SignedSellerRequestInput => ({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: PEER, service: 'test-model', responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn,
    // The fake clock: a wait is recorded and ends at once.
    wait: async (ms) => { events.push(`wait ${ms}`); onWait?.(ms) },
    ...extra,
  })
  return { input, events }
}

test('after a 429 the second try waits for the seller\'s Retry-After first', async () => {
  const { input, events } = seller([{ status: 429, headers: { 'retry-after': '3' } }, { status: 200 }])
  const record = await askSellerSigned(input(), { messages: [] })
  assert.deepEqual(events, ['try 429', 'wait 3000', 'try 200'])
  assert.equal(record.failureReason, null)
  assert.equal(record.requestIds.length, 2)
})

test('after a 5xx without Retry-After the second try waits the short default', async () => {
  const { input, events } = seller([{ status: 503 }, { status: 200 }])
  await askSellerSigned(input(), { messages: [] })
  assert.deepEqual(events, ['try 503', `wait ${SIGNED_REQUEST_RETRY_WAIT.defaultMs}`, 'try 200'])
})

test('a long Retry-After is capped, and a date is read as the time until it', () => {
  assert.equal(signedRetryWaitMs('120'), SIGNED_REQUEST_RETRY_WAIT.maxMs)
  assert.equal(signedRetryWaitMs('0.5'), 500)
  assert.equal(signedRetryWaitMs('0'), 0)
  assert.equal(signedRetryWaitMs(new Date(10_000 + 4_000).toUTCString(), 10_000), 4_000)
  assert.equal(signedRetryWaitMs('soon'), SIGNED_REQUEST_RETRY_WAIT.defaultMs)
  assert.equal(signedRetryWaitMs(null), SIGNED_REQUEST_RETRY_WAIT.defaultMs)
})

test('a refusal (any other 4xx) is not asked again and not waited for', async () => {
  const { input, events } = seller([{ status: 400 }, { status: 200 }])
  const record = await askSellerSigned(input(), { messages: [] })
  assert.deepEqual(events, ['try 400'])
  assert.match(record.failureReason ?? '', /HTTP 400/)
})

test('an answer without this request\'s ID is asked again at once: only a 429 or a 5xx is waited for', async () => {
  const { input, events } = seller([{ status: 200, noRequestId: true }, { status: 200 }])
  await askSellerSigned(input(), { messages: [] })
  assert.deepEqual(events, ['try 200', 'try 200'])
})

test('the wait ends with the audit\'s stop signal, and no try starts after it', async () => {
  const stop = new AbortController()
  const { input, events } = seller([{ status: 503, headers: { 'retry-after': '9' } }, { status: 200 }], () => stop.abort())
  const record = await askSellerSigned(input({ signal: stop.signal }), { messages: [] })
  assert.deepEqual(events, ['try 503', 'wait 9000'])
  assert.equal(record.failureReason, 'the audit was stopped')
  assert.equal(record.requestIds.length, 1)
})

test('the wait ends with the seller\'s clock too, and it is off that clock', async () => {
  const clock = new AbortController()
  let out = 0
  let outDuringWait: number | null = null
  const sellerClock = { signal: clock.signal, start: () => { out += 1; return clock.signal }, finish: () => { out -= 1 } }
  const { input, events } = seller([{ status: 429 }, { status: 200 }], () => { outDuringWait = out; clock.abort() })
  const record = await askSellerSigned(input({ clock: sellerClock }), { messages: [] })
  assert.equal(outDuringWait, 0, 'no request is out while the auditor waits, so the seller\'s clock does not run')
  assert.deepEqual(events, ['try 429', `wait ${SIGNED_REQUEST_RETRY_WAIT.defaultMs}`])
  assert.match(record.failureReason ?? '', /HTTP 429/)
})

test('without a fake clock the default wait is a real timer that the stop signal cuts short', async () => {
  const stop = new AbortController()
  const { input } = seller([{ status: 503, headers: { 'retry-after': '9' } }, { status: 200 }])
  const started = Date.now()
  setTimeout(() => stop.abort(), 50)
  const { wait: _fake, ...real } = input({ signal: stop.signal })
  const record = await askSellerSigned(real, { messages: [] })
  assert.ok(Date.now() - started < 5_000)
  assert.equal(record.failureReason, 'the audit was stopped')
})
