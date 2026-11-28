import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Provider, ServiceCapabilities } from '@antseed/node'
import { capabilitiesBeforeInit, restoreDivergedCapabilities, type InitializedProvider } from './same-name-capabilities.js'

// The node's own start check, which refuses same-name providers that disagree on a shared service.
// It is internal to @antseed/node, so the test loads it from the workspace build.
const { assertSameNameUpstreamsAgree } = await import(
  new URL('../../../../../../packages/node/dist/seller-request-handler.js', import.meta.url).href
) as { assertSameNameUpstreamsAgree: (providers: readonly Provider[]) => void }

/** A provider whose `init()` fills capabilities in place, as a plugin does from its upstream. */
function makeProvider(
  name: string,
  configured: Record<string, ServiceCapabilities> | undefined,
  fill: (capabilities: Record<string, ServiceCapabilities>) => void,
): Provider {
  const serviceCapabilities = configured ?? {}
  return {
    name,
    services: ['m', 'other'],
    maxConcurrency: 1,
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    serviceCapabilities,
    async init() {
      fill(serviceCapabilities)
    },
    getCapacity: () => ({ current: 0, max: 1 }),
    async handleRequest(request) {
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
    },
  }
}

async function startProviders(providers: Provider[]): Promise<{ entries: InitializedProvider[]; warnings: string[] }> {
  const entries = providers.map((provider) => ({ provider, before: capabilitiesBeforeInit(provider) }))
  for (const provider of providers) await provider.init?.()
  return { entries, warnings: restoreDivergedCapabilities(entries) }
}

const filled: ServiceCapabilities = { reasoning: true, reasoningEfforts: ['low', 'high'] }

describe('same-name providers whose upstreams fill capabilities differently', () => {
  it('announces the configured capabilities on both, so the start is not refused', async () => {
    const configured = { m: { contextWindow: 64000 }, other: { contextWindow: 32000 } }
    // One upstream publishes levels for `m`; the other fails, so its provider fills nothing.
    const a = makeProvider('openai', structuredClone(configured), (caps) => {
      caps.m = { ...caps.m, ...filled }
    })
    const b = makeProvider('openai', structuredClone(configured), () => {})

    const entries = [a, b].map((provider) => ({ provider, before: capabilitiesBeforeInit(provider) }))
    await a.init?.()
    await b.init?.()
    // Without the restore, the node refuses this start.
    assert.throws(() => assertSameNameUpstreamsAgree([a, b]), /sharing the name "openai" offer "m"/)

    const warnings = restoreDivergedCapabilities(entries)
    assert.doesNotThrow(() => assertSameNameUpstreamsAgree([a, b]))
    assert.deepEqual(a.serviceCapabilities, configured)
    assert.deepEqual(b.serviceCapabilities, configured)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /^Providers named "openai" read different capabilities from their upstreams for m;/)
  })

  it('removes a filled entry the seller never configured', async () => {
    const a = makeProvider('OpenAI', undefined, (caps) => {
      caps.m = { ...filled }
    })
    const b = makeProvider('openai', undefined, () => {})
    const { warnings } = await startProviders([a, b])
    assert.deepEqual(a.serviceCapabilities, {})
    assert.deepEqual(b.serviceCapabilities, {})
    assert.doesNotThrow(() => assertSameNameUpstreamsAgree([a, b]))
    assert.equal(warnings.length, 1)
  })

  it('keeps fills that agree, a lone provider\'s fill and different names', async () => {
    const same = [
      makeProvider('openai', undefined, (caps) => { caps.m = { ...filled } }),
      makeProvider('openai', undefined, (caps) => { caps.m = { ...filled } }),
    ]
    const lone = makeProvider('local-llm', undefined, (caps) => { caps.m = { ...filled } })
    const { warnings } = await startProviders([...same, lone])
    assert.deepEqual(warnings, [])
    for (const provider of [...same, lone]) assert.deepEqual(provider.serviceCapabilities, { m: filled })
  })

  it('leaves capabilities that already disagreed before init for the node to refuse', async () => {
    const a = makeProvider('openai', { m: { contextWindow: 64000 } }, (caps) => { caps.m = { ...caps.m, ...filled } })
    const b = makeProvider('openai', { m: { contextWindow: 32000 } }, () => {})
    const { warnings } = await startProviders([a, b])
    assert.deepEqual(warnings, [])
    assert.deepEqual(a.serviceCapabilities, { m: { contextWindow: 64000, ...filled } })
    assert.throws(() => assertSameNameUpstreamsAgree([a, b]))
  })
})
