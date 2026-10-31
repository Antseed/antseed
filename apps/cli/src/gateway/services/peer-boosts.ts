/**
 * Antseed Points boost per seller, for the console's provider list. Read from
 * Antscan's pool powers (cached by `createBoostLookup`); display only, routing
 * never sees it.
 */
import { createBoostLookup, resolveAntsChain, type BoostBySeller } from '@antseed/ants'

/** How long the peer list waits for Antscan before answering without boosts. */
const BOOST_BUDGET_MS = 2_500

export type PeerBoostSource = () => Promise<BoostBySeller | null>

/** Boosts from the explorer of the chain the gateway's config selects; one cached lookup per explorer. */
export function antscanPeerBoosts(configPath: string): PeerBoostSource {
  const lookups = new Map<string, PeerBoostSource>()
  return async () => {
    const { explorerApiUrl = '' } = await resolveAntsChain(configPath)
    let lookup = lookups.get(explorerApiUrl)
    if (!lookup) {
      lookup = createBoostLookup(explorerApiUrl)
      lookups.set(explorerApiUrl, lookup)
    }
    return lookup()
  }
}

/** The boosts if they arrive within the budget; null otherwise (a slow read still fills the cache). */
export async function readPeerBoosts(source: PeerBoostSource | undefined): Promise<BoostBySeller | null> {
  if (!source) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BOOST_BUDGET_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([source().catch(() => null), budget])
  } finally {
    clearTimeout(timer)
  }
}
