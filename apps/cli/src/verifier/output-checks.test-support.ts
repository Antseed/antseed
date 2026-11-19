// Mock sellers for the cap and echo checks: they answer through a fake buyer proxy and sign what they bill, so the
// records they make pass the recheck submit makes. Test code only, shared by the check tests and the whole-epoch test.
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { prepareOutputCapReference, runOutputCap, type CapReferenceReply } from './output-cap.js'
import { createOutputEchoScreen, outputEchoPrompt, type EchoReferenceAsk } from './output-echo.js'
import type { TokenizerReferenceAsk } from './tokenizer-precheck.js'

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))

/** The service the mock sellers' replies are signed for. */
export const SERVICE = 'test-model'
const PEER = 'ab'.repeat(32)
/** The echo tests' sellers, the first audited and the rest the model's crowd. */
export const PEERS = ['aa', 'bb', 'cc', 'dd'].map((letter) => letter.repeat(32))
/** The model's tokenizer in these tests: one token per three characters. */
export const tokens = (text: string): number => Math.ceil(text.length / 3)

/** A seller that answers `answer(cap, call)` with what it signs; every request is captured. */
export function fakeCapSeller(answer: (cap: number, call: number) => { text: string; billed: number; reasoning?: number }) {
  const bodies: Array<Record<string, unknown>> = []
  const signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    const raw = init!.body as Uint8Array
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
    const call = bodies.push(body)
    const { text, billed, reasoning } = answer(body['max_tokens'] as number, call)
    const reply = {
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'length' }],
      usage: { prompt_tokens: 30, completion_tokens: billed, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
    }
    signed.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: raw }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: bytes(reply) }),
    })
    return Response.json(reply, { headers: { 'x-antseed-request-id': requestId } })
  }
  const responseAuthReader = {
    async waitForVerified(input: { requestId: string; sellerPeerId: string; advertisedService: string }) {
      const bytesOf = signed.get(input.requestId)!
      return {
        requestId: input.requestId,
        status: 'verified' as const,
        // What a seller signs: who, for which request, for which service.
        responseAuth: { requestId: input.requestId, sellerPeerId: input.sellerPeerId, advertisedService: input.advertisedService },
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const,
          signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          requestBase64: Buffer.from(bytesOf.request).toString('base64'),
          responseBase64: Buffer.from(bytesOf.response).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        },
        failureReason: null,
      }
    },
    close() {},
  } as unknown as Parameters<typeof runOutputCap>[0]['responseAuthReader']
  return { fetchFn, responseAuthReader, bodies }
}

/** The model's own host keeps the limit: it answers `cap` words and bills `cap`. */
export const keptReply: CapReferenceReply = async (prompt, cap) => ({
  requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
  response: { statusCode: 200, body: bytes({ choices: [{ message: { content: Array.from({ length: cap }, () => 'one').join(' ') }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: cap } }) },
})

/** A reference that counts one token per word, from one provider, never cached: A + B minus A is B's word count. */
export const wordReference: TokenizerReferenceAsk = async (contents) => ({
  upstream: { kind: 'test' },
  results: contents.map((content) => ({ inputTokens: 10 + content.trim().split(/\s+/).length, cachedInput: false, provider: 'maker', failure: null })),
})

export const runCapOn = async (seller: ReturnType<typeof fakeCapSeller>, ask: TokenizerReferenceAsk = wordReference, peerId = PEER) => {
  const reference = await prepareOutputCapReference({ askReply: keptReply, ask })
  return runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId, service: SERVICE,
    responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn,
    reference, ask, thinking: null,
  })
}

/** Sellers that echo each text and sign `billed(text)` output tokens; every request is captured per peer. */
export function fakeEchoNetwork(billing: Record<string, (text: string) => number>) {
  const signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  const asked = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    const peer = headers.get('x-antseed-pin-peer')!
    asked.set(peer, (asked.get(peer) ?? 0) + 1)
    const raw = init!.body as Uint8Array
    const body = JSON.parse(new TextDecoder().decode(raw)) as { messages: Array<{ content: string }> }
    const text = body.messages[0]!.content.split('\n\n').slice(1).join('\n\n')
    const reply = {
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: billing[peer]!(text) },
    }
    signed.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: raw }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(reply)) }),
    })
    return Response.json(reply, { headers: { 'x-antseed-request-id': requestId } })
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
  } as unknown as Parameters<typeof createOutputEchoScreen>[0]['responseAuthReader']
  return { fetchFn, responseAuthReader, asked }
}

/** The reference echoes every text exactly and counts it with the model's tokenizer. */
export const echoReference: EchoReferenceAsk = async (texts) => ({
  upstream: { kind: 'test' },
  results: texts.map((text) => ({
    requestBody: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: outputEchoPrompt(text) }], max_tokens: 1024 })),
    response: {
      statusCode: 200,
      body: new TextEncoder().encode(JSON.stringify({
        object: 'chat.completion', provider: 'maker',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: tokens(text) },
      })),
    },
    provider: 'maker',
    failure: null,
  })),
})

export const echoScreenFor = (network: ReturnType<typeof fakeEchoNetwork>, ask: EchoReferenceAsk = echoReference, peers: readonly string[] = PEERS) => createOutputEchoScreen<null>({
  sellers: peers.map((peerId) => ({ peerId, service: SERVICE })),
  proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: network.responseAuthReader, limiter: new ConcurrencyLimiter(4),
  fetchFn: network.fetchFn, ask: () => ask,
})

