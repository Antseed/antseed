import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { ModelBatchRequest, ModelCallResult, ModelEndpoint } from '../src/endpoint.js'

export function testReference(probeCount = 200): KbfReferenceV1 {
  const probes = Array.from({ length: probeCount }, (_unused, index) => ({
    id: `p-${index}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 10_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0.1 },
  }))
  const runs = 3
  const power = computeBinomialPower({
    selfHamming: 0,
    selfTotal: probeCount * runs,
    probeCount,
    minimumMismatchDelta: 0.1,
  })
  const value: KbfReferenceV1 = {
    version: 2,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'open-model-70b',
    serviceAliases: ['open-model-70b'],
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'open-model-70b' }),
    selfTest: {
      hamming: 0,
      total: probeCount * runs,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({
        probeId: probe.id,
        answers: Array.from({ length: runs }, () => probe.consensus),
        matches: Array.from({ length: runs }, () => 1 as const),
      })),
    },
    probes,
    selectedProbeCount: probeCount,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probeCount * runs,
      probeCount,
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

/** Answers every probe line in the prompt; `wrong(probeIndex)` decides which answers are off. */
export class FakeEndpoint implements ModelEndpoint {
  readonly label = 'fake://endpoint'
  readonly requests: ModelBatchRequest[] = []

  constructor(
    private readonly wrong: (probeIndex: number) => boolean = () => false,
    private readonly fail: (callIndex: number) => boolean = () => false,
  ) {}

  async call(request: ModelBatchRequest): Promise<ModelCallResult> {
    const callIndex = this.requests.push(request) - 1
    if (this.fail(callIndex)) return { ok: false, status: 503, retryable: false, message: 'unavailable' }
    const lines: string[] = []
    for (const line of request.user.split('\n')) {
      const match = /^\W*Q?(\d+)\W+Probe (\d+) is/i.exec(line)
      if (!match) continue
      const probeIndex = Number(match[2])
      lines.push(`(${match[1]}) ${this.wrong(probeIndex) ? probeIndex + 7 : probeIndex}`)
    }
    const text = lines.join('\n')
    return {
      ok: true,
      text,
      finishReason: 'stop',
      raw: { request: new TextEncoder().encode(request.user), response: new TextEncoder().encode(text), status: 200 },
    }
  }
}
