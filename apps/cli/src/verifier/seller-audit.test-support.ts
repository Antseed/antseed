// A mock seller of the tokenizer pre-check behind a fake buyer proxy, and one seller audit over it (`audit`): the
// seller answers every question right and signs the input tokens a test gives it. Test code only, shared by the
// pre-check's tests and the audit pipeline's.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, encodeHttpRequest, encodeHttpResponse, type PeerId, type PeerInfo, type StoredResponseAuth } from '@antseed/node'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import type { AuditCheckId } from './audit-checks.js'
import type { FlipsScreen } from './methods/flips/flips.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import { verifyModelTarget, type ModelVerificationResumeInput, type ModelVerificationTargetResult } from './model-run.js'
import type { OutputCapScreen } from './methods/output-cap/output-cap.js'
import type { OutputEchoScreen } from './methods/output-echo/output-echo.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import {
  TOKENIZER_PRECHECK_RULE,
  createTokenizerPrecheckScreen,
  measureTokenizerReference,
  type TokenizerPrecheckReferenceV1,
  type TokenizerProbeV1,
  type TokenizerReferenceAsk,
} from './methods/tokens/tokenizer-precheck.js'

export const PEER_ID = '11'.repeat(20)
/** Another seller of the model, which counts like the reference. */
export const BACKER_ID = '22'.repeat(20)
export const SERVICE = 'example-model'
export const PROBES: TokenizerProbeV1[] = [
  { a: 'First question, please reply briefly.', b: ' The reference is ZX-48217-QK and I paid 1,249.50 euros on 14 March 2026.' },
  { a: 'Second question, one line is enough.', b: ' Parcel 0049 3021 7785 weighs 12.75 kg and should arrive before 09:30 on Thursday.' },
  { a: 'Third question, keep it short.', b: ' Invoice INV-900317 for 3,407.18 dollars is still open, budget code 77-1409-XR.' },
]

/** A stand-in tokenizer: one token per `charsPerToken` characters. Different values count the same text differently. */
export const tokenizer = (charsPerToken: number) => (text: string): number => Math.ceil(text.length / charsPerToken)
export const MODEL_TOKENIZER = tokenizer(4)
export const OTHER_TOKENIZER = tokenizer(2.5)

/** The reference endpoint: the model's tokenizer plus the endpoint's own fixed wrapper. */
export const referenceAsk = (count = MODEL_TOKENIZER): TokenizerReferenceAsk => async (contents) => ({
  upstream: { name: 'referenceEndpoint' },
  results: contents.map((content) => ({ inputTokens: 7 + count(content), failure: null })),
})

export async function measuredReference(count = MODEL_TOKENIZER): Promise<TokenizerPrecheckReferenceV1> {
  return measureTokenizerReference({ ask: referenceAsk(count), probes: PROBES })
}

/** The request bytes a seller signs: the body it was sent, as the buyer proxy encodes it. */
export function signedRequestBase64(requestId: string, body: Uint8Array | undefined): string {
  return Buffer.from(encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: body ?? new Uint8Array() })).toString('base64')
}

/** The part of a ResponseAuth the checks keep and check: who signed it, for which request and which service. */
export function signedRecord(input: { requestId: string; sellerPeerId: string; advertisedService: string }) {
  return { requestId: input.requestId, sellerPeerId: input.sellerPeerId, advertisedService: input.advertisedService } as unknown as StoredResponseAuth
}

/**
 * A seller behind the buyer proxy. `usage(content, call)` is the input-token count it signs for a request (null
 * signs a response without usage); `status(call)` an HTTP status other than 200.
 */
