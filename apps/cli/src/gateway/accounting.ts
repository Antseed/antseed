import { randomUUID } from 'node:crypto'
import type { AttributedSpendEvent } from '../proxy/spend-attribution.js'
import { BUDGET_PERIODS, findLimitBreach, hasSpendLimits, type BudgetLevel, type BudgetLimits, type BudgetPeriod, type LimitBreach, type SpendLimits } from './limits.js'
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

export interface GatewayAccountingOptions {
  /**
   * Worst-case cost of one request, reserved against the key's caps while it
   * is in flight. The buyer's maxPerRequestUsdc is the natural bound.
   */
  holdUsdc: number
  settleGraceMs?: number
  now?: () => number
}

type Hold = {
  keyId: string
  memberId: string | null
  workspaceId: string
  amountUsdc: number
  finished: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export function newRequestTag(): string {
  return `gw_${randomUUID()}`
}

export type Admission =
  | { ok: true; tag: string }
  | { ok: false; breach: LimitBreach }

/**
 * Hold → settle accounting per key. Admission reserves a hold so concurrent
 * requests cannot all slip under a cap; signed spend reported by the buyer
 * settles into the ledger, and the hold is released once the request is done.
 * Prepaid balances and payments per key reuse the same ledger.
 */
export class GatewayAccounting {
  private readonly _holds = new Map<string, Hold>()
  private readonly _settleGraceMs: number
  private readonly _now: () => number

  constructor(private readonly _store: GatewayStore, private readonly _options: GatewayAccountingOptions) {
    this._settleGraceMs = _options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS
    this._now = _options.now ?? (() => Date.now())
  }

  heldUsdc(keyId: string): number {
    return this._held((hold) => hold.keyId === keyId)
  }

  /** Holds in flight for every key a member owns. */
  heldForMember(memberId: string): number {
    return this._held((hold) => hold.memberId === memberId)
  }

  heldForWorkspace(workspaceId: string): number {
    return this._held((hold) => hold.workspaceId === workspaceId)
  }

  private _held(match: (hold: Hold) => boolean): number {
    let held = 0
    for (const hold of this._holds.values()) if (match(hold)) held += hold.amountUsdc
    return held
  }

  /** Whether any level above or at the key caps spend (so admission depends on the spend feed). */
  hasBudgets(key: ApiKeyRecord, context: KeyContext = this._context(key)): boolean {
    if (hasSpendLimits(effectiveKeyLimits(key))) return true
    if (context.member && hasSpendLimits(context.member.limits)) return true
    return Boolean(context.workspace && hasSpendLimits(context.workspace.limits))
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
   * without a cap cost no query.
   */
  admit(key: ApiKeyRecord, context: KeyContext = this._context(key)): Admission {
    const now = this._now()
    const { member, workspace } = context
    const levels: Array<{ level: BudgetLevel; limits: SpendLimits | BudgetLimits; scope: BudgetScope; held: () => number }> = [
      { level: 'key', limits: effectiveKeyLimits(key), scope: { keyId: key.id }, held: () => this.heldUsdc(key.id) },
    ]
    if (member) levels.push({ level: 'member', limits: member.limits, scope: { memberId: member.id }, held: () => this.heldForMember(member.id) })
    if (workspace) levels.push({ level: 'workspace', limits: workspace.limits, scope: { workspaceId: workspace.id }, held: () => this.heldForWorkspace(workspace.id) })
    for (const { level, limits, scope, held } of levels) {
      const periods = cappedPeriods(limits)
      if (periods.length === 0) continue
      const breach = findLimitBreach(limits, this._store.spendByPeriod(scope, now, periods), held(), now)
      if (breach) return { ok: false, breach: { ...breach, level } }
    }
    const tag = newRequestTag()
    this._holds.set(tag, {
      keyId: key.id,
      memberId: key.ownerMemberId,
      workspaceId: key.workspaceId,
      amountUsdc: this._options.holdUsdc,
      finished: false,
      timer: null,
    })
    return { ok: true, tag }
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
  }
}

/** The stricter of two caps; null is no cap. */
function lowerCap(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function cappedPeriods(limits: SpendLimits | BudgetLimits): BudgetPeriod[] {
  return BUDGET_PERIODS.filter((period) => (limits[period] ?? null) !== null)
}
