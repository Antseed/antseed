import { randomUUID } from 'node:crypto'
import { QueryClient } from '@tanstack/query-core'
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS, TEE_VERIFIER_ID, type TeeEvidence, type TeeSnapshot } from '@antseed/node/tee-status'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { selectVerifier, verifierSupportFingerprint, type VerifierPolicy, type VerifyOutcome } from '../plugins/verifier.js'

type Peer = { peerId: string; capabilities?: string[] }
type Entry = { outcome?: Omit<VerifyOutcome, 'ok'>; checkedAt: number }

export class TeeVerification {
  readonly sessionId = randomUUID()
  private readonly queries = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity, structuralSharing: false } },
  })
  private closed = false
  private activeChecks = 0

  constructor(readonly policy: VerifierPolicy | undefined, private readonly now = Date.now) {}

  async verify(peer: Peer, policy: VerifierPolicy, run: () => Promise<VerifyOutcome>, force = false): Promise<VerifyOutcome> {
    return this.verifyCached(peer, policy, run, TEE_MAX_AGE_MS, force)
  }

  async verifyForDisplay(peer: Peer, run: () => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
    return this.verifyCached(peer,
      { require: true, prefer: [TEE_VERIFIER_ID] }, run, TEE_BADGE_MAX_AGE_MS, false, true)
  }

  private cacheExpiry(entry: Entry, maxAgeMs: number): number {
    return entry.outcome?.sellerNodeVerified && !entry.outcome.transient
      ? entry.checkedAt + maxAgeMs : entry.checkedAt + TEE_MAX_AGE_MS
  }

  private async verifyCached(peer: Peer, policy: VerifierPolicy, run: () => Promise<VerifyOutcome>, maxAgeMs: number, force = false, requireSellerNode = false): Promise<VerifyOutcome> {
    if (this.closed) return { ok: false, verified: false, reason: 'Buyer stopped', transient: true }
    const chosen = selectVerifier(policy, parseVerifierCapabilities(peer.capabilities))
    const fingerprint = verifierSupportFingerprint(peer.capabilities)
    const queryKey = [peer.peerId, chosen ?? '', fingerprint] as const
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
    if (!pending && !force && entry?.outcome && !entry.outcome.transient && this.cacheExpiry(entry, maxAgeMs) > this.now()) return allow(entry.outcome)
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
          return { checkedAt, outcome }
        } catch (error: unknown) {
          return { checkedAt, outcome: {
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
