import { describe, expect, it } from 'vitest'
import {
  KBF_CALIBRATION_METHOD,
  KBF_DEFAULT_PROMPT_VARIANT_ID,
  aggregateKbfSelfTestOutcomes,
  clopperPearsonUpper,
  computeReferenceId,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { auditEndpoint, selectProbes } from '../src/audit.js'
import type { ModelCallResult } from '../src/endpoint.js'
import { FakeEndpoint, answerDiscovery, testReference } from './fixtures.js'

const TEMPERATURE_REFUSAL: ModelCallResult = {
  ok: false, status: 400, retryable: false, message: 'HTTP 400: `temperature` is deprecated for this model.',
}

/** An endpoint that answers correctly, but refuses any request that sets `temperature`. */
function refusingTemperature(): FakeEndpoint {
  const endpoint = new FakeEndpoint()
  const answer = endpoint.call.bind(endpoint)
  endpoint.call = async (request, signal) => {
    if ('temperature' in request) {
      endpoint.requests.push(request)
      return TEMPERATURE_REFUSAL
    }
    return answer(request, signal)
  }
  return endpoint
}

/** A set over three domains, out of domain order, calibrated on its own batches with `misses` wrong answers. */
function calibratedSet(misses: number): KbfReferenceV1 {
  const base = testReference(90)
  const probes = base.probes.map((probe, index) => ({ ...probe, domain: `domain-${index % 3}` }))
  const outcomes = probes.map((probe, index) => {
    const miss = index < misses
    return { probeId: probe.id, answers: [miss ? probe.consensus + 7 : probe.consensus], matches: [miss ? 0 as const : 1 as const] }
  })
  const groups = [0, 1, 2].map((domain) => probes.filter((_probe, index) => index % 3 === domain))
  const value: KbfReferenceV1 = {
    ...base,
    probes,
    calibration: {
      version: 1,
      method: KBF_CALIBRATION_METHOD,
      passes: 1,
      ...aggregateKbfSelfTestOutcomes(outcomes),
      batches: groups.flatMap((group) => [0, 10, 20].map((offset) => group.slice(offset, offset + 10))).map((batch, batchIndex) => ({
        pass: 0,
        batchIndex,
        probeIds: batch.map((probe) => probe.id),
        promptVariantId: KBF_DEFAULT_PROMPT_VARIANT_ID,
        attempts: 1,
      })),
      calibratedAt: '2026-11-05T00:00:00.000Z',
    },
  }
  value.referenceId = computeReferenceId(value)
  return value
}

describe('auditEndpoint', () => {
  it('returns SAME for an endpoint serving the reference model', async () => {
    const result = await auditEndpoint({ endpoint: new FakeEndpoint(), reference: testReference() })
    expect(result.evaluation.verdict).toBe('SAME')
    expect(result.evaluation.stats.targetHamming).toBe(0)
    expect(result.statisticalPower).toBeGreaterThanOrEqual(0.9)
    expect(result.batches.every((batch) => batch.status === 'succeeded')).toBe(true)
  })

  it('returns DIFF for a substitute that misses a share of the reference probes', async () => {
    const substitute = new FakeEndpoint((probeIndex) => probeIndex % 3 === 0)
    const result = await auditEndpoint({ endpoint: substitute, reference: testReference() })
    expect(result.evaluation.verdict).toBe('DIFF')
  })

  it('treats failed batches as missing, not wrong, and reports UNDETERMINED below half coverage', async () => {
    const flaky = new FakeEndpoint(() => false, (callIndex) => callIndex % 4 !== 0)
    const result = await auditEndpoint({ endpoint: flaky, reference: testReference(), probeCount: 100, concurrency: 1, discoverThinking: false })
    expect(result.evaluation.verdict).toBe('UNDETERMINED')
    expect(result.evaluation.matchVector.filter((entry) => entry === null)).toHaveLength(70)
    expect(result.evaluation.stats.targetHamming).toBe(0)
  })

  it('reaches a verdict when half the probes are scored', async () => {
    const flaky = new FakeEndpoint(() => false, (callIndex) => callIndex % 2 === 0)
    const result = await auditEndpoint({ endpoint: flaky, reference: testReference(), probeCount: 100, concurrency: 1, discoverThinking: false })
    expect(result.evaluation.verdict).toBe('SAME')
    expect(result.evaluation.stats.targetTotal).toBe(50)
  })

  it('leaves missing answers unscored and re-asks a batch missing any answer until it is complete', async () => {
    const endpoint = new FakeEndpoint()
    const answer = endpoint.call.bind(endpoint)
    let calls = 0
    endpoint.call = async (request, signal) => {
      const result = await answer(request, signal)
      calls++
      if (!result.ok) return result
      // First try: 3 of 10 answers; second try: 8 of 10; third try: all 10.
      const keep = calls === 1 ? 3 : calls === 2 ? 8 : 10
      const text = result.text.split('\n').slice(0, keep).join('\n')
      return { ...result, text }
    }
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 10, concurrency: 1, discoverThinking: false })
    expect(calls).toBe(3)
    expect(result.batches[0]!.attempts).toBe(3)
    expect(result.batches[0]!.answers.filter((value) => value !== null)).toHaveLength(10)
    expect(result.evaluation.stats.targetHamming).toBe(0)
    expect(result.evaluation.stats.targetTotal).toBe(10)
    expect(result.evaluation.verdict).toBe('SAME')
  })

  it('stops re-asking after two retries and keeps the attempt with the most answers', async () => {
    const endpoint = new FakeEndpoint()
    const answer = endpoint.call.bind(endpoint)
    const kept = [2, 4, 3]
    let calls = 0
    endpoint.call = async (request, signal) => {
      const result = await answer(request, signal)
      const keep = kept[calls++] ?? 0
      if (!result.ok) return result
      return { ...result, text: result.text.split('\n').slice(0, keep).join('\n') }
    }
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 10, concurrency: 1, discoverThinking: false })
    expect(calls).toBe(3)
    expect(result.batches[0]!.attempts).toBe(3)
    expect(result.batches[0]!.answers.filter((value) => value !== null)).toHaveLength(4)
    expect(result.evaluation.verdict).toBe('UNDETERMINED')
  })

  it('does not score a reply cut off at the token limit and re-asks the batch', async () => {
    const endpoint = new FakeEndpoint()
    const answer = endpoint.call.bind(endpoint)
    let calls = 0
    endpoint.call = async (request, signal) => {
      const result = await answer(request, signal)
      calls++
      if (!result.ok) return result
      // First try: every answer wrong, but the reply stopped at the token limit; second try: complete.
      if (calls === 1) {
        const wrong = result.text.split('\n').map((line) => line.replace(/\d+$/, (value) => String(Number(value) + 7))).join('\n')
        return { ...result, text: wrong, finishReason: 'length' }
      }
      return result
    }
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 10, concurrency: 1, discoverThinking: false })
    expect(calls).toBe(2)
    expect(result.batches[0]!.truncated).toBeUndefined()
    expect(result.evaluation.stats.targetHamming).toBe(0)
    expect(result.evaluation.verdict).toBe('SAME')

    const cutOff = new FakeEndpoint()
    const cutOffAnswer = cutOff.call.bind(cutOff)
    cutOff.call = async (request, signal) => {
      const result = await cutOffAnswer(request, signal)
      return result.ok ? { ...result, finishReason: 'length' } : result
    }
    const always = await auditEndpoint({ endpoint: cutOff, reference: testReference(), probeCount: 10, concurrency: 1, discoverThinking: false })
    expect(always.batches[0]!.truncated).toBe(true)
    expect(always.batches[0]!.answers.every((value) => value === null)).toBe(true)
    expect(always.evaluation.verdict).toBe('UNDETERMINED')
  })

  it('fails instead of returning UNDETERMINED when the endpoint answers nothing', async () => {
    const endpoint = new FakeEndpoint()
    endpoint.call = async () => ({ ok: false, status: 401, retryable: false, message: 'HTTP 401: {"error":"User not found."}' })
    await expect(auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 }))
      .rejects.toThrow(/answered none of the 2 requests.*HTTP 401.*check the API key/)
  })

  it('asks each domain in its own batches and scores answers against the probe that was asked', async () => {
    const reference = testReference(200)
    const mixed = {
      ...reference,
      probes: reference.probes.map((probe, index) => ({ ...probe, domain: `domain-${index % 3}` })),
    }
    const result = await auditEndpoint({ endpoint: new FakeEndpoint(), reference: mixed, probeCount: 60 })

    const domainOf = new Map(mixed.probes.map((probe) => [probe.id, probe.domain]))
    for (const batch of result.batches) {
      expect(new Set(batch.probeIds.map((id) => domainOf.get(id))).size).toBe(1)
      expect(batch.probeIds.length).toBeLessThanOrEqual(10)
    }
    expect(result.probeIds).toEqual(result.batches.flatMap((batch) => batch.probeIds))
    expect(result.evaluation.verdict).toBe('SAME')
  })

  it('batches a calibrated set as pinned: domains in first-seen order, set order inside, ten per request', async () => {
    // The same 30 questions and batches are pinned in fingerprints and in the CLI's kbf-batching tests.
    const domains = ['math', 'law', 'math', 'bio']
    const pinned = [
      [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
      [20, 22, 24, 26, 28],
      [1, 5, 9, 13, 17, 21, 25, 29],
      [3, 7, 11, 15, 19, 23, 27],
    ]
    const base = testReference(30)
    const probes = base.probes.map((probe, index) => ({ ...probe, domain: domains[index % 4]! }))
    const reference: KbfReferenceV1 = {
      ...base,
      probes,
      calibration: {
        version: 1,
        method: KBF_CALIBRATION_METHOD,
        passes: 1,
        ...aggregateKbfSelfTestOutcomes(probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1 as const] }))),
        batches: pinned.map((batch, batchIndex) => ({
          pass: 0, batchIndex, probeIds: batch.map((index) => `p-${index}`), promptVariantId: KBF_DEFAULT_PROMPT_VARIANT_ID, attempts: 1,
        })),
        calibratedAt: '2026-11-05T00:00:00.000Z',
      },
    }
    reference.referenceId = computeReferenceId(reference)
    const result = await auditEndpoint({ endpoint: new FakeEndpoint(), reference, discoverThinking: false })
    expect(result.batches.map((batch) => batch.probeIds)).toEqual(pinned.map((batch) => batch.map((index) => `p-${index}`)))
  })

  it('varies the prompt wording between batches', async () => {
    const endpoint = new FakeEndpoint()
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 200 })
    expect(new Set(result.batches.map((batch) => batch.promptVariantId)).size).toBeGreaterThan(1)
    expect(result.evaluation.verdict).toBe('SAME')
  })

  it('sends canonical audit settings and the requested model', async () => {
    const endpoint = new FakeEndpoint()
    await auditEndpoint({ endpoint, reference: testReference(), model: 'vendor/open-model', probeCount: 20, discoverThinking: false })
    expect(endpoint.requests).toHaveLength(2)
    for (const request of endpoint.requests) {
      expect(request.model).toBe('vendor/open-model')
      expect(request.system.length).toBeGreaterThan(0)
      expect(request.temperature).toBe(0)
      expect('topP' in request).toBe(false)
    }
  })

  it('detects an endpoint that refuses temperature, asks without it and judges the answers', async () => {
    const endpoint = refusingTemperature()
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20, concurrency: 1 })
    expect(result.evaluation.verdict).toBe('SAME')
    expect(result.batches.every((batch) => batch.status === 'succeeded')).toBe(true)
    expect(result.batches.some((batch) => batch.omittedSamplingFields?.includes('temperature'))).toBe(true)
  })

  it('without discovery, sends the reference thinking suppression and drops it when refused', async () => {
    const reference = testReference()
    reference.generator.params.referenceEndpointRequest = {
      reasoningStrategy: 'reasoning-effort-none',
      requestOverrides: { reasoning: { effort: 'none' }, provider: { order: ['X'] } },
      requestOmissions: ['top_p'],
    }
    const accepting = new FakeEndpoint()
    await auditEndpoint({ endpoint: accepting, reference, probeCount: 20, concurrency: 1, discoverThinking: false })
    expect(accepting.requests.every((request) => JSON.stringify(request.extraBody) === JSON.stringify({ reasoning: { effort: 'none' } }))).toBe(true)

    const refusing = new FakeEndpoint()
    const answer = refusing.call.bind(refusing)
    refusing.call = async (request, signal) => request.extraBody
      ? { ok: false, status: 400, retryable: false, message: 'HTTP 400: Reasoning is mandatory for this endpoint and cannot be disabled.' }
      : answer(request, signal)
    const result = await auditEndpoint({ endpoint: refusing, reference, probeCount: 20, concurrency: 1, discoverThinking: false })
    expect(result.evaluation.verdict).toBe('SAME')
    for (const batch of result.batches) {
      expect(batch.attempts).toBe(2)
      expect(batch.omittedThinkingSuppression).toBe(true)
      expect(batch.omittedSamplingFields).toBeUndefined()
    }
  })
})

