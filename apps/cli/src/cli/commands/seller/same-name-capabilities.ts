import type { Provider, ServiceCapabilities } from '@antseed/node'

type CapabilityMap = Record<string, ServiceCapabilities>

export interface InitializedProvider {
  provider: Provider
  /** The provider's capabilities before `init()`, from {@link capabilitiesBeforeInit}. */
  before: CapabilityMap | undefined
}

/** A copy of a provider's capabilities, taken before `init()` can fill some from its upstream. */
export function capabilitiesBeforeInit(provider: Provider): CapabilityMap | undefined {
  return provider.serviceCapabilities ? structuredClone(provider.serviceCapabilities) : undefined
}

/**
 * Providers that share a name must announce a service they both offer with the
 * same capabilities, or the node refuses to start. A plugin can fill
 * capabilities from its upstream at `init()`, and two upstreams can answer
 * differently (one publishes a list, the other fails or publishes none). For each
 * shared service whose capabilities agreed before `init()` and differ after it,
 * this puts back what every provider involved had before, in place.
 *
 * Returns one warning line per provider name it changed.
 */
export function restoreDivergedCapabilities(entries: readonly InitializedProvider[]): string[] {
  const shared = new Map<string, { name: string; service: string; members: InitializedProvider[] }>()
  for (const entry of entries) {
    for (const service of entry.provider.services) {
      const key = `${entry.provider.name.toLowerCase()}\u0000${service}`
      const group = shared.get(key) ?? { name: entry.provider.name, service, members: [] }
      group.members.push(entry)
      shared.set(key, group)
    }
  }

  const restored = new Map<string, { name: string; services: string[] }>()
  for (const { name, service, members } of shared.values()) {
    if (members.length < 2) continue
    const before = new Set(members.map((member) => canonicalJson(member.before?.[service] ?? null)))
    const after = new Set(members.map((member) => canonicalJson(member.provider.serviceCapabilities?.[service] ?? null)))
    if (before.size !== 1 || after.size === 1) continue
    for (const member of members) {
      const capabilities = member.provider.serviceCapabilities
      if (!capabilities) continue
      const prior = member.before?.[service]
      if (prior === undefined) delete capabilities[service]
      else capabilities[service] = structuredClone(prior)
    }
    const key = name.toLowerCase()
    const entry = restored.get(key) ?? { name, services: [] }
    entry.services.push(service)
    restored.set(key, entry)
  }

  return [...restored.values()].map(({ name, services }) =>
    `Providers named "${name}" read different capabilities from their upstreams for ${services.join(', ')}; announcing the configured capabilities for all of them`,
  )
}

/** JSON with object keys sorted, so equal values compare equal (as the node compares them). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
