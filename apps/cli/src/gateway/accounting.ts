import { randomUUID } from 'node:crypto'
import type { AttributedSpendEvent } from '../proxy/spend-attribution.js'
import { BUDGET_PERIODS, cappedPeriods, findLimitBreach, hasSpendLimits, type BudgetLevel, type BudgetLimits, type LimitBreach, type SpendLimits } from './limits.js'
import { parseBaseUnits } from './money.js'
export { videoJobKey } from './video-jobs.js'
import type { ApiKeyRecord, BudgetScope, GatewayStore, MemberRecord, VideoCommitmentRecord, WorkspaceRecord } from './store.js'

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

/**
 * An accepted video nobody downloads stops counting against the caps after
 * this long: as long as the buyer keeps the job's route and billing (30 days),
 * so a video that can still be delivered and charged is never forgotten first.
 */
const DEFAULT_VIDEO_COMMITMENT_MS = 30 * 24 * 60 * 60_000

/** The buyer's default limit for one video ($5), when its config sets none. */
export const DEFAULT_MAX_VIDEO_REQUEST_USDC = 5_000_000

export interface GatewayAccountingOptions {
  /**
   * Worst-case cost of one request, reserved against the key's caps while it
   * is in flight. The buyer's maxPerRequestUsdc is the natural bound.
   */
  holdUsdc: number
  /**
   * The most one video may cost: the buyer's maxVideoRequestUsdc. A video
   * create reserves up to this much of a key's room while it is priced.
   */
  maxVideoRequestUsdc?: number
  settleGraceMs?: number
  videoCommitmentMs?: number
  now?: () => number
  onLog?: (message: string) => void
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

/** The price of an accepted video job, owed once its file is delivered. Stored, so it survives a restart. */
type VideoCommitment = Omit<VideoCommitmentRecord, 'job'>


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
  private readonly _maxVideoRequestUsdc: number
  private readonly _now: () => number

  constructor(private readonly _store: GatewayStore, private readonly _options: GatewayAccountingOptions) {
    this._settleGraceMs = _options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS
    this._videoCommitmentMs = _options.videoCommitmentMs ?? DEFAULT_VIDEO_COMMITMENT_MS
    this._maxVideoRequestUsdc = _options.maxVideoRequestUsdc ?? DEFAULT_MAX_VIDEO_REQUEST_USDC
    this._now = _options.now ?? (() => Date.now())
    try {
      for (const { job, ...commitment } of _store.listVideoCommitments(this._now())) this._videoCommitments.set(job, commitment)
    } catch (error) {
      _options.onLog?.(`gateway could not load video commitments: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** In-flight holds plus accepted videos not yet charged, optionally leaving one video job out. */
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
    // A revoked key cannot retrieve its jobs any more (only the creating key may), so they are never charged.
    const active = new Map<string, boolean>()
    const isActive = (keyId: string): boolean => {
      let result = active.get(keyId)
      if (result === undefined) {
        result = this._store.getKey(keyId)?.status === 'active'
        active.set(keyId, result)
      }
      return result
    }
    for (const [job, commitment] of this._videoCommitments) {
      if (commitment.expiresAt <= now) this._forgetVideo(job)
      else if (commitment.amountUsdc > 0 && job !== excludeVideoJob && match(commitment) && isActive(commitment.keyId)) held += commitment.amountUsdc
    }
    return held
  }

  /**
   * A video create was accepted: remember which key owns the job (only that
   * key may retrieve it) and keep `amountUsdc` counted against the caps of the
   * key, member and workspace the create was admitted for until the buyer's
   * charge for its delivery arrives, the buyer retires the job, or the record
   * expires. `amountUsdc` is 0 for a key without caps.
   */
  commitVideo(tag: string, job: string, amountUsdc: number): void {
    const hold = this._holds.get(tag)
    if (!hold) return
    const commitment: VideoCommitment = {
      keyId: hold.keyId,
      memberId: hold.memberId,
      workspaceId: hold.workspaceId,
      amountUsdc: Math.max(0, Math.floor(amountUsdc)),
      expiresAt: this._now() + this._videoCommitmentMs,
    }
    this._videoCommitments.set(job, commitment)
    this._write(() => this._store.saveVideoCommitment({ job, ...commitment }))
  }

  /** The key that created a video job through this gateway, if it is still remembered. */
  videoJobOwner(job: string): string | null {
    const commitment = this._videoCommitments.get(job)
    return commitment && commitment.expiresAt > this._now() ? commitment.keyId : null
  }

  /** What a video job still holds against the caps (0 once charged, or for an uncapped key). */
  videoJobHeldUsdc(job: string): number {
    return this._videoCommitments.get(job)?.amountUsdc ?? 0
  }

  /**
   * The buyer retired the job: it failed, its seller no longer has it, or the
   * buyer has no record of it. It can never be delivered or charged.
   */
  dropVideo(job: string): void {
    if (this._videoCommitments.has(job)) this._forgetVideo(job)
  }

  /**
   * The buyer charged a delivery of the job: the charge is in the ledger now,
   * so the job holds nothing more. Ownership stays, so its owner can download
   * it again (the buyer does not charge twice).
   */
  private _videoCharged(job: string): void {
    const commitment = this._videoCommitments.get(job)
    if (!commitment || commitment.amountUsdc === 0) return
    commitment.amountUsdc = 0
    this._write(() => this._store.saveVideoCommitment({ job, ...commitment }))
  }

  private _forgetVideo(job: string): void {
    this._videoCommitments.delete(job)
    this._write(() => this._store.deleteVideoCommitment(job))
  }

  /**
   * Commitments live in memory first and are stored so a restart keeps them;
   * a failed write (for example another process holding the database lock)
   * must not fail the request that caused it.
   */
  private _write(write: () => void): void {
    try {
      write()
    } catch (error) {
      this._options.onLog?.(`gateway could not store a video commitment: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    if (videoCreate && remainingUsdc !== null) remainingUsdc = Math.min(remainingUsdc, this._maxVideoRequestUsdc)
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
      // The delivery of a video job was charged: the job's commitment is now spend.
      if (request.videoJob) this._videoCharged(request.videoJob)
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
    // Commitments stay stored: the next gateway reloads them.
    this._videoCommitments.clear()
  }
}

/** The stricter of two caps; null is no cap. */
function lowerCap(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}
