import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import {
  KBF_PROMPT_VARIANT_IDS,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  getKbfPromptVariant,
  validateKbfReferenceV1,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  createResponseAuthPayload,
  encodeHttpRequest,
  encodeHttpResponse,
  verifyResponseAuth,
  type PeerId,
  type PeerInfo,
  type StoredResponseAuth,
} from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { writeJsonAtomic } from './atomic-files.js'
import {
  classifyVerificationTarget,
  classifyVerificationTargetServices,
  loadBuyerProxySnapshot,
  readModelAuditCheckpoints,
  verifyModelTarget,
  type ModelVerificationResumeInput,
  type ModelVerificationSkip,
} from './model-run.js'
import type { ProxyAuditEvidenceV1, ProxyAuditSkipEvidenceV1 } from './proxy-evidence.js'
import { createResponseAuthReader, type ResponseAuthReader } from './response-auth-reader.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'

function peer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: '11'.repeat(20) as PeerId,
    displayName: 'Test peer',
    lastSeen: Date.now(),
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 7,
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      services: { 'GPT-5.6-SOL': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    } },
    ...overrides,
  }
}

const targetPolicy = {
  minReputation: 0,
  priceCap: {
    model: 'gpt-5.6-sol',
    reference: { inputUsdPerMillion: 5, outputUsdPerMillion: 30 },
    source: 'catalog' as const,
    ratio: 1,
  },
}

function pricedAt(input: number, output: number, cachedInput?: number): PeerInfo {
  return peer({
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      services: { 'GPT-5.6-SOL': {
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
        ...(cachedInput === undefined ? {} : { cachedInputUsdPerMillion: cachedInput }),
      } },
    } },
  })
}

