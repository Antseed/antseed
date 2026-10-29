import { loadConfig } from '../config/loader.js'
import { discoverNetwork, loadBuyerSnapshot } from '../discovery/network-snapshot.js'

/** One seller as the buyer's `GET /_antseed/peers` lists it (or a discovered PeerInfo in the same shape). */
export type PeerRow = Record<string, unknown>

export interface NetworkLoad {
  rows: PeerRow[]
  source: string
}

/** How long a network snapshot is reused before a background refresh. */
export const NETWORK_SNAPSHOT_TTL_MS = 15 * 60_000

/**
 * Seller-only mode has no buyer to ask: use a buyer daemon on the same data
 * directory (no chain reads at all), else one discovery pass with a
 * short-lived buyer node, the same one `antseed network browse` runs.
 */
export function sellerOnlyNetworkLoader(options: { dataDir: string; configPath: string }): () => Promise<NetworkLoad> {
  return async () => {
    const snapshot = await loadBuyerSnapshot(options.dataDir)
      ?? await discoverNetwork(await loadConfig(options.configPath), { rpcSource: 'seller-network' })
    return { rows: JSON.parse(JSON.stringify(snapshot.peers)) as PeerRow[], source: snapshot.sourceLabel }
  }
}
