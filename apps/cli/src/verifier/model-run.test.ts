import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KBF_PROMPT_VARIANT_IDS,
  computeBinomialPower,
  createReferenceQueryProfile,
  getKbfPromptVariant,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, type PeerId, type PeerInfo } from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import {
  classifyVerificationTarget,
  classifyVerificationTargetServices,
  loadBuyerProxySnapshot,
  readModelAuditCheckpoints,
  verifyModelTarget,
  writeRunSummary,
  type ModelVerificationResumeInput,
  type ModelVerificationSkip,
} from './model-run.js'
import type { ProxyAuditEvidenceV1, ProxyAuditSkipEvidenceV1 } from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'

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
  maxPricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 30 },
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
    | 'persistent-blank-length' = 'valid',
  transientFailures = 0,
  authMode: 'verified' | 'missing' | 'unverified' | 'wrong-request' | 'wrong-seller' | 'wrong-service' = 'verified',
  includeCost = true,
  auditTimeoutMs = 10_000,
  resume?: ModelVerificationResumeInput,
  checkpointIdentity?: { runId: string; epoch: string; model: string },
) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-target-'))
  let requestCount = 0
  let failureCount = 0
  let changedAnswer = false
  let returnedBlankLength = false
  let slowBatchCompleted = false
  let finalBatchStartedAfterSlow = false
  const requests: Array<{ headers: RequestInit['headers']; body: string }> = []
  const fetchFn: typeof fetch = async (_url, init) => {
    requestCount += 1
    const requestBody = init?.body instanceof Uint8Array
      ? new TextDecoder().decode(init.body)
      : String(init?.body ?? '')
    requests.push({ headers: init?.headers ?? {}, body: requestBody })
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
    const body = JSON.parse(requestBody) as { messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    const firstProbe = Number(prompt.match(/test probe (\d+) value is ___/)?.[1] ?? 0)
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
    const content = values.map((value, index) => {
      if (answerMode === 'out-of-range' && !changedAnswer) {
        changedAnswer = true
        return `(${index + 1}) ${count + 100}`
      }
      if (answerMode === 'all-wrong') return `(${index + 1}) ${count + 100}`
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
    getRequestCost() { return null },
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
      },
      target: peer(),
      service: 'GPT-5.6-SOL',
      reference: reference(count),
      auditId: resume ? `0x${'88'.repeat(32)}` : undefined,
      resume,
      checkpointIdentity,
    })
    if (result.status === 'SKIPPED') throw new Error(`unexpected skipped target: ${result.reason}`)
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    const checkpoints = await readModelAuditCheckpoints(directory)
    return { result, evidence, checkpoints, requestCount, requests, finalBatchStartedAfterSlow }
  } finally {
    await rm(directory, { recursive: true, force: true })
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
          getRequestCost() { return null },
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

test('target eligibility applies buyer reputation and pricing before audit', () => {
  assert.deepEqual(classifyVerificationTarget(peer({ reputationScore: 20 }), 'gpt-5.6-sol', {
    ...targetPolicy,
    minReputation: 50,
  }), {
    eligible: false,
    code: 'reputation_below_minimum',
    service: 'GPT-5.6-SOL',
    reason: 'peer reputation 20 is below buyer minimum 50',
  })

  assert.deepEqual(classifyVerificationTarget(peer({
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      services: { 'GPT-5.6-SOL': { inputUsdPerMillion: 6, outputUsdPerMillion: 31 } },
    } },
  }), 'gpt-5.6-sol', targetPolicy), {
    eligible: false,
    code: 'price_above_maximum',
    service: 'GPT-5.6-SOL',
    reason: 'advertised price input $6/M, output $31/M exceeds buyer maximum input $5/M, output $30/M',
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('run summaries are canonical buyer-proxy artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-run-'))
  try {
    const path = await writeRunSummary(directory, {
      version: 1,
      kind: 'antseed-model-verification-run',
      runId: 'run-1',
      model: 'gpt-5.6-sol',
      mode: 'buyer-proxy',
      proxyBaseUrl: 'http://127.0.0.1:8377',
      referenceId: 'reference-1',
      probeCount: 100,
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:01:00.000Z',
      results: [],
      failures: [],
      skipped: [],
    })
    const bytes = await readFile(path, 'utf8')
    assert.equal(bytes.endsWith('\n'), false)
    assert.equal(JSON.parse(bytes).mode, 'buyer-proxy')
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

test('proxy runtime retries persistent blank length responses only once', async () => {
  const run = await runTarget(100, 'persistent-blank-length')

  assert.equal(run.requestCount, 11)
  assert.equal(run.evidence.exchanges[0]?.attemptCount, 2)
  assert.equal(run.evidence.exchanges[0]?.requestIds.length, 2)
  assert.equal(run.evidence.exchanges[0]?.attemptCosts?.length, 2)
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
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.evidence.exchanges[1]?.response?.statusCode, 429)
  assert.equal(run.evidence.exchanges[1]?.attemptCount, 5)
  assert.equal(run.finalBatchStartedAfterSlow, true)
})

test('one out-of-range answer remains in the fixed discrepancy denominator', async () => {
  const run = await runTarget(100, 'out-of-range')
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 1)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
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
    assert.equal(run.requestCount, 10)
    assert.equal(run.evidence.exchanges.every((exchange) => exchange.attemptCount === 1), true)
    assert.equal(run.evidence.exchanges.every((exchange) => (
      exchange.status === 'succeeded'
      && exchange.outcomeReason?.code === 'malformed_output'
      && exchange.matches.every((match) => match === null)
    )), true)
  })
}

test('fully parsed wrong answers remain DIFF', async () => {
  const run = await runTarget(100, 'all-wrong')
  assert.equal(run.result.status, 'DIFF')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 100)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
  assert.equal(run.result.outcomeReason, null)
})

test('selective omissions remain discrepancies when a batch has a parseable answer', async () => {
  const run = await runTarget(100, 'partial-malformed')
  assert.equal(run.result.status, 'DIFF')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 90)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
  assert.equal(run.evidence.exchanges.every((exchange) => (
    exchange.matches[0] === 1
    && exchange.matches.slice(1).every((match) => match === 0)
    && exchange.outcomeReason === null
  )), true)
})

test('one wholly malformed batch makes the audit UNDETERMINED and can be repaired by resume', async () => {
  const first = await runTarget(100, 'malformed-first-batch')
  assert.equal(first.result.status, 'UNDETERMINED')
  assert.equal(first.result.parsedProbeCount, 90)
  assert.equal(first.result.outcomeReason?.code, 'malformed_output')
  assert.equal(first.result.outcomeReason?.affectedBatchCount, 1)
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
  assert.equal(first.result.status, 'UNDETERMINED')
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