function reference(count: number): KbfReferenceV1 {
  const probes = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index + 1}`,
    name: `test probe ${index + 1}`,
    domain: 'test',
    template: `The test probe ${index + 1} value is ___.`,
    consensus: index + 1,
    range: [0, count + 10] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: 0,
    selfTotal: count,
    probeCount: count,
    minimumMismatchDelta: 0.1,
    alpha: 0.05,
    cpConfidence: 0.99,
  })
  return {
    version: 2,
    kind: 'kbf',
    referenceId: `reference-${count}`,
    referenceModel: 'gpt-5.6-sol',
    serviceAliases: ['gpt-5.6-sol'],
    createdAt: '2026-08-05T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-5.6-sol' }),
    selfTest: {
      hamming: 0,
      total: count,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1] })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: count,
      probeCount: count,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
}

async function runTarget(
  count: number,
  answerMode: 'valid' | 'out-of-range' | 'all-wrong' | 'partial-malformed' | 'malformed'
    | 'malformed-first-batch' | 'empty-responses' | 'content-filter' | 'sse' | 'transport-failure' | 'hanging'
    | 'rate-limited' | 'semantic-unavailable' | 'blank-length'
    | 'persistent-blank-length' | 'checkpoint-abort' | 'sampling-rejected' | 'thinking-rejected'
    | 'sparse-then-better' | 'sparse-best-first' = 'valid',
  transientFailures = 0,
  authMode: 'verified' | 'missing' | 'unverified' | 'wrong-request' | 'wrong-seller' | 'wrong-service' = 'verified',
  includeCost = true,
  auditTimeoutMs = 10_000,
  resume?: ModelVerificationResumeInput,
  checkpointIdentity?: { runId: string; epoch: string; model: string },
  targetReference: KbfReferenceV1 = reference(count),
  persistence: {
    writeCheckpoint?: typeof writeJsonAtomic
    onFailure?: (directory: string, requestCount: number, abortedRequests: number) => Promise<void>
    proxyFailure?: Response | Error
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-target-'))
  let requestCount = 0
  let abortedRequests = 0
  let failureCount = 0
  let changedAnswer = false
  let returnedBlankLength = false
  let firstBatchAttempts = 0
  let slowBatchCompleted = false
  let finalBatchStartedAfterSlow = false
  const requests: Array<{ headers: RequestInit['headers']; body: string }> = []
  const fetchFn: typeof fetch = async (_url, init) => {
    requestCount += 1
    const requestBody = init?.body instanceof Uint8Array
      ? new TextDecoder().decode(init.body)
      : String(init?.body ?? '')
    requests.push({ headers: init?.headers ?? {}, body: requestBody })
    if (persistence.proxyFailure instanceof Error) throw persistence.proxyFailure
    if (persistence.proxyFailure) return persistence.proxyFailure.clone()
    const requestId = new Headers(init?.headers).get('x-antseed-request-id')!
    if (answerMode === 'hanging') {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (answerMode === 'semantic-unavailable') {
      return Response.json({
        error: { message: 'Service is temporarily unavailable. Please try again later.' },
      }, { status: 400 })
    }
    const body = JSON.parse(requestBody) as { messages: Array<{ content: string }>; temperature?: number; top_p?: number }
    if (answerMode === 'sampling-rejected' && ('temperature' in body || 'top_p' in body)) {
      return Response.json({
        error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' },
      }, { status: 400 })
    }
    if (answerMode === 'thinking-rejected' && 'reasoning' in body) {
      return Response.json({ error: { message: 'unsupported chat feature for claude messages: reasoning' } }, { status: 400 })
    }
    const prompt = body.messages.filter((message) => (message as { role?: string }).role !== 'assistant').at(-1)?.content ?? ''
    const firstProbe = Number(prompt.match(/test probe (\d+) value is ___/)?.[1] ?? 0)
    if (answerMode === 'checkpoint-abort' && firstProbe === 21) {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          abortedRequests += 1
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (answerMode === 'rate-limited' && firstProbe === 11) {
      return new Response('max concurrency reached', { status: 429 })
    }
    if (answerMode === 'rate-limited' && firstProbe === 21) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      slowBatchCompleted = true
    }
    if (answerMode === 'rate-limited' && firstProbe === 31) {
      finalBatchStartedAfterSlow = slowBatchCompleted
    }
    if (prompt.includes('test probe 1 value') && failureCount < transientFailures) {
      failureCount += 1
      return new Response('temporarily unavailable', { status: 502 })
    }
    if (answerMode === 'transport-failure') return new Response('unavailable', { status: 502 })
    const values = [...prompt.matchAll(/test probe (\d+) value is ___/g)].map((match) => Number(match[1]))
    // Answers kept per attempt of the batch holding probe 1 (the rest are dropped).
    const sparseKeep = firstProbe === 1 && (answerMode === 'sparse-then-better' || answerMode === 'sparse-best-first')
      ? (answerMode === 'sparse-then-better' ? [3, 8, 10] : [4, 2, 3])[firstBatchAttempts++] ?? 10
      : values.length
    const content = values.slice(0, sparseKeep).map((value, index) => {
      if (answerMode === 'out-of-range' && !changedAnswer) {
        changedAnswer = true
        return `(${index + 1}) ${count + 100}`
      }
      // In range but wrong: an out-of-range answer would be unscored instead.
      if (answerMode === 'all-wrong') return `(${index + 1}) ${(value % count) + 1}`
      if (answerMode === 'partial-malformed' && index > 0) return `(${index + 1}) unknown`
      return `(${index + 1}) ${value}`
    }).join('\n')
    const telemetryHeaders: Record<string, string> = includeCost ? {
      'x-antseed-input-tokens': '100',
      'x-antseed-output-tokens': '20',
      'x-antseed-total-tokens': '120',
      'x-antseed-input-usd-per-million': '1',
      'x-antseed-output-usd-per-million': '2',
      'x-antseed-estimated-cost-usd': '0.00014',
      'x-antseed-token-source': 'usage',
      'x-antseed-provider': 'test',
      'x-antseed-service': 'GPT-5.6-SOL',
    } : {}
    if ((answerMode === 'blank-length' || answerMode === 'persistent-blank-length')
      && prompt.includes('test probe 1 value')
      && (answerMode === 'persistent-blank-length' || !returnedBlankLength)) {
      returnedBlankLength = true
      return Response.json({
        choices: [{ message: { content: null }, finish_reason: 'length' }],
        usage: { completion_tokens: 0 },
      }, {
        headers: { 'x-antseed-request-id': requestId, ...telemetryHeaders },
      })
    }
    if (answerMode === 'sse') {
      return new Response([
        'event: response.output_text.delta',
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}`,
        '',
        'event: response.output_text.done',
        `data: ${JSON.stringify({ type: 'response.output_text.done', text: content })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { headers: {
        'content-type': 'text/event-stream',
        'x-antseed-request-id': requestId,
        ...telemetryHeaders,
      } })
    }
    const responseBody = answerMode === 'malformed' || (answerMode === 'malformed-first-batch' && firstProbe === 1)
      ? { choices: [{ message: {} }] }
      : answerMode === 'empty-responses'
        ? { object: 'response', status: 'completed', output: [] }
        : answerMode === 'content-filter'
          ? { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }
          : { choices: [{ message: { content } }] }
    return Response.json(responseBody, {
      headers: { 'x-antseed-request-id': requestId, ...telemetryHeaders },
    })
  }
  const responseAuthReader: ResponseAuthReader = {
    async waitForVerified(input) {
      if (authMode === 'missing') {
        return {
          requestId: input.requestId, status: 'missing', responseAuth: null, signedPreimages: null,
          failureReason: 'missing',
        }
      }
      const record = {
        version: 1 as const,
        requestId: authMode === 'wrong-request' ? 'wrong-request' : input.requestId,
        buyerPeerId: '22'.repeat(20),
        sellerPeerId: authMode === 'wrong-seller' ? '33'.repeat(20) : input.sellerPeerId,
        advertisedService: authMode === 'wrong-service' ? 'wrong-service' : input.advertisedService,
        provider: 'test',
        statusCode: 200,
        requestHash: `0x${'44'.repeat(32)}`,
        responseHash: `0x${'55'.repeat(32)}`,
        responseStartedAt: Date.now(),
        responseCompletedAt: Date.now(),
        signature: `0x${'66'.repeat(65)}`,
        receivedAt: Date.now(),
        verified: authMode !== 'unverified',
        verificationError: authMode === 'unverified' ? 'bad signature' : null,
        requestPreimage: null,
        responsePreimage: null,
      }
      const valid = authMode === 'verified'
      return {
        requestId: input.requestId,
        status: valid ? 'verified' : 'invalid',
        responseAuth: record,
        signedPreimages: valid ? {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: 'AA==',
          responseBase64: 'AA==',
          responseAuthSigningBase64: 'AA==',
          requestHash: record.requestHash,
          responseHash: record.responseHash,
        } : null,
        failureReason: valid ? null : authMode,
      }
    },
    close() {},
  }
  try {
    const result = await verifyModelTarget({
      context: {
        proxy: {
          baseUrl: 'http://127.0.0.1:8377',
          statePath: join(directory, 'buyer.state.json'),
          pid: process.pid,
          peers: [peer()],
        },
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        auditTimeoutMs,
        responseAuthReader,
        batchConcurrency: 2,
        batchConcurrencyPromotionLatencyMs: 30_000,
        batchLimiter: new ConcurrencyLimiter(2),
        fetchFn,
        sleepFn: async () => undefined,
        ...persistence,
      },
      target: peer(),
      service: 'GPT-5.6-SOL',
      reference: targetReference,
      auditId: resume ? `0x${'88'.repeat(32)}` : undefined,
      resume,
      checkpointIdentity,
    })
    if (result.status === 'SKIPPED') throw new Error(`unexpected skipped target: ${result.reason}`)
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    const checkpoints = await readModelAuditCheckpoints(directory)
    return { result, evidence, checkpoints, requestCount, requests, finalBatchStartedAfterSlow }
  } catch (error) {
    await persistence.onFailure?.(directory, requestCount, abortedRequests)
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('transient audit checkpoint failure retries storage only and retains concurrent completions', async () => {
  let writes = 0
  const run = await runTarget(40, 'valid', 0, 'verified', true, 10_000, undefined, {
    runId: 'checkpoint-test', epoch: '2026-10-06', model: 'gpt-5.6-sol',
  }, reference(40), {
    writeCheckpoint: async (path, value) => {
      writes += 1
      if (writes === 2) throw new Error('temporary checkpoint failure')
      await writeJsonAtomic(path, value)
    },
  })
  assert.equal(writes, 5)
  assert.equal(run.requestCount, 4)
  assert.equal(run.result.status, 'SAME')
  assert.deepEqual(run.checkpoints[0]?.checkpoint.exchanges.map((exchange) => exchange.batchIndex), [0, 1, 2, 3])
})

test('runtime accepts a cryptographically verified enrolled routed alias without redundant requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-runtime-alias-'))
  const seller = new Wallet(`0x${'12'.repeat(32)}`)
  const buyer = new Wallet(`0x${'34'.repeat(32)}`)
  const target = peer({ peerId: seller.address.slice(2).toLowerCase() as PeerId })
  const enrolled = referenceFixture('claude-opus-5.5', 40)
  enrolled.serviceAliases.push('claude-opus-5-5')
  enrolled.referenceId = computeReferenceId(enrolled)
  const reference = validateKbfReferenceV1(enrolled, { minimumStatisticalPower: 1e-9 })
  const records = new Map<string, StoredResponseAuth>()
  let requestCount = 0
  const reader = createResponseAuthReader({
    getResponseAuth: (requestId) => records.get(requestId) ?? null,
  })
  try {
    const result = await verifyModelTarget({
      target,
      service: 'CLAUDE-OPUS-5.5',
      reference,
      context: {
        proxy: { baseUrl: 'http://127.0.0.1:8377', statePath: join(directory, 'buyer.json'), pid: 1, peers: [target] },
        evidenceDir: directory,
        requestTimeoutMs: 1_000,
        auditTimeoutMs: 10_000,
        responseAuthReader: reader,
        batchConcurrency: 2,
        batchConcurrencyPromotionLatencyMs: 30_000,
        batchLimiter: new ConcurrencyLimiter(2),
        sleepFn: async () => undefined,
        fetchFn: async (_url, init) => {
          requestCount += 1
          const requestId = new Headers(init?.headers).get('x-antseed-request-id')!
          const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString()) as { model: string; messages: Array<{ content: string }> }
          const content = [...body.messages.at(-1)!.content.matchAll(/test value (\d+) is ___/g)]
            .map((match, index) => `(${index + 1}) ${match[1]}`).join('\n')
          body.model = 'claude-opus-5-5'
          const headers = { 'content-type': 'application/json' }
          const request = { requestId, method: 'POST', path: '/v1/chat/completions', headers, body: Buffer.from(JSON.stringify(body)) }
          const response = { requestId, statusCode: 200, headers, body: Buffer.from(JSON.stringify({ choices: [{ message: { content } }] })) }
          const expected = { request, response, sellerPeerId: target.peerId, buyerPeerId: buyer.address, advertisedService: body.model }
          const payload = createResponseAuthPayload({ ...expected, provider: 'test', responseStartedAt: 1, responseCompletedAt: 2 }, seller)
          assert.equal(verifyResponseAuth(payload, expected).valid, true)
          records.set(requestId, {
            ...payload, receivedAt: 3, verified: true, verificationError: null,
            requestPreimage: encodeHttpRequest(request), responsePreimage: encodeHttpResponse(response),
          })
          return new Response(response.body, { headers: { ...headers, 'x-antseed-request-id': requestId } })
        },
      },
    })
    assert.equal(result.status, 'SAME')
    assert.equal(requestCount, 4)
    const evidence = JSON.parse(await readFile(result.evidencePath!, 'utf8')) as ProxyAuditEvidenceV1
    for (const exchange of evidence.exchanges) {
      assert.equal(exchange.attemptCount, 1)
      assert.equal(exchange.responseAuth.record?.advertisedService, 'claude-opus-5-5')
    }
  } finally {
    reader.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('persistent audit checkpoint failure stops concurrent work and preserves the durable checkpoint', async () => {
  let writes = 0
  let observedFailure = false
  const cause = new Error('disk full')
  await assert.rejects(runTarget(100, 'valid', 0, 'verified', true, 10_000, undefined, {
    runId: 'checkpoint-test', epoch: '2026-10-06', model: 'gpt-5.6-sol',
  }, reference(100), {
    writeCheckpoint: async (path, value) => {
      writes += 1
      if (writes > 1) throw cause
      await writeJsonAtomic(path, value)
    },
    onFailure: async (directory, requestCount) => {
      observedFailure = true
      assert.equal(requestCount, 3)
      const checkpoints = await readModelAuditCheckpoints(directory)
      assert.equal(checkpoints.length, 1)
      assert.deepEqual(checkpoints[0]?.checkpoint.exchanges.map((exchange) => exchange.batchIndex), [0])
    },
  }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /audit stopped.*checkpoint.*last durable checkpoint/i)
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(observedFailure, true)
  assert.equal(writes, 3)
})

test('persistent checkpoint failure aborts an in-flight request without a paid retry', async () => {
  let writes = 0
  let observedAbort = false
  const startedAt = Date.now()
  await assert.rejects(runTarget(100, 'checkpoint-abort', 0, 'verified', true, 10_000, undefined, {
    runId: 'checkpoint-abort', epoch: '2026-10-06', model: 'gpt-5.6-sol',
  }, reference(100), {
    writeCheckpoint: async (path, value) => {
      writes += 1
      if (writes > 1) throw new Error('disk full')
      await writeJsonAtomic(path, value)
    },
    onFailure: async (directory, requestCount, abortedRequests) => {
      assert.equal(requestCount, 3)
      assert.equal(abortedRequests, 1)
      assert.equal((await readModelAuditCheckpoints(directory))[0]?.checkpoint.exchanges.length, 1)
      observedAbort = true
    },
  }), /audit stopped.*checkpoint/)
  assert.equal(writes, 3)
  assert.equal(observedAbort, true)
  assert.ok(Date.now() - startedAt < 2_000)
})

for (const [name, failure, code, retryable, requestCount] of [
  ['429', Response.json({ error: { message: 'unsupported Chat feature for Claude Messages: n' } }, { status: 429 }), 'rate_limited', true, 5],
  ['500', Response.json({ error: { message: 'unsupported Chat feature for Claude Messages: reasoning' } }, { status: 500 }), 'transport_error', true, 5],
  ['network', new TypeError('fetch failed'), 'transport_error', true, 5],
  ['unrelated 422', Response.json({ error: { message: 'unsupported account feature: n' } }, { status: 422 }), 'transport_error', false, 4],
  ['unobserved parameter', Response.json({ error: { message: 'unsupported Chat feature for Claude Messages: custom' } }, { status: 400 }), 'transport_error', false, 4],
] as const) {
  test(`${name} remains outside the observed unsupported-parameter classification`, async () => {
    const run = await runTarget(40, 'valid', 0, 'verified', true, 10_000, undefined, undefined, reference(40), {
      proxyFailure: failure,
    })
    assert.equal(run.result.status, 'UNDETERMINED')
    assert.equal(run.requestCount, requestCount)
    assert.equal(run.evidence.exchanges[0]?.outcomeReason?.code, code)
    assert.equal(run.evidence.exchanges[0]?.outcomeReason?.retryable, retryable)
  })
}

for (const status of [400, 422]) {
  for (const parameter of ['n', 'reasoning']) {
    test(`unsupported Claude Messages ${parameter} HTTP ${status} skips after one request`, async () => {
      const message = `unsupported Chat feature for Claude Messages: ${parameter}`
      const run = await runSkippedTarget(Response.json({ error: { message } }, { status }))
      assert.equal(run.requestCount, 1)
      assert.equal(run.result.code, 'request_profile_incompatible')
      assert.equal(run.result.outcomeReason?.retryable, false)
      assert.equal(run.result.outcomeReason?.nextAction, 'inspect verifier evidence')
      assert.equal(run.evidence.exchange.attemptCount, 1)
      assert.equal(run.evidence.exchange.outcomeReason?.summary, message)
      assert.ok(run.evidence.exchange.matches.every((match) => match === null))
    })
  }
}

async function runSkippedTarget(response: Response): Promise<{
  result: ModelVerificationSkip
  evidence: ProxyAuditSkipEvidenceV1
  requestCount: number
}> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-skip-'))
  let requestCount = 0
  try {
    const result = await verifyModelTarget({
      context: {
        proxy: {
          baseUrl: 'http://127.0.0.1:8377',
          statePath: join(directory, 'buyer.state.json'),
          pid: process.pid,
          peers: [peer()],
        },
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        auditTimeoutMs: 10_000,
        responseAuthReader: {
          async waitForVerified() { throw new Error('unexpected ResponseAuth wait') },
          close() {},
        },
        batchConcurrency: 2,
        batchConcurrencyPromotionLatencyMs: 30_000,
        batchLimiter: new ConcurrencyLimiter(2),
        fetchFn: async () => {
          requestCount += 1
          return response.clone()
        },
        sleepFn: async () => undefined,
      },
      target: peer(),
      service: 'GPT-5.6-SOL',
      reference: reference(100),
      auditId: `0x${'77'.repeat(32)}`,
    })
    assert.equal(result.status, 'SKIPPED')
    const evidence = JSON.parse(await readFile(result.evidencePath!, 'utf8')) as ProxyAuditSkipEvidenceV1
    return { result, evidence, requestCount }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('target eligibility requires ResponseAuth and preserves advertised model spelling', () => {
  assert.deepEqual(classifyVerificationTarget(peer({ capabilities: [] }), 'gpt-5.6-sol', targetPolicy), {
    eligible: false,
    code: 'missing_response_auth',
    service: 'GPT-5.6-SOL',
    reason: `missing ${CONNECTION_CAPABILITY_RESPONSE_AUTH_V1}`,
  })
  assert.deepEqual(classifyVerificationTarget(peer(), 'gpt-5.6-sol', targetPolicy), {
    eligible: true,
    service: 'GPT-5.6-SOL',
  })
  assert.deepEqual(classifyVerificationTarget(peer(), 'missing-model', targetPolicy), {
    eligible: false,
    code: 'model_not_advertised',
    service: null,
    reason: 'model not advertised',
  })
})

test('target eligibility applies the buyer reputation minimum before audit', () => {
  assert.deepEqual(classifyVerificationTarget(peer({ reputationScore: 20 }), 'gpt-5.6-sol', {
    ...targetPolicy,
    minReputation: 50,
  }), {
    eligible: false,
    code: 'reputation_below_minimum',
    service: 'GPT-5.6-SOL',
    reason: 'peer reputation 20 is below buyer minimum 50',
  })
})

test('target eligibility audits sellers priced at or below the model reference price', () => {
  assert.deepEqual(classifyVerificationTarget(pricedAt(4, 20), 'gpt-5.6-sol', targetPolicy), {
    eligible: true, service: 'GPT-5.6-SOL',
  })
  assert.deepEqual(classifyVerificationTarget(pricedAt(5, 30, 5), 'gpt-5.6-sol', targetPolicy), {
    eligible: true, service: 'GPT-5.6-SOL',
  })
})

test('target eligibility skips sellers priced above the model reference price', () => {
  assert.deepEqual(classifyVerificationTarget(pricedAt(6, 31), 'gpt-5.6-sol', targetPolicy), {
    eligible: false,
    code: 'price_above_reference',
    service: 'GPT-5.6-SOL',
    reason: 'priced $6/$31 per 1M, above the gpt-5.6-sol reference $5/$30 · not audited',
  })
  // Either side above the reference is enough.
  assert.equal((classifyVerificationTarget(pricedAt(5, 30.01), 'gpt-5.6-sol', targetPolicy) as { code?: string }).code,
    'price_above_reference')
  // The seller's price for the model counts, not its cheaper default.
  assert.equal(classifyVerificationTarget(pricedAt(16.99, 84.99), 'gpt-5.6-sol', targetPolicy).eligible, false)
})

test('target eligibility refuses cached input priced above input, as the buyer router does', () => {
  // The buyer would refuse this offer, so auditing it could only end UNDETERMINED.
  assert.deepEqual(classifyVerificationTarget(pricedAt(4, 30, 4.5), 'gpt-5.6-sol', targetPolicy), {
    eligible: false,
    code: 'policy_rejected',
    service: 'GPT-5.6-SOL',
    reason: 'could not read a valid advertised price for GPT-5.6-SOL',
  })
  assert.equal(classifyVerificationTarget(pricedAt(5, 30, 5), 'gpt-5.6-sol', targetPolicy).eligible, true)
})

test('auditPriceRatio allows sellers up to that multiple of the reference price', () => {
  const tenPercent = { ...targetPolicy, priceCap: { ...targetPolicy.priceCap, ratio: 1.1 } }
  assert.equal(classifyVerificationTarget(pricedAt(5.5, 33), 'gpt-5.6-sol', tenPercent).eligible, true)
  assert.deepEqual(classifyVerificationTarget(pricedAt(5.6, 33), 'gpt-5.6-sol', tenPercent), {
    eligible: false,
    code: 'price_above_reference',
    service: 'GPT-5.6-SOL',
    reason: 'priced $5.6/$33 per 1M, above the gpt-5.6-sol reference $5/$30 × 1.1 · not audited',
  })
})

test('target eligibility uses buyer trust signals instead of seller-reported reputation', () => {
  assert.deepEqual(classifyVerificationTarget(peer({
    reputationScore: 0,
    onChainChannelCount: 100,
    onChainTotalVolumeUsdcMicros: 100_000_000,
    onChainUsageEpoch: 1,
    onChainUsageShareBps: 10_000,
    onChainPoolPowerShareBps: 10_000,
  }), 'gpt-5.6-sol', { ...targetPolicy, minReputation: 75 }), {
    eligible: true,
    service: 'GPT-5.6-SOL',
  })
})

test('target eligibility respects the wash-trading trust veto', () => {
  assert.deepEqual(classifyVerificationTarget(peer({
    reputationScore: 100,
    onChainChannelCount: 100,
    onChainTotalVolumeUsdcMicros: 100_000_000,
    onChainUsageEpoch: 1,
    onChainUsageShareBps: 10_000,
    onChainPoolPowerShareBps: 10_000,
    onChainWashFlagged: true,
  }), 'gpt-5.6-sol', { ...targetPolicy, minReputation: 1 }), {
    eligible: false,
    code: 'reputation_below_minimum',
    service: 'GPT-5.6-SOL',
    reason: 'peer reputation 0 is below buyer minimum 1',
  })
})

test('target eligibility tolerates persisted partial metadata without provider announcements', () => {
  const persistedPeer = peer({
    metadata: { capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] } as PeerInfo['metadata'],
  })

  assert.deepEqual(classifyVerificationTarget(persistedPeer, 'gpt-5.6-sol', targetPolicy), {
    eligible: true,
    service: 'GPT-5.6-SOL',
  })
})

test('target aliases select one eligible advertised spelling without duplicating the seller', () => {
  const aliasedPeer = peer({
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      services: {
        'claude-opus-4-6': { inputUsdPerMillion: 6, outputUsdPerMillion: 31 },
        'claude-opus-4.6': { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
      },
    } },
  })

  assert.deepEqual(classifyVerificationTargetServices(
    aliasedPeer,
    ['claude-opus-4-6', 'claude-opus-4.6'],
    targetPolicy,
  ), {
    eligible: true,
    service: 'claude-opus-4.6',
  })
})

test('buyer proxy snapshot requires a connected live daemon and parses peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-proxy-state-'))
  try {
    await writeFile(join(directory, 'buyer.state.json'), JSON.stringify({
      state: 'connected',
      pid: process.pid,
      port: 8377,
      discoveredPeers: [peer()],
    }))
    const snapshot = await loadBuyerProxySnapshot(directory)
    assert.equal(snapshot.baseUrl, 'http://127.0.0.1:8377')
    assert.equal(snapshot.pid, process.pid)
    assert.equal(snapshot.peers.length, 1)
    assert.equal(snapshot.settings, null)
    await writeFile(join(directory, 'buyer.state.json'), JSON.stringify({
      state: 'connected',
      pid: process.pid,
      port: 8377,
      discoveredPeers: [peer()],
      settings: {
        minPeerReputation: 5,
        maxPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
      },
    }))
    assert.deepEqual((await loadBuyerProxySnapshot(directory)).settings, {
      minPeerReputation: 5,
      maxPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
      maxReserveAmountUsdc: null,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('proxy runtime uses dynamic reference sizes and pins every batch', async () => {
  for (const count of [100, 110, 500]) {
    const run = await runTarget(count)
    assert.equal(run.result.status, 'SAME')
    assert.equal(run.result.probeCount, count)
    assert.equal(run.result.parsedProbeCount, count)
    assert.equal(run.result.correctProbeCount, count)
    assert.equal(run.result.incorrectProbeCount, 0)
    assert.equal(run.result.correctRate, 1)
    assert.equal(run.result.requestCount, count / 10)
    assert.equal(run.requestCount, count / 10)
    assert.equal(run.evidence.result.selectedProbeCount, count)
    assert.equal(run.evidence.result.parsedProbeCount, count)
    assert.equal(run.evidence.evidenceLevel, 'proxy-observation-with-verified-response-auth-no-payment-evidence')
    assert.equal(run.evidence.exchanges.every((exchange) => exchange.responseAuth.status === 'verified'), true)
    assert.deepEqual({ ...run.result.cost, estimatedCostUsd: 0 }, {
      inputTokens: count * 10,
      outputTokens: count * 2,
      totalTokens: count * 12,
      estimatedCostUsd: 0,
      pricedExchangeCount: count / 10,
      missingCostExchangeCount: 0,
    })
    assert.ok(Math.abs(run.result.cost.estimatedCostUsd - (count / 10) * 0.00014) < 1e-12)
    assert.deepEqual(run.evidence.result.cost, run.result.cost)
    for (const request of run.requests) {
      assert.equal((request.headers as Record<string, string>)['x-antseed-pin-peer'], '11'.repeat(20))
    }
  }
})

test('audit batches use recorded crypto-random prompt variants', async () => {
  const run = await runTarget(500)
  assert.equal(run.result.status, 'SAME')
  const used = new Set<string>()
  for (const exchange of run.evidence.exchanges) {
    const variantId = exchange.promptVariantId
    assert.ok(variantId && KBF_PROMPT_VARIANT_IDS.includes(variantId))
    used.add(variantId)
    const body = JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    const variant = getKbfPromptVariant(variantId)
    assert.equal(body.messages[0]?.content, variant.systemPrompt)
    assert.equal(body.messages[1]?.content.startsWith(variant.task), true)
  }
  assert.ok(used.size > 1, 'expected more than one prompt variant across 50 batches')
})

test('audits send the reference thinking suppression but no other reference-endpoint settings', async () => {
  const legacy = reference(100)
  legacy.queryProfile.reasoningStrategy = 'bare'
  legacy.queryProfile.requestOverrides = { reasoning_effort: 'none', reasoning: { effort: 'low' }, provider: { order: ['X'] } }
  legacy.queryProfile.requestOmissions = ['temperature', 'top_p']
  const run = await runTarget(100, 'valid', 0, 'verified', true, 10_000, undefined, undefined, legacy)
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.requests.length, 10)
  for (const request of run.requests) {
    const body = JSON.parse(request.body) as Record<string, unknown>
    assert.equal(body.temperature, 0)
    assert.equal(body.max_tokens, legacy.queryProfile.maxTokensPerRequest)
    assert.equal(body.stream, false)
    // `n` and `top_p` are left out, as in the KBF reference code: Anthropic-Messages-only
    // sellers reject `n`, and several upstreams reject `top_p` (Kimi K3, Opus 5, Opus 4.6).
    assert.equal(body.n, undefined)
    assert.equal(body.top_p, undefined)
    // As in the KBF reference code, the target gets the reference's thinking suppression.
    assert.equal(body.reasoning_effort, 'none')
    assert.deepEqual(body.reasoning, { effort: 'low' })
    assert.equal(body.provider, undefined)
  }
})

test('audits append the reference prefill and record nothing when the seller accepts it', async () => {
  const prefilled = reference(40)
  prefilled.generator.params.referenceEndpointRequest = {
    reasoningStrategy: 'prefill', requestOverrides: {}, requestOmissions: [], assistantPrefill: '<think></think>',
  }
  const run = await runTarget(40, 'valid', 0, 'verified', true, 10_000, undefined, undefined, prefilled)
  assert.equal(run.result.status, 'SAME')
  for (const exchange of run.evidence.exchanges) {
    assert.equal(exchange.omittedThinkingSuppression, undefined)
    const sent = JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    assert.deepEqual(sent.messages.at(-1), { role: 'assistant', content: '<think></think>' })
  }
})

test('a seller refusing the thinking suppression is re-asked without it and the omission is recorded', async () => {
  const suppressed = reference(40)
  suppressed.generator.params.referenceEndpointRequest = {
    reasoningStrategy: 'reasoning-effort-none', requestOverrides: { reasoning: { effort: 'none' } }, requestOmissions: [],
  }
  const run = await runTarget(40, 'thinking-rejected', 0, 'verified', true, 10_000, undefined, undefined, suppressed)
  assert.equal(run.result.status, 'SAME')
  const bodies = run.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>)
  const refused = bodies.filter((body) => 'reasoning' in body)
  assert.ok(refused.length >= 1 && refused.length <= 2, `expected at most one refused request per concurrent batch, got ${refused.length}`)
  for (const exchange of run.evidence.exchanges) {
    assert.equal(exchange.omittedThinkingSuppression, true)
    const sent = JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as Record<string, unknown>
    assert.equal('reasoning' in sent, false)
    assert.equal(sent.temperature, 0)
  }
})

test('proxy runtime retries transient failures', async () => {
  const run = await runTarget(100, 'valid', 2)
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.requestCount, 12)
  assert.equal(run.evidence.exchanges[0]?.attemptCount, 3)
})

test('proxy runtime retries one verified blank length response without usable token telemetry', async () => {
  const run = await runTarget(100, 'blank-length')
  const firstExchange = run.evidence.exchanges[0]
  const firstBatchRequests = run.requests.filter((request) => request.body.includes('test probe 1 value'))

  assert.equal(run.result.status, 'SAME')
  assert.equal(run.requestCount, 11)
  assert.equal(firstExchange?.attemptCount, 2)
  assert.equal(firstExchange?.requestIds.length, 2)
  assert.notEqual(firstExchange?.requestIds[0], firstExchange?.requestIds[1])
  assert.equal(firstExchange?.attemptCosts?.length, 2)
  assert.equal(firstExchange?.responseAuth.status, 'verified')
  assert.equal(firstBatchRequests.length, 2)
  assert.equal(firstBatchRequests[0]?.body, firstBatchRequests[1]?.body)
})

test('proxy runtime re-asks a persistently blank batch twice, then keeps the result', async () => {
  const run = await runTarget(100, 'persistent-blank-length')

  assert.equal(run.requestCount, 12)
  assert.equal(run.evidence.exchanges[0]?.attemptCount, 3)
  assert.equal(run.evidence.exchanges[0]?.requestIds.length, 3)
  assert.equal(run.evidence.exchanges[0]?.attemptCosts?.length, 3)
  // The other nine batches still give 90% coverage, so the audit reaches a verdict.
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 90)
})

test('a batch missing more than half its answers is re-asked and the best attempt is kept', async () => {
  const run = await runTarget(100, 'sparse-then-better')
  const first = run.evidence.exchanges[0]!
  assert.equal(first.attemptCount, 2)
  assert.equal(first.requestIds.length, 2)
  assert.equal(first.attemptCosts?.length, 2)
  assert.equal(first.answers.filter((answer) => answer !== null).length, 8)
  assert.equal(first.responseAuth.requestId, first.requestIds[1])
  assert.equal(run.requestCount, 11)
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 98)
  assert.equal(run.evidence.result.stats.targetHamming, 0)
})

test('a low-coverage batch keeps its best attempt after two re-asks', async () => {
  const run = await runTarget(100, 'sparse-best-first')
  const first = run.evidence.exchanges[0]!
  assert.equal(first.attemptCount, 3)
  assert.equal(first.requestIds.length, 3)
  // Attempts gave 4, 2 and 3 answers; the first (4 answers) is kept with its own ResponseAuth.
  assert.equal(first.answers.filter((answer) => answer !== null).length, 4)
  assert.equal(first.responseAuth.requestId, first.requestIds[0])
  assert.equal(run.requestCount, 12)
})

test('stale model advertisement skips after one model-not-found response', async () => {
  const run = await runSkippedTarget(Response.json({
    error: {
      type: 'invalid_request_error',
      code: 'model_not_found',
      message: 'Service "GPT-5.6-SOL" is not served by this peer.',
    },
  }, { status: 400 }))
  assert.equal(run.requestCount, 1)
  assert.equal(run.result.code, 'stale_model_advertisement')
  assert.match(run.result.reason, /advertised GPT-5\.6-SOL/)
  assert.equal(run.evidence.exchange.attemptCount, 1)
})

test('an upstream "Unknown model" answer is a stale advertisement, not an audit failure', async () => {
  const run = await runSkippedTarget(Response.json({
    error: { type: 'invalid_request_error', message: 'Unknown model: claude-sonnet-5.5' },
  }, { status: 400 }))
  assert.equal(run.requestCount, 1)
  assert.equal(run.result.code, 'stale_model_advertisement')
})

test('deleted upstream credentials skip after the first batch with a structured reason', async () => {
  const run = await runSkippedTarget(Response.json({
    code: 'GROUP_DELETED',
    message: 'API Key group was deleted',
  }, { status: 403 }))
  assert.equal(run.requestCount, 1)
  assert.equal(run.result.code, 'upstream_credentials_invalid')
  assert.equal(run.result.outcomeReason?.nextAction, 'seller must repair credentials')
  assert.equal(run.evidence.result.outcomeReason?.code, 'upstream_credentials_invalid')
})

test('a seller refusing temperature is re-asked without it and the omission is recorded', async () => {
  const run = await runTarget(40, 'sampling-rejected')
  assert.equal(run.result.status, 'SAME')
  const bodies = run.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>)
  const withSampling = bodies.filter((body) => 'temperature' in body || 'top_p' in body)
  assert.ok(withSampling.length >= 1 && withSampling.length <= 2, `expected at most one refused request per concurrent batch, got ${withSampling.length}`)
  assert.equal(bodies.length, run.evidence.exchanges.length + withSampling.length)
  for (const exchange of run.evidence.exchanges) {
    assert.deepEqual(exchange.omittedSamplingFields, ['temperature'])
    const sent = JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as Record<string, unknown>
    assert.equal('temperature' in sent, false)
    assert.equal('top_p' in sent, false)
  }
})

test('canonical audits send temperature and record no omission', async () => {
  const run = await runTarget(40)
  for (const exchange of run.evidence.exchanges) {
    assert.equal(exchange.omittedSamplingFields, undefined)
    const sent = JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as Record<string, unknown>
    assert.equal(sent.temperature, 0)
  }
})

test('canonical temperature rejection skips after the first batch', async () => {
  const run = await runSkippedTarget(Response.json({
    error: { message: 'invalid temperature: only 0.6 is allowed for this model' },
  }, { status: 400 }))
  assert.equal(run.requestCount, 1)
  assert.equal(run.result.code, 'request_profile_incompatible')
  assert.equal(run.result.outcomeReason?.source, 'request_profile')
})

test('proxy runtime reduces seller concurrency after HTTP 429', async () => {
  const run = await runTarget(40, 'rate-limited')
  // Three of four batches answered: 75% coverage is enough for a verdict.
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 30)
  assert.equal(run.evidence.exchanges[1]?.response?.statusCode, 429)
  assert.equal(run.evidence.exchanges[1]?.attemptCount, 5)
  assert.equal(run.finalBatchStartedAfterSlow, true)
})

test('an out-of-range answer is unscored, not counted wrong', async () => {
  const run = await runTarget(100, 'out-of-range')
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 99)
  assert.equal(run.evidence.result.stats.targetHamming, 0)
  assert.equal(run.evidence.result.stats.targetTotal, 99)
})

for (const answerMode of ['malformed', 'empty-responses', 'content-filter'] as const) {
  test(`${answerMode} completed responses are unavailable and produce UNDETERMINED`, async () => {
    const run = await runTarget(100, answerMode)
    assert.equal(run.result.status, 'UNDETERMINED')
    assert.equal(run.result.parsedProbeCount, 0)
    assert.equal(run.evidence.result.stats.targetHamming, 0)
    assert.equal(run.evidence.result.stats.targetTotal, 0)
    assert.equal(run.result.outcomeReason?.code, 'malformed_output')
    assert.equal(run.result.outcomeReason?.affectedBatchCount, 10)
    assert.equal(run.result.outcomeReason?.nextAction, 'seller must return parseable output')
    // Each empty batch is asked three times (first try plus two re-asks), as in the KBF reference code.
    assert.equal(run.requestCount, 30)
    assert.equal(run.evidence.exchanges.every((exchange) => exchange.attemptCount === 3), true)
    assert.equal(run.evidence.exchanges.every((exchange) => (
      exchange.status === 'succeeded'
      && exchange.outcomeReason?.code === 'malformed_output'
      && exchange.matches.every((match) => match === null)
    )), true)
  })
}

test('fully parsed wrong answers are DIFF', async () => {
  const run = await runTarget(100, 'all-wrong')
  assert.equal(run.result.status, 'DIFF')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 100)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
  assert.equal(run.result.outcomeReason, null)
})

test('selective omissions are unscored, and a batch missing most answers is re-asked', async () => {
  const run = await runTarget(100, 'partial-malformed')
  // Every attempt answers only the first probe of each batch: 10 scored answers is under half.
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.parsedProbeCount, 10)
  assert.equal(run.evidence.result.stats.targetHamming, 0)
  assert.equal(run.evidence.result.stats.targetTotal, 10)
  assert.equal(run.requestCount, 30)
  assert.equal(run.evidence.exchanges.every((exchange) => (
    exchange.matches[0] === 1
    && exchange.matches.slice(1).every((match) => match === null)
    && exchange.outcomeReason === null
    && exchange.attemptCount === 3
  )), true)
})

test('one wholly malformed batch is left unscored and can be repaired by resume', async () => {
  const first = await runTarget(100, 'malformed-first-batch')
  // 90% of probes scored: enough for a verdict, the malformed batch is simply left out.
  assert.equal(first.result.status, 'SAME')
  assert.equal(first.result.parsedProbeCount, 90)
  assert.equal(first.evidence.exchanges[0]?.outcomeReason?.code, 'malformed_output')
  assert.equal(first.evidence.exchanges[0]?.attemptCount, 3)
  assert.equal(first.evidence.exchanges[0]?.matches.every((match) => match === null), true)

  const resumed = await runTarget(100, 'valid', 0, 'verified', true, 10_000, {
    parentAuditId: first.result.auditId,
    reservationAuditId: first.result.auditId,
    parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges,
  })
  assert.equal(resumed.result.status, 'SAME')
  assert.equal(resumed.requestCount, 1)
  assert.deepEqual(resumed.evidence.resume?.reusedBatchIndexes, [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('responses SSE is decoded even when the request used stream false', async () => {
  const run = await runTarget(100, 'sse')
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 0)
})

test('exhausted transport retries produce UNDETERMINED evidence', async () => {
  const run = await runTarget(100, 'transport-failure')
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.parsedProbeCount, 0)
  assert.equal(run.evidence.result.stats.targetTotal, 0)
  assert.equal(run.requestCount, 5)
  assert.equal(run.evidence.exchanges.every((exchange) => exchange.status === 'failed'), true)
  assert.equal(run.result.outcomeReason?.code, 'transport_error')
  assert.equal(run.result.outcomeReason?.affectedBatchCount, 10)
  assert.equal(run.result.cost.pricedExchangeCount, 0)
  assert.equal(run.result.cost.missingCostExchangeCount, 10)
})

test('semantic temporarily-unavailable HTTP 400 retries and remains resumable', async () => {
  const run = await runTarget(100, 'semantic-unavailable')
  assert.equal(run.requestCount, 5)
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.outcomeReason?.code, 'temporarily_unavailable')
  assert.equal(run.result.outcomeReason?.retryable, true)
})

test('resume reuses authenticated batches and requests only unresolved batches', async () => {
  const first = await runTarget(40, 'rate-limited')
  assert.equal(first.evidence.exchanges[1]?.status, 'failed')
  const resumed = await runTarget(40, 'valid', 0, 'verified', true, 10_000, {
    parentAuditId: first.result.auditId,
    reservationAuditId: first.result.auditId,
    parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges,
  })
  assert.equal(resumed.result.status, 'SAME')
  assert.equal(resumed.requestCount, 1)
  assert.deepEqual(resumed.evidence.resume?.reusedBatchIndexes, [0, 2, 3])
  assert.equal(resumed.evidence.resume?.reservationAuditId, first.result.auditId)
  assert.equal(resumed.result.cost.pricedExchangeCount, 1)
  assert.equal(resumed.result.cumulativeCost?.pricedExchangeCount, 4)
})

test('repeated resume preserves the original seller reservation audit id', async () => {
  const first = await runTarget(40, 'rate-limited')
  const second = await runTarget(40, 'rate-limited', 0, 'verified', true, 10_000, {
    parentAuditId: first.result.auditId,
    reservationAuditId: first.result.auditId,
    parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges,
  })
  const third = await runTarget(40, 'valid', 0, 'verified', true, 10_000, {
    parentAuditId: second.result.auditId,
    reservationAuditId: second.evidence.resume?.reservationAuditId ?? second.result.auditId,
    parentEvidenceHash: second.result.evidenceHash,
    exchanges: second.evidence.exchanges,
  })

  assert.equal(third.result.status, 'SAME')
  assert.equal(third.evidence.resume?.parentAuditId, second.result.auditId)
  assert.equal(third.evidence.resume?.reservationAuditId, first.result.auditId)
})

test('batch checkpoints retain run identity for interrupted-run discovery', async () => {
  const run = await runTarget(40, 'rate-limited', 0, 'verified', true, 10_000, undefined, {
    runId: 'run-checkpoint',
    epoch: '42',
    model: 'gpt-5.6-sol',
  })
  assert.equal(run.checkpoints.length, 1)
  assert.equal(run.checkpoints[0]?.checkpoint.runId, 'run-checkpoint')
  assert.equal(run.checkpoints[0]?.checkpoint.epoch, '42')
  assert.equal(run.checkpoints[0]?.checkpoint.model, 'gpt-5.6-sol')
  assert.equal(run.checkpoints[0]?.checkpoint.exchanges.length, 4)
})

test('checkpoint discovery ignores pre-resume checkpoints without run identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-legacy-checkpoint-'))
  try {
    const checkpointDirectory = join(directory, '.checkpoints')
    await mkdir(checkpointDirectory, { recursive: true })
    await writeFile(join(checkpointDirectory, 'legacy.json'), JSON.stringify({
      version: 1,
      kind: 'antseed-verifier-audit-checkpoint',
      auditId: 'legacy-audit',
      exchanges: [],
    }))
    assert.deepEqual(await readModelAuditCheckpoints(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('seller audit deadline aborts all remaining batches', async () => {
  const startedAt = Date.now()
  const run = await runTarget(100, 'hanging', 0, 'verified', true, 25)
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.parsedProbeCount, 0)
  assert.equal(Date.now() - startedAt < 1_000, true)
  assert.equal(run.evidence.exchanges.every((exchange) => (
    exchange.failureReason?.includes('seller audit deadline exceeded')
  )), true)
})

test('successful exchanges without telemetry remain explicitly unpriced', async () => {
  const run = await runTarget(100, 'valid', 0, 'verified', false)
  assert.equal(run.result.cost.estimatedCostUsd, 0)
  assert.equal(run.result.cost.pricedExchangeCount, 0)
  assert.equal(run.result.cost.missingCostExchangeCount, 10)
  assert.equal(run.evidence.exchanges.every((exchange) => exchange.cost === null), true)
})

for (const authMode of ['missing', 'unverified', 'wrong-request', 'wrong-seller', 'wrong-service'] as const) {
  test(`${authMode} ResponseAuth forces an UNDETERMINED verdict`, async () => {
    const run = await runTarget(100, 'valid', 0, authMode)
    assert.equal(run.result.status, 'UNDETERMINED')
    assert.match(run.evidence.result.verdictReason ?? '', /lacked valid verified ResponseAuth/)
  })
}
