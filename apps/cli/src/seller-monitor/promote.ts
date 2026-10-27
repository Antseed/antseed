import {
  buildDomainVerificationTxtValue,
  buildDomainVerificationWellKnownProof,
  buildGithubVerificationProof,
  buildGithubVerificationProofUrl,
  DOMAIN_VERIFICATION_TXT_NAME_PREFIX,
  DOMAIN_VERIFICATION_WELL_KNOWN_PATH,
  verifyDomainVerificationClaim,
  verifyGithubVerificationClaim,
} from '@antseed/node'
import type { SellerPromote, SellerServicePricing, SellerVerificationStatus } from '../gateway/console-api/types.js'
import { peerKey } from './market.js'
import { bad, configWritable, patchSellerConfig, readRaw } from './settings.js'
import { serviceKind } from './unit-price.js'

type Verifications = { domains: Array<{ domain: string; methods?: Array<'dns-txt' | 'https-well-known'> }>; github: Array<{ username: string; repository?: string }> }

const CHECK_TTL_MS = 5 * 60_000

function verificationsOf(raw: Record<string, unknown>): Verifications {
  const seller = (raw.seller ?? {}) as { verifications?: Partial<Verifications> }
  return { domains: seller.verifications?.domains ?? [], github: seller.verifications?.github ?? [] }
}

const domainKey = (domain: string) => `domain:${domain.trim().toLowerCase()}`
const githubKey = (claim: { username: string; repository?: string }) => `github:${claim.username.trim().toLowerCase()}/${(claim.repository || claim.username).trim().toLowerCase()}`

/**
 * Live checks of the seller's ownership claims, the same checks buyers run.
 * Results are kept 5 minutes; `check` re-runs them now.
 */
export class VerificationChecks {
  private readonly _results = new Map<string, SellerVerificationStatus>()
  private _running: Promise<void> | null = null
  /** A check asked for while one runs: it runs next, with the latest claims asked for. */
  private _queued: { promise: Promise<void>; peerId: string; claims: Verifications } | null = null

  constructor(private readonly _options: { fetch?: typeof fetch; resolveTxt?: (hostname: string) => Promise<string[][]> } = {}) {}

  /** A check is running (or queued behind one): its results are not in yet. */
  get running(): boolean {
    return this._running !== null
  }

  status(key: string): SellerVerificationStatus | null {
    return this._results.get(key) ?? null
  }

  /** Starts checks for claims never checked or older than the TTL. */
  ensure(peerId: string, claims: Verifications): void {
    const now = Date.now()
    const due = [...claims.domains.map((claim) => domainKey(claim.domain)), ...claims.github.map(githubKey)]
      .some((key) => { const result = this._results.get(key); return !result || now - result.checkedAt > CHECK_TTL_MS })
    if (due && !this._running) void this.check(peerId, claims)
  }

  check(peerId: string, claims: Verifications): Promise<void> {
    // Claims saved while a check runs are checked by a fresh run after it, not folded into the old one.
    if (this._running) {
      if (this._queued) return Object.assign(this._queued, { peerId, claims }).promise
      const queued: { promise: Promise<void>; peerId: string; claims: Verifications } = { peerId, claims, promise: this._running.then((): Promise<void> => {
        this._queued = null
        return this.check(queued.peerId, queued.claims)
      }) }
      this._queued = queued
      return queued.promise
    }
    this._running = (async () => {
      const options = { timeoutMs: 8_000, ...(this._options.fetch ? { fetch: this._options.fetch } : {}), ...(this._options.resolveTxt ? { resolveTxt: this._options.resolveTxt } : {}) }
      await Promise.all([
        ...claims.domains.map(async (claim) => {
          const result = await verifyDomainVerificationClaim(claim, peerId, options).catch((error: Error) => ({ verified: false, checkedAtMs: Date.now(), attempts: [{ error: error.message }] }))
          const error = result.verified ? null : result.attempts.map((attempt) => ('method' in attempt ? `${attempt.method}: ` : '') + (attempt.error ?? 'no matching proof')).join('; ')
          this._results.set(domainKey(claim.domain), { verified: result.verified, checkedAt: result.checkedAtMs, error })
        }),
        ...claims.github.map(async (claim) => {
          const result = await verifyGithubVerificationClaim(claim, peerId, options).catch((error: Error) => ({ verified: false, checkedAtMs: Date.now(), error: error.message }))
          this._results.set(githubKey(claim), { verified: result.verified, checkedAt: result.checkedAtMs, error: result.verified ? null : result.error ?? 'no matching proof' })
        }),
      ])
    })().finally(() => { this._running = null })
    return this._running
  }
}

/** The claims as configured (domain methods included), which is what buyers check. */
export async function readSellerVerifications(configPath: string): Promise<Verifications> {
  return verificationsOf(await readRaw(configPath))
}

