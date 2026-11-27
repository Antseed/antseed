import { randomUUID } from 'node:crypto'
import { QueryClient } from '@tanstack/query-core'
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS, TEE_VERIFIER_ID, teeScope, type TeeEvidence, type TeeScope, type TeeSnapshot } from '@antseed/node/tee-status'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { selectVerifier, verifierSupportFingerprint, type VerifierPolicy, type VerifyOutcome } from '../plugins/verifier.js'

type Peer = { peerId: string; capabilities?: string[] }
type Entry = { outcome?: Omit<VerifyOutcome, 'ok'>; checkedAt: number; failures?: number; expiresAt?: number }

const TEE_FAILURE_MAX_AGE_MS = 6 * 60 * 60 * 1_000

export class TeeVerification {
  readonly sessionId = randomUUID()
  private readonly queries = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity, structuralSharing: false } },
  })
  private closed = false
  private activeChecks = 0

  constructor(readonly policy: VerifierPolicy | undefined, private readonly now = Date.now, private readonly random = Math.random) {}

  /** `buyerIdentity` keeps a verdict to the connection of the identity that checked it. */
  async verify(peer: Peer, policy: VerifierPolicy, run: () => Promise<VerifyOutcome>, force = false, buyerIdentity?: string): Promise<VerifyOutcome> {
    return this.verifyCached(peer, policy, run, { maxAgeMs: TEE_MAX_AGE_MS, force, ...(buyerIdentity ? { buyerIdentity } : {}) })
  }

  async verifyForDisplay(peer: Peer, run: () => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
    return this.verifyCached(peer,
      { require: true, prefer: [TEE_VERIFIER_ID] }, run, { maxAgeMs: TEE_BADGE_MAX_AGE_MS, requireSellerNode: true })
  }

  private cacheExpiry(entry: Entry, maxAgeMs: number): number {
    const age = entry.outcome?.sellerNodeVerified && !entry.outcome.transient ? maxAgeMs : TEE_MAX_AGE_MS
    return entry.expiresAt ?? entry.checkedAt + age
  }

  private async verifyCached(
    peer: Peer,
    policy: VerifierPolicy,
    run: () => Promise<VerifyOutcome>,
    { maxAgeMs, force = false, requireSellerNode = false, buyerIdentity }: {
      maxAgeMs: number
      force?: boolean
      /** Pass only on a seller-node TEE attestation (the display badge), not any verifier's verdict. */
      requireSellerNode?: boolean
      buyerIdentity?: string
    },
  ): Promise<VerifyOutcome> {
    if (this.closed) return { ok: false, verified: false, reason: 'Buyer stopped', transient: true }
    const chosen = selectVerifier(policy, parseVerifierCapabilities(peer.capabilities))
    const fingerprint = verifierSupportFingerprint(peer.capabilities)
    const queryKey = buyerIdentity ? [peer.peerId, chosen ?? '', fingerprint, buyerIdentity] : [peer.peerId, chosen ?? '', fingerprint]
    const cache = this.queries.getQueryCache()
    for (const query of cache.findAll({ queryKey: [peer.peerId] })) {
      if (query.queryKey[2] !== fingerprint) cache.remove(query)
    }
    const previous = cache.find<Entry>({ queryKey, exact: true })
    const pending = previous?.state.fetchStatus === 'fetching'
    const allow = (outcome: Omit<VerifyOutcome, 'ok'>): VerifyOutcome => ({
      ...outcome, ok: !policy.require || (requireSellerNode ? outcome.sellerNodeVerified === true : outcome.verified),
    })
    const entry = previous?.state.data
    // A pass that a newer failure (another identity's check) has overtaken is
    // not reused: the seller is checked again before it counts.
    const overtaken = entry?.outcome?.verified === true
      && cache.findAll({ queryKey: [peer.peerId, chosen ?? '', fingerprint] }).some((other) => {
        const verdict = other.state.data as Entry | undefined
        return Boolean(verdict?.outcome && !verdict.outcome.transient && !verdict.outcome.verified && verdict.checkedAt > entry.checkedAt)
      })
    if (!pending && !force && !overtaken && entry?.outcome && !entry.outcome.transient && this.cacheExpiry(entry, maxAgeMs) > this.now()) return allow(entry.outcome)
    if (!pending && this.activeChecks >= 8) {
      return { ok: !policy.require, verified: false, transient: true, code: 'busy', reason: 'Verification busy; retry shortly' }
    }
    if (!previous && cache.getAll().length >= 512) {
      const oldest = cache.getAll().find((query) => query.state.fetchStatus === 'idle')
      if (oldest) cache.remove(oldest)
    }
    const checkedAt = pending ? Number(previous.meta?.checkedAt) : this.now()
    const options = {
      queryKey, staleTime: 0, meta: { checkedAt },
      queryFn: async (): Promise<Entry> => {
        this.activeChecks += 1
        try {
          const { ok: _allowed, ...outcome } = await Promise.resolve().then(run)
          if (outcome.transient) return { checkedAt, outcome, failures: entry?.failures }
          if (chosen !== TEE_VERIFIER_ID || outcome.verified === true) return { checkedAt, outcome }
          const failures = (entry?.failures ?? 0) + 1
          const jitter = failures === 1 ? 1 : 1 + (this.random() - 0.5) * 0.4
          const delay = Math.round(Math.min(TEE_MAX_AGE_MS * 2 ** (failures - 1) * jitter, TEE_FAILURE_MAX_AGE_MS))
          return { checkedAt, outcome, failures, expiresAt: checkedAt + delay }
        } catch (error: unknown) {
          return { checkedAt, failures: entry?.failures, outcome: {
            verified: false, transient: true, reason: error instanceof Error ? error.message : 'Verification unavailable',
          } }
        } finally {
          this.activeChecks -= 1
        }
      },
    }
    const resultPromise = this.queries.fetchQuery(options)
    const query = cache.find<Entry>({ queryKey, exact: true })
    try {
      const result = await resultPromise
      if (!this.closed && cache.find<Entry>({ queryKey, exact: true }) === query && result.outcome) return allow(result.outcome)
    } catch {
      return { ok: !policy.require && !this.closed, verified: false, transient: true, reason: 'Verification session or seller capabilities changed' }
    }
    return { ok: !policy.require && !this.closed, verified: false, transient: true, reason: 'Verification session or seller capabilities changed' }
  }

  /**
   * The reason from the newest in-date failure after the latest seller-node pass.
   * A seller that advertises the TEE verifier but fails it (an unapproved
   * build) is not one Private can send to.
   */
  teeFailure(peer: Peer): string | null {
    const now = this.now()
    let latestPassAt = -Infinity
    let newestFailure: Entry | undefined
    for (const query of this.teeQueries(peer)) {
      if (query.state.fetchStatus === 'fetching') continue
      const entry = query.state.data as Entry | undefined
      if (!entry?.outcome || entry.outcome.transient) continue
      if (entry.outcome.sellerNodeVerified) {
        latestPassAt = Math.max(latestPassAt, entry.checkedAt)
      } else if ((!newestFailure || entry.checkedAt > newestFailure.checkedAt) && this.cacheExpiry(entry, TEE_MAX_AGE_MS) > now) {
        newestFailure = entry
      }
    }
    if (!newestFailure || newestFailure.checkedAt <= latestPassAt) return null
    return newestFailure.outcome?.reason ?? 'TEE attestation did not pass'
  }

  /**
   * How far the seller's TEE reaches, from its newest settled attestation
   * still in date, when that one passed: `end-to-end` when its model provider
   * is attested too, `seller-node` when only the seller is. Null until a
   * check passes (or when none can run): advertising the TEE verifier is only
   * a claim. A newer failure ends it, even once that failure is past its
   * date: only a pass checked after it brings the scope back.
   */
  teeProvenScope(peer: Peer): TeeScope | null {
    // A check being re-run keeps its last verdict, so the badge doesn't flicker.
    const newest = this.newestSettledCheck(peer, { skipRefetching: false })
    if (newest?.outcome?.sellerNodeVerified !== true || this.cacheExpiry(newest, TEE_BADGE_MAX_AGE_MS) <= this.now()) return null
    return teeScope({ claims: newest.outcome.claims ?? [] }) === 'end-to-end' ? 'end-to-end' : 'seller-node'
  }

  /**
   * The newest check with a verdict (not a transient error), across the
   * per-identity checks for the seller's current capabilities, whether or not
   * it is still in date. Both the failure and the scope follow it, so they
   * agree, and an expired newer verdict never lets an older one back: the
   * caller treats it as no verdict until the seller is checked again.
   */
  private newestSettledCheck(peer: Peer, options: { skipRefetching: boolean }): Entry | null {
    let newest: Entry | null = null
    for (const query of this.teeQueries(peer)) {
      const entry = query.state.data as Entry | undefined
      if (options.skipRefetching && query.state.fetchStatus === 'fetching') continue
      if (!entry?.outcome || entry.outcome.transient) continue
      if (!newest || entry.checkedAt > newest.checkedAt) newest = entry
    }
    return newest
  }

  /** The cached TEE checks for the seller's current capabilities. */
  private teeQueries(peer: Peer) {
    const fingerprint = verifierSupportFingerprint(peer.capabilities)
    return this.queries.getQueryCache().findAll({ queryKey: [peer.peerId, TEE_VERIFIER_ID, fingerprint] })
  }

  observePeers(peers: readonly Peer[]): void {
    const fingerprints = new Map(peers.map((peer) => [peer.peerId, verifierSupportFingerprint(peer.capabilities)]))
    for (const query of this.queries.getQueryCache().getAll()) {
      if (fingerprints.get(String(query.queryKey[0])) !== query.queryKey[2]) this.queries.getQueryCache().remove(query)
    }
  }

  snapshot(peers: readonly Peer[]): TeeSnapshot {
    const evidence: TeeEvidence[] = []
    this.observePeers(peers)
    for (const peer of peers) {
      if (!parseVerifierCapabilities(peer.capabilities).supported.includes(TEE_VERIFIER_ID)) continue
      const fingerprint = verifierSupportFingerprint(peer.capabilities)
      const query = this.queries.getQueryCache().find<Entry>({ queryKey: [peer.peerId, TEE_VERIFIER_ID, fingerprint], exact: true })
      if (!query) continue
      const checking = query.state.fetchStatus === 'fetching'
      const entry = checking ? { checkedAt: Number(query.meta?.checkedAt) } : query.state.data
      if (!entry) continue
      evidence.push({
        peerId: peer.peerId, verifierId: TEE_VERIFIER_ID, verifierVersion: entry.outcome?.version,
        fingerprint, checkedAt: entry.checkedAt, expiresAt: checking ? 0 : this.cacheExpiry(entry, TEE_BADGE_MAX_AGE_MS),
        sellerNodeVerified: entry.outcome?.sellerNodeVerified === true,
        claims: entry.outcome?.claims ?? [], reason: entry.outcome?.reason,
        checking,
        unavailable: entry.outcome?.transient === true,
      })
    }
    return {
      sessionId: this.sessionId,
      verificationEnabled: Boolean(this.policy),
      evidence,
    }
  }

  close(): void {
    this.closed = true
    this.queries.clear()
  }
}
