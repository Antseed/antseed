import { ZERO_DATA_ACCESS_POLICY_CAPABILITY } from '../routing-policy/policy.js'
import { buyerFetch } from './buyer-control.js'

/** Model name the probe previews; no seller serves it, so the preview is cheap. */
const BUYER_POLICY_PROBE_MODEL = '__probe__'
const RETRY_MS = 5_000
const RECHECK_MS = 60_000
/** How long a buyer that confirmed support keeps it while probes get no answer. */
const UNANSWERED_GRACE_MS = 120_000

/**
 * What the gateway knows about whether its buyer applies routing policies:
 * `supported` once an authenticated route preview succeeds, `unsupported`
 * when the buyer answers but refuses it (an older buyer without the
 * endpoint, or one that does not share the control secret), `unknown` while
 * the buyer cannot be reached.
 */
export type BuyerPolicySupport = 'unknown' | 'supported' | 'unsupported'

export interface BuyerPolicyProbeOptions {
  buyerPort: number
  secret: string
  onLog?: (message: string) => void
  /** Injectable for tests; defaults to `buyerFetch`. */
  fetchPreview?: () => Promise<Response>
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number
}

/** One authenticated `GET /_antseed/route-preview`; never throws. */
export async function probeBuyerPolicySupport(options: BuyerPolicyProbeOptions): Promise<BuyerPolicySupport> {
  return (await probeBuyerPolicy(options)).support
}

/** The same probe, with the policy capabilities the buyer lists (none from a buyer older than the list). */
export async function probeBuyerPolicy(options: BuyerPolicyProbeOptions): Promise<{ support: BuyerPolicySupport; capabilities: string[] }> {
  let response: Response
  try {
    response = options.fetchPreview
      ? await options.fetchPreview()
      : await buyerFetch({ buyerPort: options.buyerPort, secret: options.secret },
        `/_antseed/route-preview?model=${BUYER_POLICY_PROBE_MODEL}`, { policy: {} })
  } catch {
    return { support: 'unknown', capabilities: [] }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { support: 'unsupported', capabilities: [] }
  }
  const body = await response.json().catch(() => null) as { candidates?: unknown; capabilities?: unknown } | null
  if (!Array.isArray(body?.candidates)) return { support: 'unsupported', capabilities: [] }
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
  return { support: 'supported', capabilities }
}

/**
 * Probes the buyer at startup and keeps re-checking (every 5 s until it gets
 * an answer, then every minute, so an upgraded or replaced buyer is noticed).
 * `policyUnsupported()` is what the server consults: true unless the buyer
 * has confirmed it applies policies, so a key whose policy restricts sellers
 * is refused rather than silently routed unrestricted by an older buyer.
 *
 * A probe that gets no answer (a busy buyer timing out, a restart) does not
 * take back a confirmation for two minutes: the buyer is re-probed every 5 s
 * and only an answer that refuses the preview, or two minutes of silence,
 * makes it unsupported again. One slow probe must not refuse every key.
 *
 * `zeroDataAccessUnsupported()` is the same for the zero data access
 * requirement, which a buyer applies only when its answer lists the
 * capability: an older buyer accepts the policy and routes without it.
 */
export class BuyerPolicyProbe {
  private _state: BuyerPolicySupport = 'unknown'
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _stopped = false
  private _warned = false
  private _checked = false
  private _confirmedAt: number | null = null
  private _capabilities: readonly string[] = []
  private _rechecking = false

  constructor(private readonly _options: BuyerPolicyProbeOptions) {}

  get state(): BuyerPolicySupport {
    return this._state
  }

  policyUnsupported(): boolean {
    return this._state !== 'supported'
  }

  zeroDataAccessUnsupported(): boolean {
    return this.policyUnsupported() || !this._capabilities.includes(ZERO_DATA_ACCESS_POLICY_CAPABILITY)
  }

  /** Runs the first probe and schedules the next ones. */
  async start(): Promise<BuyerPolicySupport> {
    await this.check()
    return this._state
  }

  async check(): Promise<void> {
    const { support: probed, capabilities } = await probeBuyerPolicy(this._options)
    if (this._stopped) return
    const now = (this._options.now ?? Date.now)()
    if (probed === 'supported') this._confirmedAt = now
    else if (probed === 'unsupported') this._confirmedAt = null
    // An unanswered probe keeps what the last answer listed, for as long as it keeps the confirmation.
    if (probed !== 'unknown') this._capabilities = capabilities
    const unanswered = probed === 'unknown'
    const next = unanswered && this._confirmedAt !== null && now - this._confirmedAt < UNANSWERED_GRACE_MS
      ? 'supported'
      : probed
    const previous = this._state
    this._state = next
    const first = !this._checked
    this._checked = true
    if (next !== previous || first) {
      const log = this._options.onLog
      if (next === 'unsupported') {
        this._warned = true
        log?.(`WARNING: the buyer on port ${this._options.buyerPort} does not accept this gateway's routing policies `
          + '(an older antseed buyer, or a different gateway control secret). Paid requests from keys whose '
          + 'policy restricts sellers are refused with 503 buyer_policy_unsupported until the buyer is upgraded '
          + 'and shares the control secret.')
      } else if (next === 'unknown') {
        this._warned = true
        log?.(`WARNING: cannot reach the buyer on port ${this._options.buyerPort} to confirm it applies routing `
          + 'policies; keys whose policy restricts sellers are refused until it answers.')
      } else if (this._warned) {
        this._warned = false
        log?.('The buyer now applies routing policies.')
      }
    }
    this._schedule(unanswered ? RETRY_MS : RECHECK_MS)
  }

  /** Probes now, ahead of the schedule and one at a time: the buyer just answered as another one than the last probe saw. */
  recheck(): void {
    if (this._stopped || this._rechecking) return
    this._rechecking = true
    void this.check().finally(() => { this._rechecking = false })
  }

  stop(): void {
    this._stopped = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
  }

  private _schedule(delayMs: number): void {
    if (this._stopped) return
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = null
      void this.check()
    }, delayMs)
    this._timer.unref?.()
  }
}
