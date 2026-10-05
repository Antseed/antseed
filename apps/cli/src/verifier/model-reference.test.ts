import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  buildModelReference,
  collectReferenceProbes,
  createReferenceRequestLimiter,
  loadModelReference,
  resolveReferenceRequestOverrides,
} from './model-reference.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'

const MODEL = 'gpt-test'

function config(overrides: Partial<VerifierCLIConfig> = {}): VerifierCLIConfig {
  return {
    probeRequestTimeoutMs: 120_000,
    referenceRetryBaseDelayMs: 1,
    referenceEndpoint: {
      baseUrl: 'https://reference.test/v1',
      sourceId: 'test-source',
      trust: 'trusted' as const,
      models: {
        [MODEL]: {
          upstreamModel: 'upstream-test',
          contrastModels: ['contrast-test'],
          pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      },
      contrastModelBank: {
        'contrast-test': {
          upstreamModel: 'contrast-test',
          pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
          capabilityRank: 1,
        },
      },
    },
    ...overrides,
  }
}

function reference(count: number, hamming = 0, alpha = 0.05, confidence = 0.99): KbfReferenceV1 {
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
    selfHamming: hamming,
    selfTotal: count,
    minimumMismatchDelta: 0.1,
    alpha,
    cpConfidence: confidence,
  })
  const value: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: MODEL,
    serviceAliases: [MODEL],
    createdAt: '2026-08-05T00:00:00.000Z',
    source: 'generated',
    generator: {
      name: 'test',
      version: '1',
      verifierKind: 'kbf',
      params: {},
    },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream-test' }),
    selfTest: {
      hamming,
      total: count,
      coverage: 1,
      errorRate: hamming / count,
      outcomes: probes.map((probe, index) => ({
        probeId: probe.id,
        answer: probe.consensus + (index < hamming ? 0.5 : 0),
        match: index < hamming ? 0 : 1,
      })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha,
      clopperPearsonConfidence: confidence,
      selfHamming: hamming,
      selfTotal: count,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

function generatedCandidates(prompt: string): string {
  const count = Number(prompt.match(/^Generate (?:exactly )?(\d+)/)?.[1])
  const round = Number(prompt.match(/generation round (\d+)/)?.[1])
  const batch = Number(prompt.match(/batch (\d+)/)?.[1])
  const offset = (round - 1) * 10_000 + (batch - 1) * count
  return JSON.stringify(Array.from({ length: count }, (_, index) => {
    const value = offset + index + 1
    return {
      name: `stable fact ${value}`,
      domain: 'test',
      template: `The stable specialist test value ${value} is ___.`,
      consensus: value,
      range: [0, 100_000],
      tolerance: { mode: 'absolute', value: 0 },
    }
  }))
}

function successfulContent(model: string, prompt: string): string {
  if (prompt.startsWith('Generate ')) return generatedCandidates(prompt)
  const values = testPromptValues(prompt)
  return values.map((value, index) => `(${index + 1}) ${model.startsWith('contrast-') ? value + 100_000 : value}`).join('\n')
}

function testPromptValues(prompt: string): number[] {
  return [...prompt.matchAll(/(?:stable fact|collector fact|range fact) (\d+)/g)]
    .map((match) => Number(match[1]))
}

function response(content: string, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  } : { error: content }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('missing references fail with the explicit build command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-load-'))
  try {
    await assert.rejects(
      loadModelReference({ model: MODEL, referencesDir: directory }),
      new RegExp(`antseed verifier reference build ${MODEL}`),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build uses minimum mandatory reasoning and persists the target override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-build-'))
  const value = config()
  value.referenceEndpoint!.models[MODEL]!.serviceAliases = ['model.test-alias']
  const requestBodies: Array<Record<string, unknown>> = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      model: string
      messages: Array<{ content: string }>
    }
    requestBodies.push(body)
    const prompt = body.messages.at(-1)?.content ?? ''
    return response(successfulContent(body.model, prompt))
  }
  const catalog: VerifierModelCatalog = new Map([
    ['upstream-test', {
      upstreamModel: 'upstream-test',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      capabilityRank: 10,
      reasoning: { mandatory: true, supportedEfforts: ['high', 'medium', 'low'] },
    }],
    ['contrast-test', {
      upstreamModel: 'contrast-test',
      pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
      capabilityRank: 1,
      reasoning: { mandatory: false, supportedEfforts: ['high', 'low'] },
    }],
  ])
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: value, catalog, fetchFn })
    assert.equal(built.reference.probes.length, 100)
    assert.deepEqual(built.reference.serviceAliases, [MODEL, 'model.test-alias'])
    assert.equal(built.reference.queryProfile.reasoningStrategy, 'reasoning-effort-minimum-supported')
    assert.deepEqual(built.reference.queryProfile.requestOverrides, {
      reasoning: { effort: 'low', exclude: true },
    })
    const targetBodies = requestBodies.filter((body) => body.model === 'upstream-test')
    const contrastBodies = requestBodies.filter((body) => body.model === 'contrast-test')
    assert.equal(targetBodies.length > 0, true)
    assert.equal(contrastBodies.length > 0, true)
    assert.equal(targetBodies.every((body) => body.reasoning_effort === undefined), true)
    assert.equal(targetBodies.every((body) => JSON.stringify(body.reasoning) === JSON.stringify({
      effort: 'low',
      exclude: true,
    })), true)
    assert.equal(contrastBodies.every((body) => body.reasoning_effort === 'none'), true)
    assert.equal(BigInt(built.cost.totalUsdMicros) > 0n, true)
    assert.deepEqual(
      new Set(built.cost.purposes.map((entry) => entry.purpose)),
      new Set(['candidate-generation', 'target-model', 'contrast-model', 'self-test']),
    )
    const loaded = await loadModelReference({ model: MODEL, referencesDir: directory })
    assert.equal(loaded.reference.referenceId, built.reference.referenceId)
    await readFile(join(directory, '.checkpoints', `${MODEL}.json`), 'utf8')
    await built.finalize()
    await assert.rejects(readFile(join(directory, '.checkpoints', `${MODEL}.json`), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build routes only target requests through a pinned AntSeed peer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-route-'))
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const value = config()
  value.referenceEndpoint!.apiKey = 'openrouter-secret'
  value.referenceEndpoint!.models[MODEL]!.referenceRoute = {
    type: 'antseed',
    service: 'fable-5-coding-only',
    peerId: '12'.repeat(20),
    pricing: { inputUsdPerMillion: 0.45, outputUsdPerMillion: 1.15 },
  }
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      model: string
      messages: Array<{ content: string }>
    }
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body,
    })
    const prompt = body.messages.at(-1)?.content ?? ''
    const logicalModel = body.model === 'fable-5-coding-only' ? 'upstream-test' : body.model
    return response(successfulContent(logicalModel, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: value,
      buyerProxyPort: 8377,
      fetchFn,
    })
    const targetRequests = requests.filter((request) => request.body.model === 'fable-5-coding-only')
    const contrastRequests = requests.filter((request) => request.body.model === 'contrast-test')
    assert.equal(targetRequests.length > 0, true)
    assert.equal(contrastRequests.length > 0, true)
    assert.equal(targetRequests.every((request) => request.url === 'http://127.0.0.1:8377/v1/chat/completions'), true)
    assert.equal(targetRequests.every((request) => request.headers['x-antseed-pin-peer'] === '12'.repeat(20)), true)
    assert.equal(targetRequests.every((request) => request.headers.authorization === undefined), true)
    assert.equal(targetRequests.every((request) => request.body.reasoning === undefined && request.body.reasoning_effort === undefined), true)
    assert.equal(targetRequests.every((request) => request.body.temperature === undefined && request.body.top_p === undefined), true)
    assert.equal(contrastRequests.every((request) => (
      request.url === `${value.referenceEndpoint!.baseUrl}/chat/completions`
    )), true)
    assert.equal(contrastRequests.every((request) => request.headers.authorization === 'Bearer openrouter-secret'), true)
    assert.equal(contrastRequests.every((request) => request.headers['x-antseed-pin-peer'] === undefined), true)
    assert.equal(contrastRequests.every((request) => request.body.temperature !== undefined && request.body.top_p !== undefined), true)
    assert.equal(built.reference.queryProfile.upstreamModel, 'fable-5-coding-only')
    assert.equal(built.reference.queryProfile.reasoningStrategy, 'bare')
    assert.deepEqual(built.reference.queryProfile.requestOverrides, {})
    assert.deepEqual(built.reference.queryProfile.requestOmissions, ['temperature', 'top_p'])
    assert.equal(built.reference.provenance?.sourceId, `test-source:antseed:${'12'.repeat(20)}:fable-5-coding-only`)
    assert.equal(built.cost.models.find((entry) => entry.model === 'upstream-test')?.inputUsdPerMillion, 0.45)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('AntSeed reference route failures preserve cached work and never fall back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-route-resume-'))
  const value = config()
  value.referenceEndpoint!.apiKey = 'openrouter-secret'
  value.referenceEndpoint!.models[MODEL]!.referenceRoute = {
    type: 'antseed',
    service: 'fable-5-coding-only',
    peerId: '34'.repeat(20),
    pricing: { inputUsdPerMillion: 0.45, outputUsdPerMillion: 1.15 },
  }
  const promptCalls = new Map<string, number>()
  let failOneTargetRequest = true
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (body.model === 'fable-5-coding-only' && failOneTargetRequest && prompt.includes('domain chemistry_mp')) {
      failOneTargetRequest = false
      throw new TypeError('fetch failed')
    }
    assert.equal(body.model === 'fable-5-coding-only' ? String(url).startsWith('http://127.0.0.1:8377/') : true, true)
    const logicalModel = body.model === 'fable-5-coding-only' ? 'upstream-test' : body.model
    return response(successfulContent(logicalModel, prompt))
  }
  try {
    await assert.rejects(buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: value,
      buyerProxyPort: 8377,
      fetchFn,
    }), /AntSeed reference route unavailable.*fable-5-coding-only/)
    const reusablePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('domain chemistry_bp'))!
    await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: value,
      buyerProxyPort: 8377,
      fetchFn,
    })
    assert.equal(promptCalls.get(reusablePrompt), 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('mandatory reasoning uses the lowest declared effort and rejects unusable metadata', () => {
  const catalog: VerifierModelCatalog = new Map([
    ['provider/minimal', {
      upstreamModel: 'provider/minimal',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      capabilityRank: 1,
      reasoning: { mandatory: true, supportedEfforts: ['high', 'minimal', 'low'] },
    }],
    ['provider/unspecified', {
      upstreamModel: 'provider/unspecified',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      capabilityRank: 1,
      reasoning: { mandatory: true, supportedEfforts: null },
    }],
    ['provider/broken', {
      upstreamModel: 'provider/broken',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      capabilityRank: 1,
      reasoning: { mandatory: true, supportedEfforts: ['none'] },
    }],
  ])
  assert.deepEqual(resolveReferenceRequestOverrides('provider/minimal', catalog), {
    reasoning: { effort: 'minimal', exclude: true },
  })
  assert.deepEqual(resolveReferenceRequestOverrides('provider/unspecified', catalog), {
    reasoning: { effort: 'minimal', exclude: true },
  })
  assert.throws(
    () => resolveReferenceRequestOverrides('provider/broken', catalog),
    /exposes no supported reasoning effort/,
  )
  assert.deepEqual(resolveReferenceRequestOverrides('provider/optional', catalog), { reasoning_effort: 'none' })
})

test('reference build skips one empty candidate domain and retains powered quality gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-empty-domain-'))
  let medicalAttempts = 0
  const logs: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('domain medical')) {
      medicalAttempts += 1
      return Response.json({
        choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      })
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(medicalAttempts, 1)
    assert.equal(logs.some((message) => message.includes('skipping empty candidate batch for medical')), true)
    assert.equal(logs.some((message) => message.includes('finishReason')), true)
    assert.equal(logs.some((message) => message.includes('reference request retry')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build rejects a refused stability batch without aborting the target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-refused-stability-'))
  let refusedStabilityAttempts = 0
  let refusedPrompt: string | null = null
  const logs: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (refusedPrompt === null
      && body.model === 'upstream-test'
      && !prompt.startsWith('Generate ')
      && body.temperature === 0) {
      refusedPrompt = prompt
    }
    if (prompt === refusedPrompt && body.temperature === 0) {
      refusedStabilityAttempts += 1
      return Response.json({
        choices: [{ message: { content: null }, finish_reason: 'content_filter', native_finish_reason: 'refusal' }],
        usage: { prompt_tokens: 100, completion_tokens: 1 },
      })
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(built.reference.probes.length, 100)
    await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(refusedStabilityAttempts, 1)
    assert.equal(logs.some((message) => message.includes('skipping 10-probe stability batch')), true)
    assert.equal(logs.some((message) => /in domain [a-z_]+/.test(message)), true)
    const checkpoint = JSON.parse(await readFile(join(directory, '.checkpoints', `${MODEL}.json`), 'utf8')) as {
      responses: Record<string, { outcome?: string }>
    }
    assert.equal(Object.values(checkpoint.responses).some((entry) => entry.outcome === 'terminal-empty'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build adaptively isolates and caches a refused self-test probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-refused-self-test-'))
  let refusedSelfTestAttempts = 0
  let refusedProbeText: string | null = null
  const refusedBatchSizes: number[] = []
  const logs: string[] = []
  let contrastChecked = false
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    const probeLines = prompt.split('\n').filter((line) => /^\(\d+\) /.test(line))
    if (body.model === 'contrast-test') contrastChecked = true
    if (contrastChecked && body.model === 'upstream-test' && refusedProbeText === null) {
      refusedProbeText = probeLines[0]?.replace(/^\(1\) /, '') ?? null
    }
    if (body.model === 'upstream-test'
      && refusedProbeText !== null
      && prompt.includes(refusedProbeText)) {
      refusedSelfTestAttempts += 1
      refusedBatchSizes.push(testPromptValues(prompt).length)
      return Response.json({
        choices: [{ message: { content: null }, finish_reason: 'content_filter', native_finish_reason: 'refusal' }],
        usage: { prompt_tokens: 100, completion_tokens: 1 },
      })
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(built.reference.selfTest.coverage, 0.99)
    assert.equal(refusedBatchSizes.some((size) => size > 1), true)
    assert.equal(refusedBatchSizes.includes(1), true)
    assert.equal(logs.some((message) => /splitting refused \d+-probe self-test batch/.test(message)), true)
    assert.equal(logs.some((message) => message.includes('skipping refused self-test probe')), true)
    const attemptsAfterFirstBuild = refusedSelfTestAttempts
    await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(refusedSelfTestAttempts, attemptsAfterFirstBuild)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('no-text length responses isolate a contrast without identical retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-length-contrast-'))
  let lengthAttempts = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (body.model === 'contrast-test') {
      lengthAttempts += 1
      return Response.json({
        choices: [{ message: { content: null }, finish_reason: 'length', native_finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 1600 },
      })
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(
      buildModelReference({
        model: MODEL,
        referencesDir: directory,
        config: config({ referenceMaxNoProgressRounds: 1 }),
        fetchFn,
      }),
      /made no progress/,
    )
    assert.equal(lengthAttempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build isolates an unavailable contrast after its first terminal failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-gated-contrast-'))
  let gatedAttempts = 0
  const logs: string[] = []
  const value = config()
  value.referenceEndpoint!.models[MODEL]!.contrastModels = ['gated-contrast', 'contrast-test']
  value.referenceEndpoint!.contrastModelBank!['gated-contrast'] = {
    upstreamModel: 'gated-contrast',
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
    capabilityRank: 2,
  }
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (body.model === 'gated-contrast') {
      gatedAttempts += 1
      return response(JSON.stringify({ error: { message: 'age confirmation required' } }), 403)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: value,
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(gatedAttempts, 1)
    assert.equal(logs.some((message) => message.includes('contrast model gated-contrast unavailable')), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loader rejects references outside the configured adaptive sizing policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-policy-'))
  const path = join(directory, `${MODEL}.json`)
  try {
    for (const [candidate, policy, message] of [
      [reference(50), undefined, /probe count 50/],
      [reference(510), undefined, /probe count 510/],
      [reference(110), config({ referenceProbeStep: 20 }), /adaptive sizing sequence/],
      [reference(100, 2), undefined, /statistical power .* is below 0\.900/],
      [reference(100, 0, 0.1), undefined, /statistical power alpha must be 0\.05/],
      [reference(100, 0, 0.05, 0.98), undefined, /Clopper-Pearson confidence must be 0\.99/],
    ] as const) {
      await writeFile(path, JSON.stringify(candidate))
      await assert.rejects(
        loadModelReference({ model: MODEL, referencesDir: directory, config: policy }),
        message,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive builder selects the first powered prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-adaptive-'))
  let selfTestMismatchesRemaining = 4
  let contrastChecked = false
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      __antseedReferenceCacheDomain?: string
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) return response(generatedCandidates(prompt))
    const values = testPromptValues(prompt)
    if (body.model === 'contrast-test') {
      contrastChecked = true
      return response(values.map((value, index) => `(${index + 1}) ${value + 100_000}`).join('\n'))
    }
    const selfTest = contrastChecked && body.model === 'upstream-test' && body.temperature === 0
    return response(values.map((value, index) => {
      const mismatch = selfTest && selfTestMismatchesRemaining > 0
      if (mismatch) selfTestMismatchesRemaining -= 1
      return `(${index + 1}) ${mismatch ? value + Math.max(10, Math.abs(value) * 0.2) : value}`
    }).join('\n'))
  }
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    assert.equal(built.reference.probes.length, 120)
    assert.equal(built.reference.selfTest.hamming, 4)
    assert.ok(built.reference.statisticalPower >= 0.9)
    assert.equal(built.reference.queryProfile.reasoningStrategy, 'reasoning-effort-none')
    assert.deepEqual(built.reference.queryProfile.requestOverrides, { reasoning_effort: 'none' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive builder generates more candidates when the next step is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-grow-pool-'))
  const generationRounds = new Set<number>()
  const zeroTemperatureCalls = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) {
      const round = Number(prompt.match(/generation round (\d+)/)?.[1])
      const batch = Number(prompt.match(/batch (\d+)/)?.[1])
      generationRounds.add(round)
      const offset = (round - 1) * 10_000 + (batch - 1) * 100
      return response(JSON.stringify(Array.from({ length: 7 }, (_, index) => {
        const value = offset + index + 1
        return {
          name: `stable fact ${value}`,
          domain: 'test',
          template: `The stable specialist test value ${value} is ___.`,
          consensus: value,
          range: [0, 100_000],
          tolerance: { mode: 'absolute', value: 0 },
        }
      })))
    }
    const values = testPromptValues(prompt)
    if (body.model === 'contrast-test') {
      return response(values.map((value, index) => `(${index + 1}) ${value + 100_000}`).join('\n'))
    }
    const zeroCall = body.temperature === 0 ? (zeroTemperatureCalls.get(prompt) ?? 0) + 1 : 0
    if (body.temperature === 0) zeroTemperatureCalls.set(prompt, zeroCall)
    return response(values.map((value, index) => `(${index + 1}) ${value}`).join('\n'))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMinimumProbeCount: 110, referenceMaximumProbeCount: 110 }),
      fetchFn,
    })
    assert.equal(built.reference.probes.length, 110)
    assert.deepEqual([...generationRounds], [1, 2])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('underpowered 500-probe maximum preserves the previous reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-underpowered-'))
  const path = join(directory, `${MODEL}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'existing-reference')
  let contrastChecked = false
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      __antseedReferenceCacheDomain?: string
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) return response(generatedCandidates(prompt))
    const values = testPromptValues(prompt)
    if (body.model === 'contrast-test') {
      contrastChecked = true
      return response(values.map((value, index) => `(${index + 1}) ${value + 100_000}`).join('\n'))
    }
    const selfTest = contrastChecked && body.model === 'upstream-test' && body.temperature === 0
    return response(values.map((value, index) => (
      `(${index + 1}) ${selfTest && index === 0 ? value + 0.5 : value}`
    )).join('\n'))
  }
  try {
    await assert.rejects(buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMinimumStatisticalPower: 1 }),
      fetchFn,
    }), /underpowered at 500 probes/)
    assert.equal(await readFile(path, 'utf8'), 'existing-reference')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('collector generates until target and accepts probes distinguishing any contrast', async () => {
  let generated = 0
  const query = async (model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      const count = Number(prompt.match(/^Generate (?:exactly )?(\d+)/)?.[1])
      return JSON.stringify(Array.from({ length: count }, () => {
        generated += 1
        return {
          name: `collector fact ${generated}`,
          domain: 'test',
          template: `The stable collector test value ${generated} is ___.`,
          consensus: generated,
          range: [0, 1000],
          tolerance: { mode: 'absolute', value: 0 },
        }
      }))
    }
    const values = testPromptValues(prompt)
    return values.map((value, index) => {
      const differs = model === 'contrast-a' ? value % 2 === 1 : model === 'contrast-b' && value % 2 === 0
      return `(${index + 1}) ${differs ? value + 100 : value}`
    }).join('\n')
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: ['contrast-a', 'contrast-b'],
    targetCount: 4,
    candidateCountPerRound: 2,
    query,
  })

  assert.equal(generated, 4)
  assert.equal(collected.probes.length, 4)
  assert.deepEqual(collected.distinguishingProbeIdsByModel.get('contrast-a'), [
    collected.probes[0]!.id,
    collected.probes[2]!.id,
  ])
  assert.deepEqual(collected.distinguishingProbeIdsByModel.get('contrast-b'), [
    collected.probes[1]!.id,
    collected.probes[3]!.id,
  ])
})

test('collector stops after repeated rounds without progress', async () => {
  let generationRequests = 0
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      generationRequests += 1
      return JSON.stringify([{
        name: 'duplicate fact',
        domain: 'test',
        template: 'The stable duplicate collector value is ___.',
        consensus: 1,
        range: [0, 10],
        tolerance: { mode: 'absolute', value: 0 },
      }])
    }
    return '(1) 1'
  }

  await assert.rejects(collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 2,
    candidateCountPerRound: 1,
    maxNoProgressRounds: 2,
    query,
  }), /made no progress for 2 rounds/)
  assert.equal(generationRequests, 3)
})

test('collector rejects certified consensus values outside the declared range', async () => {
  let generationRound = 0
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      generationRound += 1
      return JSON.stringify([{
        name: `range fact ${generationRound}`,
        domain: 'test',
        template: `The range collector value ${generationRound} is ___.`,
        consensus: 5,
        range: [0, 10],
        tolerance: { mode: 'absolute', value: 20 },
      }])
    }
    const value = Number(prompt.match(/range fact (\d+)/)?.[1])
    return `(1) ${value === 1 ? 700 : 5}`
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 1,
    query,
  })
  assert.equal(generationRound, 2)
  assert.equal(collected.probes[0]?.consensus, 5)
})

test('collector applies rounded agreement for canonical absolute domains', async () => {
  const stabilityAnswers = new Map([
    ['stability-0', 100],
    ['stability-1', 100.4],
    ['stability-2', 99.6],
  ])
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) return 'test compound | 100'
    const cacheDomain = String(body.__antseedReferenceCacheDomain ?? '')
    return `(1) ${String(stabilityAnswers.get(cacheDomain) ?? 100)}`
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 1,
    query,
  })

  assert.equal(collected.probes.length, 1)
  assert.equal(collected.probes[0]?.domain, 'chemistry_bp')
  assert.equal(collected.probes[0]?.consensus, 100)
  assert.deepEqual(collected.probes[0]?.enrollmentEvidence, {
    temperatures: [0, 0.7, 0.7],
    answers: [100, 100.4, 99.6],
    rule: 'rounded-exact-agreement',
  })
})

test('collector never requests excluded canonical domains', async () => {
  const requestedDomains = new Set<string>()
  const query = async (model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    const domain = prompt.match(/canonical KBF domain ([a-z_]+)/)?.[1]
    if (domain) requestedDomains.add(domain)
    return successfulContent(model, prompt)
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    excludedDomains: ['medical'],
    targetCount: 1,
    candidateCountPerRound: 15,
    query,
  })

  assert.equal(requestedDomains.has('medical'), false)
  assert.equal(requestedDomains.size, 14)
  assert.equal(collected.probes.some((probe) => probe.domain === 'medical'), false)
})

test('collector stability requests never mix canonical domains', async () => {
  const stabilityDomains: Array<Set<string>> = []
  const valueForDomain = (domain: string): number => ['programming', 'chinese_internet'].includes(domain) ? 2000 : 100
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      const domain = prompt.match(/canonical KBF domain ([a-z_]+)/)?.[1]
      return `${domain} fact | ${valueForDomain(domain ?? '')}`
    }
    const matchedDomains = [...prompt.matchAll(/\b([a-z_]+) fact\b/g)].map((match) => match[1]!)
    const domains = new Set(matchedDomains)
    stabilityDomains.push(domains)
    return matchedDomains.map((domain, index) => `(${index + 1}) ${valueForDomain(domain)}`).join('\n')
  }

  await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 15,
    query,
  })

  assert.equal(stabilityDomains.length, 45)
  assert.equal(stabilityDomains.every((domains) => domains.size === 1), true)
})

test('collector rejects decimal disagreement in exact-match domains', async () => {
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      return prompt.includes('domain biology') ? 'test organism | 100' : ''
    }
    const cacheDomain = String(body.__antseedReferenceCacheDomain ?? '')
    if (cacheDomain === 'stability-1') return '(1) 100.5'
    if (cacheDomain === 'stability-2') return '(1) 99.4'
    return '(1) 100'
  }

  await assert.rejects(collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 5,
    maxNoProgressRounds: 1,
    query,
  }), /made no progress for 1 rounds/)
})

test('collector rejects consistently non-integral answers in exact-match domains', async () => {
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) return prompt.includes('domain biology') ? 'test organism | 100' : ''
    return '(1) 100.4'
  }

  await assert.rejects(collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 5,
    maxNoProgressRounds: 1,
    query,
  }), /made no progress for 1 rounds/)
})

test('collector rejects relative-domain stability spread above two percent', async () => {
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) return prompt.includes('domain medical') ? 'test medicine | 100' : ''
    const cacheDomain = String(body.__antseedReferenceCacheDomain ?? '')
    if (cacheDomain === 'stability-1') return '(1) 103'
    if (cacheDomain === 'stability-2') return '(1) 97'
    return '(1) 100'
  }

  await assert.rejects(collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 5,
    maxNoProgressRounds: 1,
    query,
  }), /made no progress for 1 rounds/)
})

test('collector independently shuffles every stability pass and preserves probe alignment', async () => {
  const passOrders: string[][] = []
  let shuffleCalls = 0
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) return 'first organism | 10\nsecond organism | 20'
    const names = [...prompt.matchAll(/of (first organism|second organism) is/g)].map((match) => match[1]!)
    passOrders.push(names)
    return names.map((name, index) => `(${index + 1}) ${name === 'first organism' ? 10 : 20}`).join('\n')
  }
  const shuffle = <T>(values: readonly T[]): T[] => {
    shuffleCalls += 1
    return shuffleCalls % 2 === 0 ? [...values].reverse() : [...values]
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    excludedDomains: [
      'chemistry_bp', 'chemistry_mp', 'physics', 'astronomy', 'math', 'programming', 'medical',
      'crypto_params', 'chinese_history', 'chinese_geography', 'chinese_literature',
      'chinese_internet', 'internet_culture', 'pop_culture',
    ],
    targetCount: 2,
    candidateCountPerRound: 2,
    query,
    shuffle,
  })

  assert.equal(shuffleCalls, 3)
  assert.deepEqual(passOrders, [
    ['first organism', 'second organism'],
    ['second organism', 'first organism'],
    ['first organism', 'second organism'],
  ])
  assert.deepEqual(collected.probes.map((probe) => probe.consensus), [10, 20])
})

test('reference requests retry new-account throttles with queued same-model work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-retry-'))
  const rateLimitedStabilityAttempts: number[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (body.model === 'upstream-test' && !prompt.startsWith('Generate ') && body.temperature === 0) {
      rateLimitedStabilityAttempts.push(Date.now())
      if (rateLimitedStabilityAttempts.length === 1) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded: new-account-rpm/upstream-test' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0.001' },
        })
      }
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const value = config()
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: value,
      fetchFn,
      requestLimiter: createReferenceRequestLimiter(value, {
        newAccountMinimumRequestIntervalMs: 1,
        newAccountRateLimitCooldownMs: 20,
      }),
    })
    assert.equal(built.reference.probes.length, 100)
    assert.ok(rateLimitedStabilityAttempts.length >= 2)
    assert.ok(rateLimitedStabilityAttempts[1]! - rateLimitedStabilityAttempts[0]! >= 15)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference requests retry nested Undici socket failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-socket-retry-'))
  let socketFailures = 0
  const logs: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    if (socketFailures === 0) {
      socketFailures += 1
      const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
      throw new TypeError('terminated', { cause })
    }
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn,
      log: (message) => logs.push(message),
    })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(socketFailures, 1)
    assert.equal(logs.some((message) => message.includes('reference request retry') && message.includes('terminated')), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference builds enforce the physical request budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-budget-'))
  const budgetedConfig = { ...config(), referenceMaxRequestsPerBuild: 1 }
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(
      buildModelReference({ model: MODEL, referencesDir: directory, config: budgetedConfig, fetchFn }),
      /request budget exhausted \(1\)/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed builds resume cached reference responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-resume-'))
  const promptCalls = new Map<string, number>()
  let failSecondCandidateBatch = true
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('domain chemistry_mp') && prompt.includes('batch 1')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn }), /reference endpoint 400/)
    await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    const firstCandidatePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('generation round 1, batch 1'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('domain exclusions preserve safe exact-request checkpoint responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-domain-resume-'))
  const promptCalls = new Map<string, number>()
  let failSecondCandidateBatch = true
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('domain chemistry_mp') && prompt.includes('batch 1')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn }))
    const medicalPrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('domain medical'))!
    const reusablePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('domain chemistry_bp'))!
    const excludedConfig = config()
    excludedConfig.referenceEndpoint!.models[MODEL]!.excludedDomains = ['medical']
    await buildModelReference({ model: MODEL, referencesDir: directory, config: excludedConfig, fetchFn })
    assert.equal(promptCalls.get(medicalPrompt), 1)
    assert.equal(promptCalls.get(reusablePrompt), 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('checkpoint compatibility invalidates changed sizing policies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-policy-checkpoint-'))
  let failSecondCandidateBatch = true
  const promptCalls = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('domain chemistry_mp') && prompt.includes('batch 1')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn }))
    await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMinimumStatisticalPower: 0.91 }),
      fetchFn,
    })
    const firstCandidatePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('generation round 1, batch 1'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('checkpoint compatibility invalidates changed AntSeed target routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-route-checkpoint-'))
  const promptCalls = new Map<string, number>()
  let failSecondCandidateBatch = true
  const value = config()
  value.referenceEndpoint!.models[MODEL]!.referenceRoute = {
    type: 'antseed', service: 'fable-5-coding-only', peerId: '56'.repeat(20),
    pricing: { inputUsdPerMillion: 0.45, outputUsdPerMillion: 1.15 },
  }
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('domain chemistry_mp') && prompt.includes('batch 1')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    const logicalModel = body.model.startsWith('fable-') ? 'upstream-test' : body.model
    return response(successfulContent(logicalModel, prompt))
  }
  try {
    await assert.rejects(buildModelReference({
      model: MODEL, referencesDir: directory, config: value, buyerProxyPort: 8377, fetchFn,
    }))
    value.referenceEndpoint!.models[MODEL]!.referenceRoute = {
      type: 'antseed', service: 'fable-5-reference-v2', peerId: '78'.repeat(20),
      pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.25 },
    }
    await buildModelReference({
      model: MODEL, referencesDir: directory, config: value, buyerProxyPort: 8378, fetchFn,
    })
    const firstCandidatePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('generation round 1, batch 1'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed builds preserve an existing reference file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-preserve-'))
  const path = join(directory, `${MODEL}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'existing-reference')
  try {
    await assert.rejects(buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn: async () => response('missing content', 400),
    }), /reference endpoint 400/)
    assert.equal(await readFile(path, 'utf8'), 'existing-reference')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