describe('selectProbes', () => {
  it('draws a fresh order per audit and stops at the smallest powered subset', () => {
    const reference = testReference()
    let seed = 1
    const draw = (max: number): number => {
      seed = (seed * 48271) % 2147483647
      return seed % max
    }
    const first = selectProbes(reference, { draw, minimumPower: 0.9 })
    const second = selectProbes(reference, { draw, minimumPower: 0.9 })
    expect(first.power).toBeGreaterThanOrEqual(0.9)
    expect(first.probes.length % 10).toBe(0)
    expect(first.probes.length).toBeLessThan(reference.probes.length)
    expect(first.probes.map((probe) => probe.id)).not.toEqual(second.probes.map((probe) => probe.id))
  })

  it('asks a calibrated reference whole and in stored order, and rates its power on the calibration', () => {
    const reference = calibratedSet(3)
    const { probes, power } = selectProbes(reference, { draw: () => 0, minimumPower: 0.9 })
    expect(probes.map((probe) => probe.id)).toEqual(reference.probes.map((probe) => probe.id))
    expect(power).toBeLessThan(selectProbes({ ...reference, calibration: undefined }, { draw: () => 0, minimumPower: 0.1, probeCount: 90 }).power)
  })

  it('still draws a subset of a calibrated reference when given a probe count', () => {
    const reference = calibratedSet(3)
    const { probes } = selectProbes(reference, { draw: () => 0, minimumPower: 0.9, probeCount: 30 })
    expect(probes).toHaveLength(30)
    expect(probes.map((probe) => probe.id)).not.toEqual(reference.probes.slice(0, 30).map((probe) => probe.id))
  })

  it('audits a calibrated reference in the batches it was calibrated on, against the calibration', async () => {
    const reference = calibratedSet(3)
    const result = await auditEndpoint({ endpoint: new FakeEndpoint(), reference, concurrency: 1 })
    expect(result.batches.map((batch) => batch.probeIds)).toEqual(reference.calibration!.batches.map((batch) => batch.probeIds))
    expect(result.evaluation.stats.selfHamming).toBe(3)
    expect(result.evaluation.stats.selfTotal).toBe(90)
    expect(result.evaluation.stats.p0Cp99).toBe(clopperPearsonUpper(3, 90, 0.99))
  })

  it('rejects probe counts that are not whole batches', () => {
    expect(() => selectProbes(testReference(), { draw: () => 0, minimumPower: 0.9, probeCount: 15 })).toThrow()
  })

  describe('thinking discovery (KBF reference code, per endpoint)', () => {
    it('uses the first strategy the endpoint honours and records the discovery', async () => {
      const endpoint = new FakeEndpoint()
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 })
      expect(result.thinkingDiscovery?.strategy).toBe('reasoning-effort-none')
      expect(result.thinkingDiscovery?.attempts).toHaveLength(1)
      const batches = endpoint.requests.filter((request) => !request.user.includes('atomic number of gold'))
      expect(batches).toHaveLength(2)
      for (const request of batches) {
        expect(request.extraBody).toEqual({ reasoning: { effort: 'none' } })
        expect(request.maxTokens).toBe(testReference().queryProfile.maxTokensPerRequest)
      }
      expect(result.evaluation.verdict).toBe('SAME')
    })

    it('gives an endpoint that thinks whatever it is told 50x the token budget', async () => {
      const endpoint = new FakeEndpoint()
      const answer = endpoint.call.bind(endpoint)
      // Thinks ~3,000 tokens before answering, whatever the request says: below that budget the
      // completion is empty, which the HTTP layer reports as a retryable failure with status 200.
      endpoint.call = async (request, signal) => {
        if (request.maxTokens < 4_000) {
          endpoint.requests.push(request)
          return { ok: false, status: 200, retryable: true, message: 'response has no completion text' }
        }
        if (request.user.includes('atomic number of gold')) {
          endpoint.requests.push(request)
          return answerDiscovery(request, 3_000)
        }
        return answer(request, signal)
      }
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20, concurrency: 1 })
      expect(result.thinkingDiscovery?.strategy).toBe('bare-expanded')
      expect(result.thinkingDiscovery?.attempts.map((attempt) => attempt.strategy)).toEqual([
        'reasoning-effort-none', 'reasoning-effort-minimal', 'disable-thinking', 'enable-thinking-false', 'prefill', 'bare', 'bare-expanded',
      ])
      // An empty reply is an answer with nothing parseable, sent once, not a failure retried three times.
      expect(result.thinkingDiscovery?.attempts.slice(0, 6).every((attempt) => attempt.validAnswers === 0)).toBe(true)
      expect(result.thinkingDiscovery?.maxTokens).toBe(40_000)
      const batches = endpoint.requests.filter((request) => !request.user.includes('atomic number of gold'))
      expect(batches.every((request) => request.maxTokens === 40_000 && request.extraBody === undefined)).toBe(true)
      expect(result.evaluation.verdict).toBe('SAME')
      expect(result.evaluation.stats.targetTotal).toBe(20)
    })

    it('skips the prefill strategy on endpoints that cannot carry it', async () => {
      const endpoint = Object.assign(new FakeEndpoint(), { supportsPrefill: false })
      const answer = endpoint.call.bind(endpoint)
      endpoint.call = async (request, signal) => request.user.includes('atomic number of gold') && request.maxTokens < 4_000
        ? (endpoint.requests.push(request), { ok: true as const, text: '', finishReason: 'length', raw: { request: new Uint8Array(), response: new Uint8Array(), status: 200 } })
        : answer(request, signal)
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 })
      expect(result.thinkingDiscovery?.attempts.map((attempt) => attempt.strategy)).not.toContain('prefill')
    })

    it('falls back to the reference suppression when the endpoint is down, after two strategies', async () => {
      const endpoint = new FakeEndpoint()
      const answer = endpoint.call.bind(endpoint)
      endpoint.call = async (request, signal) => request.user.includes('atomic number of gold')
        ? (endpoint.requests.push(request), { ok: false as const, status: 503, retryable: true, retryAfterMs: 0, message: 'HTTP 503: unavailable' })
        : answer(request, signal)
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 })
      expect(result.thinkingDiscovery?.strategy).toBeNull()
      expect(result.thinkingDiscovery?.failure).toMatch(/503/)
      expect(endpoint.requests.filter((request) => request.user.includes('atomic number of gold'))).toHaveLength(6)
      expect(result.evaluation.verdict).toBe('SAME')
    })

    it('keeps discovering after one strategy fails during a brief outage', async () => {
      const endpoint = new FakeEndpoint()
      const answer = endpoint.call.bind(endpoint)
      let discoveryCalls = 0
      endpoint.call = async (request, signal) => request.user.includes('atomic number of gold') && (discoveryCalls += 1) <= 3
        ? (endpoint.requests.push(request), { ok: false as const, status: 502, retryable: true, retryAfterMs: 0, message: 'HTTP 502: bad gateway' })
        : answer(request, signal)
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 })
      expect(result.thinkingDiscovery?.strategy).toBe('reasoning-effort-minimal')
      expect(result.evaluation.verdict).toBe('SAME')
    })

    it('ignores answers inside <think> blocks, as the reference code does', async () => {
      const endpoint = new FakeEndpoint()
      const answer = endpoint.call.bind(endpoint)
      endpoint.call = async (request, signal) => {
        const result = await answer(request, signal)
        if (!result.ok || request.user.includes('atomic number of gold')) return result
        return { ...result, text: `<think>${result.text.replace(/\) \d+/g, ') 99999')}</think>\n${result.text}` }
      }
      const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 20 })
      expect(result.evaluation.verdict).toBe('SAME')
      expect(result.evaluation.stats.targetHamming).toBe(0)
    })
  })
})
