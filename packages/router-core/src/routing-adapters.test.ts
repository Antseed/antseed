import { describe, expect, it, vi } from 'vitest'
import { createRoutingServiceMetadata, type PeerInfo, type ModelRouterAdapter, type RoutingUsageObservation } from '@antseed/node'
import { ModelRouterRegistry } from './routing-adapters.js'

const target = { peerId: 'a'.repeat(40), provider: 'router-provider', serviceId: 'route' }
const peer = {
  peerId: target.peerId,
  metadata: { providers: [{ provider: target.provider, services: [target.serviceId],
    serviceApiProtocols: { route: ['levanto-routing'] },
  }] },
} as PeerInfo

function adapter(): ModelRouterAdapter {
  return {
    routingMetadata: createRoutingServiceMetadata({ type: 'object', additionalProperties: false, properties: {} }),
    selectRoute: vi.fn(async () => []), recordUsage: vi.fn(),
  }
}

describe('ModelRouterRegistry', () => {
  it('rejects partial cached metadata until signed provider announcements are rediscovered', () => {
    const registry = new ModelRouterRegistry()
    const levanto = adapter()
    registry.register('levanto-routing', levanto)
    const cached = { ...peer, metadata: { capabilities: ['transport.webrtc.v1'] } } as PeerInfo
    expect(() => registry.resolve(target, [cached])).toThrow('Selected router metadata is not available yet')
    cached.metadata = structuredClone(peer.metadata)
    expect(registry.resolve(target, [cached])).toBe(levanto)
  })

  it('selects by the exact peer, provider, service and advertised protocol', () => {
    const registry = new ModelRouterRegistry()
    const levanto = adapter()
    const other = adapter()
    registry.register('levanto-routing', levanto)
    registry.register('openai-responses', other)
    const combined = structuredClone(peer)
    combined.metadata!.providers.push({ ...combined.metadata!.providers[0]!, provider: 'other-provider',
      serviceApiProtocols: { route: ['openai-responses'] },
    })
    expect(registry.resolve(target, [combined])).toBe(levanto)
    expect(registry.resolve({ ...target, provider: 'other-provider' }, [combined])).toBe(other)
    for (const wrong of [{ ...target, peerId: 'b'.repeat(40) }, { ...target, provider: 'missing' }, { ...target, serviceId: 'missing' }]) {
      expect(() => registry.resolve(wrong, [combined])).toThrow('not advertised')
    }
  })

  it('rejects unknown and ambiguous protocols instead of falling back to Levanto', () => {
    const registry = new ModelRouterRegistry()
    registry.register('openai-responses', adapter())
    expect(() => registry.resolve(target, [peer])).toThrow('No registered adapter')
    registry.register('levanto-routing', adapter())
    const ambiguous = structuredClone(peer)
    ambiguous.metadata!.providers[0]!.serviceApiProtocols!.route = ['levanto-routing', 'openai-responses']
    expect(() => registry.resolve(target, [ambiguous])).toThrow('multiple registered')
  })

  it('rejects duplicate registrations and invalid schemas', () => {
    const registry = new ModelRouterRegistry()
    registry.register('levanto-routing', adapter())
    expect(() => registry.register('levanto-routing', adapter())).toThrow('already registered')
    expect(() => registry.register(' ', adapter())).toThrow('Invalid routing protocol')
    const invalid = adapter()
    invalid.routingMetadata.preferencesSchemaHash = 'invalid'
    expect(() => registry.register('openai-responses', invalid)).toThrow()
  })

  it('shares isolated inference observations with each adapter', () => {
    const registry = new ModelRouterRegistry()
    const first = adapter()
    const second = adapter()
    first.recordUsage = vi.fn(observation => { observation.inputTokens = 999 })
    registry.register('levanto-routing', first)
    registry.register('openai-responses', second)
    const observation: RoutingUsageObservation = {
      conversationKey: 'chat', requestId: 'request', peerId: 'b'.repeat(40), provider: 'openai', serviceId: 'model',
      inputTokens: 100, cachedInputTokens: 50,
    }
    registry.recordUsage(observation)
    expect(second.recordUsage).toHaveBeenCalledWith(observation)
    expect(observation.inputTokens).toBe(100)
  })
})
