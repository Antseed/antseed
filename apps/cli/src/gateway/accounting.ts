import { randomUUID } from 'node:crypto'
import type { AttributedSpendEvent } from '../proxy/spend-attribution.js'
import { BUDGET_PERIODS, cappedPeriods, findLimitBreach, hasSpendLimits, type BudgetLevel, type BudgetLimits, type LimitBreach, type SpendLimits } from './limits.js'
import { parseBaseUnits } from './money.js'
import type { ApiKeyRecord, BudgetScope, GatewayStore, MemberRecord, WorkspaceRecord } from './store.js'

/**
 * The member and workspace a key's request is accounted to, when the caller
 * already loaded them (the gateway does, once per request); otherwise they
 * are read from the store.
 */
export interface KeyContext {
  member: MemberRecord | null
  workspace: WorkspaceRecord | null
}

/** The key's cap per period: the lower of the admins' and the owner's. */
export function effectiveKeyLimits(key: Pick<ApiKeyRecord, 'limits' | 'ownerLimits'>): BudgetLimits {
  const result = {} as BudgetLimits
  for (const period of BUDGET_PERIODS) {
    result[period] = lowerCap(key.limits[period] ?? null, key.ownerLimits?.[period] ?? null)
  }
  return result
}

/** Spend can be signed after the response ends (seller-initiated auth). */
const DEFAULT_SETTLE_GRACE_MS = 60_000

/** An accepted video nobody downloads stops counting against the caps after this long. */
const DEFAULT_VIDEO_COMMITMENT_MS = 24 * 60 * 60_000

/** The most a video create reserves while it is priced: the buyer's default limit for one video ($5). */
const MAX_VIDEO_CREATE_RESERVE_USDC = 5_000_000

export interface GatewayAccountingOptions {
  /**
   * Worst-case cost of one request, reserved against the key's caps while it
   * is in flight. The buyer's maxPerRequestUsdc is the natural bound.
   */
  holdUsdc: number
  settleGraceMs?: number
  videoCommitmentMs?: number
  now?: () => number
}

/** One level whose caps a key's request is admitted against. */
type BudgetCheck = {
  level: BudgetLevel
  limits: SpendLimits | BudgetLimits
  scope: BudgetScope
  held: () => number
}