export function seller(options: {
  usage: (content: string, call: number) => number | null | Record<string, unknown>
  status?: (call: number) => number
  auth?: 'verified' | 'invalid'
  peerId?: string
  /** How long the seller takes to answer a request. */
  delayMs?: number
}) {
  const signed = new Map<string, number | null | Record<string, unknown>>()
  const contents: string[] = []
  const bodies = new Map<string, Uint8Array>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    bodies.set(requestId, init!.body as Uint8Array)
    assert.equal(headers.get('x-antseed-pin-peer'), options.peerId ?? PEER_ID)
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    assert.equal(headers.get('x-antseed-capture-response-auth-preimages'), '1')
    const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as {
      model: string; messages: Array<{ role: string; content: string }>; max_tokens: number; stream: boolean
    }
    assert.deepEqual([body.model, body.max_tokens, body.stream, body.messages.length], [SERVICE, TOKENIZER_PRECHECK_RULE.maxTokens, false, 1])
    const call = contents.push(body.messages[0]!.content)
    const status = options.status?.(call) ?? 200
    if (status !== 200) return new Response('unavailable', { status })
    signed.set(requestId, options.usage(body.messages[0]!.content, call))
    return Response.json({ choices: [{ message: { content: 'ok' } }] }, {
      headers: {
        'x-antseed-request-id': requestId,
        'x-antseed-input-tokens': '100',
        'x-antseed-output-tokens': '10',
        'x-antseed-total-tokens': '110',
        'x-antseed-input-usd-per-million': '1',
        'x-antseed-output-usd-per-million': '2',
        'x-antseed-estimated-cost-usd': '0.00012',
      },
    })
  }
  const responseAuthReader: ResponseAuthReader = {
    async waitForVerified(input) {
      const tokens = signed.get(input.requestId)
      const body = tokens === null || tokens === undefined
        ? { choices: [{ message: { content: 'ok' } }] }
        : { choices: [{ message: { content: 'ok' } }], usage: typeof tokens === 'number' ? { prompt_tokens: tokens, completion_tokens: 3 } : tokens }
      const valid = options.auth !== 'invalid'
      return {
        requestId: input.requestId,
        status: valid ? 'verified' : 'invalid',
        responseAuth: signedRecord(input),
        signedPreimages: valid ? {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: signedRequestBase64(input.requestId, bodies.get(input.requestId)),
          responseBase64: Buffer.from(encodeHttpResponse({
            requestId: input.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)),
          })).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        } : null,
        failureReason: valid ? null : 'bad signature',
      }
    },
    close() {},
  }
  return { fetchFn, responseAuthReader, contents }
}

export const MODEL = 'example-model'
export const PROBE_COUNT = 40

export function auditedPeer(): PeerInfo {
  return {
    peerId: PEER_ID as PeerId,
    displayName: 'Example Seller',
    lastSeen: Date.now(),
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 7,
    providerPricing: { test: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } },
  }
}

/**
 * Audits a seller that answers every question right and signs `usage` for the pre-check's requests. The model has
 * one other seller, which counts like the reference (`backer: false`: it has none).
 */
