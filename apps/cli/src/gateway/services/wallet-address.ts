/**
 * Which wallet a workspace pays from. The running buyer is the source of
 * truth: it may hold a key the gateway process cannot see on disk (the
 * desktop app hands it the default wallet in ANTSEED_IDENTITY_HEX). The
 * address cached on the workspace row is for display only and is corrected
 * from the buyer whenever the two differ.
 */
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityAddress, hasDesktopIdentity, loadDefaultBuyerIdentity } from '../../buyer-identities/store.js'
import { buyerFetch } from '../buyer-control.js'
import { ConsoleError } from '../console-api/router.js'
import type { GatewayStore, WorkspaceRecord } from '../store.js'

/** Identity name → wallet address as the running buyer pays; null when the buyer cannot be reached. */
export type BuyerAddressBook = () => Promise<Map<string, string> | null>

const LIVE_TTL_MS = 2_000
const liveCache = new Map<string, { at: number; value: Promise<Map<string, string> | null> }>()

/** The running buyer's identities (`GET /_antseed/buyer-identities`), cached for two seconds. */
export function liveBuyerAddresses(buyerPort: number, secret?: string | null): Promise<Map<string, string> | null> {
  const key = String(buyerPort)
  const cached = liveCache.get(key)
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.value
  const value = (async () => {
    try {
      const response = secret
        ? await buyerFetch({ buyerPort, secret, timeoutMs: 3_000 }, '/_antseed/buyer-identities')
        : await fetch(`http://127.0.0.1:${buyerPort}/_antseed/buyer-identities`, { signal: AbortSignal.timeout(3_000) })
      if (!response.ok) return null
      const body = await response.json() as { identities?: Array<{ name?: unknown; address?: unknown }> }
      if (!Array.isArray(body.identities)) return null
      const book = new Map<string, string>()
      for (const entry of body.identities) {
        if (typeof entry.name === 'string' && typeof entry.address === 'string') book.set(entry.name, entry.address)
      }
      return book
    } catch {
      return null
    }
  })()
  liveCache.set(key, { at: Date.now(), value })
  return value
}

export function buyerAddressBook(buyerPort: number, secret?: string | null): BuyerAddressBook {
  return () => liveBuyerAddresses(buyerPort, secret)
}

export interface ResolvedWalletAddress {
  address: string | null
  /** live: the running buyer said so. disk: read from the identity's key here (the buyer is down or does not have it). unknown: neither. */
  source: 'live' | 'disk' | 'unknown'
  /** Why the address is unknown, for display. */
  note?: string
}

export const BUYER_NOT_RUNNING = 'unknown (buyer not running)'

/**
 * The identity's address: from the running buyer, else from its key here
 * (the default identity honouring ANTSEED_IDENTITY_HEX as the buyer does).
 * A desktop-style data dir without that variable cannot say which wallet
 * the buyer uses, so it is unknown rather than guessed from identity.key.
 */
export async function resolveIdentityAddress(dataDir: string, live: BuyerAddressBook | null, name: string): Promise<ResolvedWalletAddress> {
  const book = live ? await live().catch(() => null) : null
  const fromBuyer = book?.get(name)
  if (fromBuyer) return { address: fromBuyer, source: 'live' }
  if (name === DEFAULT_BUYER_IDENTITY) {
    const loaded = await loadDefaultBuyerIdentity(dataDir).catch(() => null)
    if (!book && !loaded?.fromEnv && await hasDesktopIdentity(dataDir)) {
      return { address: null, source: 'unknown', note: BUYER_NOT_RUNNING }
    }
    const address = loaded?.identity?.wallet.address ?? null
    return address ? { address, source: 'disk' } : { address: null, source: 'unknown', note: book ? 'not loaded by the buyer' : BUYER_NOT_RUNNING }
  }
  const address = await buyerIdentityAddress(dataDir, name)
  return address ? { address, source: 'disk' } : { address: null, source: 'unknown', note: book ? 'not loaded by the buyer' : BUYER_NOT_RUNNING }
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

const warned = new Set<string>()

/**
 * Keeps the display cache in line with what was resolved: an address from
 * the buyer replaces a different cached one (warned once); one read from
 * disk only fills an empty cache, since the buyer may be using another key.
 */
export function syncWalletCache(
  store: GatewayStore,
  workspace: WorkspaceRecord,
  resolved: ResolvedWalletAddress,
  warn: (message: string) => void,
): void {
  const cached = workspace.walletAddress
  if (!resolved.address || sameAddress(cached, resolved.address)) return
  if (resolved.source === 'live') {
    if (cached) {
      const key = `${workspace.id}:${cached}:${resolved.address}`.toLowerCase()
      if (!warned.has(key)) {
        warned.add(key)
        warn(`workspace ${workspace.name} (${workspace.id}) wallet changed from ${cached} to ${resolved.address}`)
      }
    }
    store.setWalletAddress(workspace.buyerIdentity, resolved.address)
  } else if (resolved.source === 'disk' && !cached) {
    store.setWalletAddress(workspace.buyerIdentity, resolved.address)
  }
}

/**
 * Signing guard: the key loaded for an identity must be the one the running
 * buyer pays from, so nothing is signed for a wallet the workspace does not
 * use. Throws 409 `wallet_mismatch` naming both addresses. When the buyer
 * cannot be reached the key is trusted (it was loaded as the buyer would).
 */
export async function assertSignerMatchesBuyer(live: BuyerAddressBook | null, name: string, signingAddress: string): Promise<void> {
  const book = live ? await live().catch(() => null) : null
  const buyerAddress = book?.get(name)
  if (buyerAddress && !sameAddress(buyerAddress, signingAddress)) throw walletMismatch(name, signingAddress, buyerAddress)
}

export function walletMismatch(name: string, signingAddress: string, buyerAddress: string): ConsoleError {
  return new ConsoleError(409, 'wallet_mismatch',
    `The key this gateway holds for buyer identity "${name}" is wallet ${signingAddress}, but the running buyer pays from ${buyerAddress}. Nothing was signed. Run the gateway with the same key as the buyer (e.g. the same ANTSEED_IDENTITY_HEX).`,
    { signingAddress, buyerAddress })
}

/** For tests: forget cached buyer answers. */
export function clearLiveBuyerAddressCache(): void {
  liveCache.clear()
}