export async function readSellerPromote(options: {
  configPath: string
  peerId: string | null
  services: SellerServicePricing[]
  trustScore: number | null
  explorerUrl: string | null
  checks: VerificationChecks
  /** Start checks that are due (the dashboard); a one-shot CLI read leaves them alone. */
  startChecks?: boolean
  /** The network snapshot the trust score comes from is still loading. */
  networkLoading?: boolean
  /** The APIs the seller announces for a service, from its own network row. */
  announcedProtocols?: (provider: string, service: string) => string[]
}): Promise<SellerPromote> {
  const raw = await readRaw(options.configPath)
  const claims = verificationsOf(raw)
  const access = await configWritable(options.configPath)
  const peer = options.peerId ? peerKey(options.peerId) : null
  if (peer && options.startChecks !== false) options.checks.ensure(peer, claims)
  const identity = (raw.identity ?? {}) as { displayName?: string }
  return {
    peerId: peer,
    displayName: identity.displayName ?? '',
    profileUrl: peer && options.explorerUrl ? `${options.explorerUrl.replace(/\/+$/, '')}/account/0x${peer}` : null,
    services: options.services.map(({ provider, service, inputUsdPerMillion, outputUsdPerMillion, unitPrice, apiProtocols, kind }) => {
      // The APIs the running seller announces (its plugin's) complete the ones the config bills on.
      const protocols = [...new Set([...apiProtocols, ...(options.announcedProtocols?.(provider, service) ?? [])])]
      return { provider, service, inputUsdPerMillion, outputUsdPerMillion, unitPrice, apiProtocols: protocols, kind: kind === 'text' ? serviceKind(protocols) : kind }
    }),
    trustScore: options.trustScore,
    pending: options.checks.running || options.networkLoading === true,
    writable: access.writable,
    readOnlyReason: access.reason,
    domains: claims.domains.map((claim) => {
      const domain = claim.domain.trim().toLowerCase()
      return {
        domain,
        txtName: `${DOMAIN_VERIFICATION_TXT_NAME_PREFIX}${domain}`,
        txtValue: peer ? buildDomainVerificationTxtValue(peer) : '',
        wellKnownUrl: `https://${domain}${DOMAIN_VERIFICATION_WELL_KNOWN_PATH}`,
        wellKnownBody: peer ? JSON.stringify(buildDomainVerificationWellKnownProof(peer, domain), null, 2) : '',
        status: options.checks.status(domainKey(domain)),
      }
    }),
    github: claims.github.map((claim) => ({
      username: claim.username,
      repository: claim.repository || claim.username,
      proofUrl: buildGithubVerificationProofUrl(claim),
      proofBody: peer ? JSON.stringify(buildGithubVerificationProof(peer, claim.username), null, 2) : '',
      status: options.checks.status(githubKey(claim)),
    })),
  }
}

/** Replaces `seller.verifications` (validated like every config edit); applies when the seller restarts. */
export async function updateSellerVerifications(configPath: string, body: unknown): Promise<void> {
  const input = (body ?? {}) as { domains?: unknown; github?: unknown }
  if (!Array.isArray(input.domains) || !Array.isArray(input.github)) bad('Send { domains: [...], github: [...] }')
  const domains = input.domains.map((entry) => {
    const domain = String((entry as { domain?: unknown })?.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) bad(`"${domain}" is not a domain name`)
    return { domain }
  })
  const github = input.github.map((entry) => {
    const claim = entry as { username?: unknown; repository?: unknown }
    const username = String(claim.username ?? '').trim().replace(/^@/, '')
    const repository = String(claim.repository ?? '').trim()
    if (!/^[a-z0-9-]{1,39}$/i.test(username)) bad(`"${username}" is not a GitHub username`)
    if (repository && !/^[a-z0-9._-]{1,100}$/i.test(repository)) bad(`"${repository}" is not a GitHub repository name`)
    return repository && repository.toLowerCase() !== username.toLowerCase() ? { username, repository } : { username }
  })
  await patchSellerConfig(configPath, (raw) => {
    const seller = (raw.seller && typeof raw.seller === 'object' ? raw.seller : (raw.seller = {})) as Record<string, unknown>
    // A domain kept from before keeps its proof methods (the dashboard does not edit them).
    const previous = new Map(verificationsOf(raw).domains.map((claim) => [claim.domain.trim().toLowerCase(), claim.methods]))
    const saved = domains.map(({ domain }) => {
      const methods = previous.get(domain)
      return methods !== undefined ? { domain, methods } : { domain }
    })
    if (saved.length === 0 && github.length === 0) delete seller.verifications
    else seller.verifications = { ...(saved.length ? { domains: saved } : {}), ...(github.length ? { github } : {}) }
  })
}