type Hold = {
  keyId: string
  memberId: string | null
  workspaceId: string
  amountUsdc: number
  finished: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/** The price of an accepted video job, owed once its file is delivered. */
type VideoCommitment = Omit<Hold, 'finished' | 'timer'> & { expiresAt: number }

/** Identifies a video job across its create, polls and delivery. */
export function videoJobKey(protocol: string, jobId: string): string {
  return `${protocol}\n${jobId}`
}

export function newRequestTag(): string {
  return `gw_${randomUUID()}`
}

export interface AdmitOptions {
  /** A video create: reserve the room it may spend (up to one video's limit) until its price is known. */
  videoCreate?: boolean
  /** A video job's own poll or download, admitted without that job's commitment. */
  videoJob?: string
}

export type Admission =
  /**
   * `remainingUsdc`: the least room left under any cap before this request's
   * hold, or for a video create the allowance reserved for it; null when
   * nothing is capped.
   */
  | { ok: true; tag: string; remainingUsdc: number | null }
  | { ok: false; breach: LimitBreach }

/**
 * Hold → settle accounting per key. Admission reserves a hold so concurrent
 * requests cannot all slip under a cap; signed spend reported by the buyer
 * settles into the ledger, and the hold is released once the request is done.
 * Prepaid balances and payments per key reuse the same ledger.
 */
export class GatewayAccounting {
  private readonly _holds = new Map<string, Hold>()
  /** Accepted video jobs, by `videoJobKey`: their price counts against the caps until delivered, failed or expired. */
  private readonly _videoCommitments = new Map<string, VideoCommitment>()
  private readonly _settleGraceMs: number
  private readonly _videoCommitmentMs: number
  private readonly _now: () => number

  constructor(private readonly _store: GatewayStore, private readonly _options: GatewayAccountingOptions) {
    this._settleGraceMs = _options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS
    this._videoCommitmentMs = _options.videoCommitmentMs ?? DEFAULT_VIDEO_COMMITMENT_MS
    this._now = _options.now ?? (() => Date.now())
  }

  /** In-flight holds plus accepted videos not yet delivered, optionally leaving one video job out. */
  heldUsdc(keyId: string, excludeVideoJob?: string): number {
    return this._held((hold) => hold.keyId === keyId, excludeVideoJob)
  }

  /** Holds in flight for every key a member owns. */
  heldForMember(memberId: string, excludeVideoJob?: string): number {
    return this._held((hold) => hold.memberId === memberId, excludeVideoJob)
  }

  heldForWorkspace(workspaceId: string, excludeVideoJob?: string): number {
    return this._held((hold) => hold.workspaceId === workspaceId, excludeVideoJob)
  }

  private _held(match: (hold: Omit<Hold, 'finished' | 'timer'>) => boolean, excludeVideoJob?: string): number {
    let held = 0
    for (const hold of this._holds.values()) if (match(hold)) held += hold.amountUsdc
    const now = this._now()
    for (const [job, commitment] of this._videoCommitments) {
      if (commitment.expiresAt <= now) this._videoCommitments.delete(job)
      else if (job !== excludeVideoJob && match(commitment)) held += commitment.amountUsdc
    }
    return held
  }

  /**
   * A video create was accepted at this price: keep it counted against the
   * caps of the key, member and workspace the create was admitted for until
   * the video is delivered, the job fails or the commitment expires.
   */
  commitVideo(tag: string, job: string, priceUsdc: number): void {
    const hold = this._holds.get(tag)
    if (!hold || !(priceUsdc > 0)) return
    this._videoCommitments.set(job, {
      keyId: hold.keyId,
      memberId: hold.memberId,
      workspaceId: hold.workspaceId,
      amountUsdc: priceUsdc,
      expiresAt: this._now() + this._videoCommitmentMs,
    })
  }

  /**
   * The retrieve `tag` delivered the job's file. Its charge is signed after
   * the response, so the commitment moves onto that request's hold, which
   * settled spend then replaces like any other request's.
   */
  deliverVideo(tag: string, job: string): void {
    const commitment = this._videoCommitments.get(job)
    if (!commitment) return
    this._videoCommitments.delete(job)
    const hold = this._holds.get(tag)
    if (hold) hold.amountUsdc = Math.max(hold.amountUsdc, commitment.amountUsdc)
  }

  /** The job failed or is unknown to the buyer: it will never be charged. */
  dropVideo(job: string): void {
    this._videoCommitments.delete(job)
  }

  /** Whether any level above or at the key caps spend (so admission depends on the spend feed). */
  hasBudgets(key: ApiKeyRecord, context: KeyContext = this._context(key)): boolean {
    return this._budgetChecks(key, context).some(({ limits }) => hasSpendLimits(limits))
  }

  /** The key (the lower of its admin and owner caps), the member who owns it and its workspace. */
  private _budgetChecks(key: ApiKeyRecord, { member, workspace }: KeyContext, excludeVideoJob?: string): BudgetCheck[] {
    const checks: BudgetCheck[] = [
      { level: 'key', limits: effectiveKeyLimits(key), scope: { keyId: key.id }, held: () => this.heldUsdc(key.id, excludeVideoJob) },
    ]
    if (member) checks.push({ level: 'member', limits: member.limits, scope: { memberId: member.id }, held: () => this.heldForMember(member.id, excludeVideoJob) })
    if (workspace) checks.push({ level: 'workspace', limits: workspace.limits, scope: { workspaceId: workspace.id }, held: () => this.heldForWorkspace(workspace.id, excludeVideoJob) })
    return checks
  }

  private _context(key: ApiKeyRecord): KeyContext {
    return {
      member: key.ownerMemberId ? this._store.getMember(key.ownerMemberId) : null,
      workspace: this._store.getWorkspace(key.workspaceId),
    }
  }

  /**
   * Admits a paid request only when the key (the lower of its admin and
   * owner caps), the member who owns it and its workspace all have room.
   * Member and workspace spend is the ledger as attributed at request time,
   * so a member who revokes a key and creates a new one still counts
   * everything spent before against the member's caps. Levels and periods
   * without a cap cost no query. A video job's own polls and delivery are
   * admitted without its own commitment (`videoJob`), which they would
   * otherwise count twice.
   */
  admit(key: ApiKeyRecord, context: KeyContext = this._context(key), { videoCreate = false, videoJob }: AdmitOptions = {}): Admission {
    const now = this._now()
    let remainingUsdc: number | null = null
    for (const { level, limits, scope, held } of this._budgetChecks(key, context, videoJob)) {
      const periods = cappedPeriods(limits)
      if (periods.length === 0) continue
      const spent = this._store.spendByPeriod(scope, now, periods)
      const heldUsdc = held()
      const breach = findLimitBreach(limits, spent, heldUsdc, now)
      if (breach) return { ok: false, breach: { ...breach, level } }
      for (const period of periods) {
        const room = (limits[period] ?? 0) - (spent[period] ?? 0) - heldUsdc
        remainingUsdc = remainingUsdc === null ? room : Math.min(remainingUsdc, room)
      }
    }
    // A video create may start a job worth up to the room it is told about, so it
    // holds all of that until the buyer reports the price: two creates in flight
    // at once cannot both be told the same room.
    if (videoCreate && remainingUsdc !== null) remainingUsdc = Math.min(remainingUsdc, MAX_VIDEO_CREATE_RESERVE_USDC)
    const tag = newRequestTag()
    this._holds.set(tag, {
      keyId: key.id,
      memberId: key.ownerMemberId,
      workspaceId: key.workspaceId,
      amountUsdc: videoCreate && remainingUsdc !== null ? remainingUsdc : this._options.holdUsdc,
      finished: false,
      timer: null,
    })
    return { ok: true, tag, remainingUsdc }
  }

  /** Drops a hold at once, for a request that never reached the buyer. */
  release(tag: string): void {
    const hold = this._holds.get(tag)
    if (hold?.timer) clearTimeout(hold.timer)
    this._holds.delete(tag)
  }

  /** The response is over; keep the hold briefly for spend that is signed late. */
  finish(tag: string): void {
    const hold = this._holds.get(tag)
    if (!hold || hold.finished) return
    hold.finished = true
    hold.timer = setTimeout(() => this._holds.delete(tag), this._settleGraceMs)
    hold.timer.unref?.()
  }

  /**
   * Settle spend events reported by the buyer. Unknown tags belong to other
   * clients; an event signed by a different identity than the key's is ignored.
   */
  ingest(bootId: string, events: readonly AttributedSpendEvent[]): number {
    let recorded = 0
    for (const event of events) {
      const request = this._store.findRequest(event.tag)
      if (!request || request.buyerIdentity !== event.buyerIdentity) continue
      const inserted = this._store.recordLedgerEntry({
        kind: 'spend',
        keyId: request.keyId,
        buyerIdentity: request.buyerIdentity,
        amountUsdc: parseBaseUnits(event.amountUsdc),
        externalRef: `spend:${bootId}:${event.seq}`,
        requestTag: event.tag,
        sellerPeerId: event.sellerPeerId,
        inputTokens: parseBaseUnits(event.inputTokens),
        cachedInputTokens: parseBaseUnits(event.cachedInputTokens),
        outputTokens: parseBaseUnits(event.outputTokens),
        createdAt: event.at,
        // Spend counts against whoever the request was admitted for.
        workspaceId: request.workspaceId,
        memberId: request.memberId,
        model: request.model,
        endUser: request.endUser,
      })
      if (!inserted) continue
      recorded += 1
      // Settled spend replaces that much of the request's worst-case hold.
      // The rest stays until the grace period ends: one request can sign
      // several deltas, and later ones still need to be covered.
      const hold = this._holds.get(event.tag)
      if (hold) hold.amountUsdc = Math.max(0, hold.amountUsdc - parseBaseUnits(event.amountUsdc))
    }
    return recorded
  }

  dispose(): void {
    for (const hold of this._holds.values()) if (hold.timer) clearTimeout(hold.timer)
    this._holds.clear()
    this._videoCommitments.clear()
  }
}

/** The stricter of two caps; null is no cap. */
function lowerCap(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}