export async function audit(options: {
  usage: (content: string) => number | Record<string, unknown>
  precheck?: boolean
  extension?: boolean
  backer?: boolean
  resume?: ModelVerificationResumeInput
  /** The seller refuses its first question batch in a way that skips it: its upstream key is gone. */
  refuseQuestions?: boolean
  lastAuditorAttempt?: boolean
  /** Every question batch fails with a server error: the seller fails its questions. */
  failQuestions?: boolean
  onReference?: () => void
  /** How long the reference measurement takes, and the seller's idle limit. */
  referenceDelayMs?: number
  auditTimeoutMs?: number
  /** How long the other seller takes to answer. */
  backerDelayMs?: number
  /** The audit confirms another auditor's DIFF that these checks flagged. */
  confirming?: AuditCheckId[]
  /** The chain time of the report the confirmation answers. */
  confirmingReportedAt?: number
  /** Called on every question batch the seller is asked (to see the order of the tests). */
  onQuestion?: () => void
  /** Cap and echo screens (stand-ins in `check pipeline` tests below). */
  outputCap?: Pick<OutputCapScreen<KbfReferenceV1>, 'ready' | 'check'>
  outputEcho?: Pick<OutputEchoScreen<KbfReferenceV1>, 'ready' | 'check'>
  flips?: Pick<FlipsScreen<KbfReferenceV1>, 'check'> & Partial<Pick<FlipsScreen<KbfReferenceV1>, 'probing' | 'warm'>>
  /** Writes each checkpoint (a stand-in that fails shows what a failed write stops). */
  writeCheckpoint?: (path: string, value: unknown) => Promise<void>
  /** Thinking discovery already done for sellers in this run. */
  sellerThinking?: Map<string, Promise<unknown>>
  /** The side files the run's test screens wrote beside the model's audits (`ProxyVerificationContext.runFile`). */
  runFiles?: Record<string, unknown>
}) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-tokenizer-precheck-'))
  const target = seller({ usage: options.usage })
  const backer = seller({ usage: MODEL_TOKENIZER, peerId: BACKER_ID, ...(options.backerDelayMs ? { delayMs: options.backerDelayMs } : {}) })
  const pinned = (init?: RequestInit) => (new Headers(init?.headers).get('x-antseed-pin-peer') === BACKER_ID ? backer : target)
  const precheckFetch: typeof fetch = async (url, init) => pinned(init).fetchFn(url, init)
  const responseAuthReader: ResponseAuthReader = {
    waitForVerified: async (input) => (input.sellerPeerId === BACKER_ID ? backer : target).responseAuthReader.waitForVerified(input),
    close() {},
  }
  const questionRequests: string[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as { messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)!.content
    const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
    if (values.length === 0) return precheckFetch(url, init)
    questionRequests.push(prompt)
    options.onQuestion?.()
    if (options.refuseQuestions) return Response.json({ error: { message: 'The API key was deleted' } }, { status: 401 })
    if (options.failQuestions) return Response.json({ error: { message: 'upstream unavailable' } }, { status: 503 })
    return Response.json({ choices: [{ message: { content: values.map((value, index) => `(${index + 1}) ${value}`).join('\n') } }] }, {
      headers: { 'x-antseed-request-id': new Headers(init?.headers).get('x-antseed-request-id')! },
    })
  }
  try {
    const result = await verifyModelTarget({
      context: {
        proxy: { baseUrl: 'http://127.0.0.1:8390', statePath: join(directory, 'buyer.state.json'), pid: process.pid, peers: [auditedPeer()] },
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        auditTimeoutMs: options.auditTimeoutMs ?? 10_000,
        responseAuthReader,
        batchConcurrency: 2,
        batchConcurrencyPromotionLatencyMs: 30_000,
        batchLimiter: new ConcurrencyLimiter(2),
        fetchFn,
        sleepFn: async () => undefined,
        ...(options.outputCap ? { outputCap: options.outputCap } : {}),
        ...(options.outputEcho ? { outputEcho: options.outputEcho } : {}),
        ...(options.flips ? { flips: options.flips } : {}),
        ...(options.writeCheckpoint ? { writeCheckpoint: options.writeCheckpoint } : {}),
        ...(options.runFiles ? { runFile: async (name: string) => options.runFiles![name] ?? null } : {}),
        ...(options.sellerThinking ? { sellerThinking: options.sellerThinking as never } : {}),
        ...(options.precheck === false ? {} : {
          tokenizerPrecheck: createTokenizerPrecheckScreen({
            sellers: [{ peerId: PEER_ID, service: SERVICE }, ...(options.backer === false ? [] : [{ peerId: BACKER_ID, service: SERVICE }])],
            proxyBaseUrl: 'http://127.0.0.1:8390',
            responseAuthReader,
            limiter: new ConcurrencyLimiter(2),
            fetchFn: precheckFetch,
            reference: async () => {
              options.onReference?.()
              if (options.referenceDelayMs) await new Promise((resolve) => setTimeout(resolve, options.referenceDelayMs))
              return measuredReference()
            },
          }),
        }),
      },
      target: auditedPeer(),
      service: SERVICE,
      reference: referenceFixture(MODEL, PROBE_COUNT),
      ...(options.extension ? { extension: true } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.lastAuditorAttempt ? { lastAuditorAttempt: true } : {}),
      ...(options.confirming ? { confirming: { checks: options.confirming, ...(options.confirmingReportedAt !== undefined ? { reportedAt: options.confirmingReportedAt } : {}) } } : {}),
    })
    if (options.refuseQuestions && result.status === 'SKIPPED') return { skipped: result, result: null as never, evidence: null as never, questionRequests, precheckRequests: target.contents, backerRequests: backer.contents }
    assert.notEqual(result.status, 'SKIPPED')
    const audited = result as ModelVerificationTargetResult
    const evidence = JSON.parse(await readFile(audited.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    return { skipped: null, result: audited, evidence, questionRequests, precheckRequests: target.contents, backerRequests: backer.contents }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
