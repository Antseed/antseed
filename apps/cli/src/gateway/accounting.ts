import { randomUUID } from 'node:crypto'
import type { AttributedSpendEvent } from '../proxy/spend-attribution.js'
import { findLimitBreach, type LimitBreach } from './limits.js'
import { parseBaseUnits } from './money.js'
import type { ApiKeyRecord, GatewayStore } from './store.js'

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

type Hold = { keyId: string; amountUsdc: number; finished: boolean; timer: ReturnType<typeof setTimeout> | null }

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
    let held = 0
    for (const hold of this._holds.values()) if (hold.keyId === keyId) held += hold.amountUsdc
    return held
  }

  admit(key: ApiKeyRecord): Admission {
    const now = this._now()
    const breach = findLimitBreach(key.limits, this._store.periodSpend(key.id, now), this.heldUsdc(key.id), now)
    if (breach) return { ok: false, breach }
    const tag = newRequestTag()
    this._holds.set(tag, { keyId: key.id, amountUsdc: this._options.holdUsdc, finished: false, timer: null })
    return { ok: true, tag }
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
