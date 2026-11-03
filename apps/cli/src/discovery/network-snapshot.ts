import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AntseedNode, identityFromPrivateKeyHex, type PeerInfo } from '@antseed/node'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { buildPaymentsConfig } from '../cli/commands/network/chain-config-helper.js'
import { resolveEffectiveBuyerConfig } from '../config/effective.js'
import type { AntseedConfig } from '../config/types.js'
import { parsePersistedPeers } from '../proxy/buyer-proxy.js'
import { sharedChainProvider } from '../proxy/chain-rpc.js'
import { withRpcSource } from '../proxy/rpc-sources.js'

/**
 * The network as a buyer sees it, for `antseed network browse`, the seller
 * dashboard's market and trust views and their CLI commands: one
 * implementation, so they read the same thing the same way.
 */
export interface NetworkSnapshot {
  peers: PeerInfo[]
  /** Latest on-chain stats read among the peers, or null when none were read. */
  onChainStatsRefreshedAt: number | null
  sourceLabel: string
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Peers a buyer daemon last saw longer ago than this are not trusted as the network. */
export const BUYER_SNAPSHOT_MAX_AGE_MS = 15 * 60_000

/**
 * A live buyer daemon's persisted peer list (already enriched and scored, so
 * no chain reads at all). Null unless it is connected, its PID is alive and
 * it saw peers within `BUYER_SNAPSHOT_MAX_AGE_MS`: a recycled PID or an idle
 * daemon's old file never serves an old network.
 */
export async function loadBuyerSnapshot(dataDir: string): Promise<NetworkSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, 'buyer.state.json'), 'utf-8')) as { state?: unknown; pid?: unknown; onChainStatsRefreshedAt?: unknown }
    if (parsed.state !== 'connected' || typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null
    const peers = parsePersistedPeers(parsed, Date.now(), BUYER_SNAPSHOT_MAX_AGE_MS)
    if (peers.length === 0) return null
    const refreshedAt = typeof parsed.onChainStatsRefreshedAt === 'number' && Number.isFinite(parsed.onChainStatsRefreshedAt) ? parsed.onChainStatsRefreshedAt : null
    return { peers, onChainStatsRefreshedAt: refreshedAt, sourceLabel: `buyer daemon (pid ${parsed.pid})` }
  } catch {
    return null
  }
}

/**
 * One discovery pass with a short-lived buyer node (its own temporary identity), then stop. On-chain
 * enrichment reads go through the process's shared ChainRpcProvider (batched
 * into Multicall3: two round trips for every seller, plus one call per
 * delegated seller contract), tagged with `rpcSource`.
 */
export async function discoverNetwork(config: AntseedConfig, options: { serviceFilter?: string; rpcSource?: string } = {}): Promise<NetworkSnapshot> {
  const bootstrapNodes = config.network.bootstrapNodes.length > 0 ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes)) : undefined
  const payments = buildPaymentsConfig(config.payments?.crypto)
  const readProvider = payments?.rpcUrl && payments.chainId
    ? sharedChainProvider({ rpcUrl: payments.rpcUrl, evmChainId: payments.chainId, ...(payments.fallbackRpcUrls ? { fallbackRpcUrls: payments.fallbackRpcUrls } : {}) })
    : undefined
  // A throwaway identity and data dir: never the operator's key or a running seller's peer id and databases.
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-discovery-'))
  try {
    const node = new AntseedNode({
      role: 'buyer',
      dataDir,
      identity: identityFromPrivateKeyHex(randomBytes(32).toString('hex')),
      ...(bootstrapNodes ? { bootstrapNodes } : {}),
      dhtOperationTimeoutMs: 30_000,
      metadataFetchTimeoutMs: resolveEffectiveBuyerConfig({ config }).metadataFetchTimeoutMs,
      ...(payments ? { payments: { ...payments, ...(readProvider ? { readProvider } : {}) } } : {}),
    })
    return await withRpcSource(options.rpcSource ?? 'discovery', async () => {
      try {
        // Inside the try: a start that fails partway is still stopped (the node releases what it opened).
        await node.start()
        const peers = await node.discoverPeers(options.serviceFilter)
        // Only stamp a refresh time when enrichment could have run, from the per-peer read times.
        const latest = peers.map((peer) => peer.onChainStatsFetchedAt ?? 0).reduce((max, value) => (value > max ? value : max), 0)
        return { peers, onChainStatsRefreshedAt: latest > 0 ? latest : null, sourceLabel: 'live DHT discovery' }
      } finally {
        await node.stop().catch(() => {})
      }
    })
  } finally {
    // Also when the node could not be built (a bad buyer setting): no temp dir is left behind.
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}
