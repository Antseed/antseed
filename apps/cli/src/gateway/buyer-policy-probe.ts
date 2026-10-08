import { buyerFetch } from './buyer-control.js'

/** Model name the probe previews; no seller serves it, so the preview is cheap. */
const BUYER_POLICY_PROBE_MODEL = '__probe__'
const RETRY_MS = 5_000
const RECHECK_MS = 60_000

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
}

/** One authenticated `GET /_antseed/route-preview`; never throws. */
export async function probeBuyerPolicySupport(options: BuyerPolicyProbeOptions): Promise<BuyerPolicySupport> {
  let response: Response
  try {
    response = options.fetchPreview
      ? await options.fetchPreview()
      : await buyerFetch({ buyerPort: options.buyerPort, secret: options.secret },
        `/_antseed/route-preview?model=${BUYER_POLICY_PROBE_MODEL}`, { policy: {} })
  } catch {
    return 'unknown'
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return 'unsupported'
  }
  const body = await response.json().catch(() => null) as { candidates?: unknown } | null
  return Array.isArray(body?.candidates) ? 'supported' : 'unsupported'
}

/**
 * Probes the buyer at startup and keeps re-checking (every 5 s until it gets
 * an answer, then every minute, so an upgraded or replaced buyer is noticed).
 * `policyUnsupported()` is what the server consults: true unless the buyer
 * has confirmed it applies policies, so a key whose policy restricts sellers
 * is refused rather than silently routed unrestricted by an older buyer.
 */
export class BuyerPolicyProbe {
  private _state: BuyerPolicySupport = 'unknown'
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _stopped = false
  private _warned = false
  private _checked = false

  constructor(private readonly _options: BuyerPolicyProbeOptions) {}

  get state(): BuyerPolicySupport {
    return this._state
  }

  policyUnsupported(): boolean {
    return this._state !== 'supported'
  }

  /** Runs the first probe and schedules the next ones. */
  async start(): Promise<BuyerPolicySupport> {
    await this.check()
    return this._state
  }

  async check(): Promise<void> {
    const next = await probeBuyerPolicySupport(this._options)
    if (this._stopped) return
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
    this._schedule(next === 'unknown' ? RETRY_MS : RECHECK_MS)
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
