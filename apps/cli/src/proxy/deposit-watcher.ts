/**
 * Watches the buyer's hot wallet for incoming USDC and sweeps it into the
 * deposits contract via a relayer — the daemon-side engine behind the
 * desktop's automatic deposits and `antseed deposit`.
 *
 * The buyer never holds funds and never pays gas: the sweep is authorized
 * off-chain (EIP-3009 receive authorization) and broadcast by whichever peer
 * relays it — this module signs and waits, it never sends a transaction.
 *
 * All I/O is injected so the same engine runs inside the buyer daemon
 * (dispatch through the live node) and inside one-shot CLI commands
 * (dispatch through an ephemeral node).
 */
import { buildReceiveAuthorization, makeUsdcDomain } from '@antseed/node'
import type { Identity, SweepReceiptPayload, SweepRequestPayload } from '@antseed/node'
import { log } from './request-utils.js'

export type DepositWatchPhase = 'deferred' | 'received' | 'sweeping' | 'credited' | 'error'

/**
 * Why a sweep is waiting instead of running.
 * below-minimum — the wallet can't cover the relay fee plus the contract's
 *   first-deposit floor (or, once funded, more than the fee). More USDC must
 *   arrive before anything moves.
 * credit-limit — the deposits balance is at the buyer's credit limit; the
 *   wallet tops up automatically as spending frees headroom.
 */
export type DepositDeferReason = 'below-minimum' | 'credit-limit'

export interface DepositWatchEvent {
  /** Monotonic per-watcher counter so pollers can forward each event exactly once. */
  seq: number
  phase: DepositWatchPhase
  amountBaseUnits?: string
  txHash?: string
  error?: string
  /** Set on 'deferred' events. */
  reason?: DepositDeferReason
  /** below-minimum only: the wallet balance a sweep needs (fee included). */
  minRequiredBaseUnits?: string
  at: number
}

/**
 * active — a deposit flow is on screen (desktop view, gateway console or
 *   `antseed deposit`). The gateway console re-requests it as a heartbeat and
 *   without one for `DEPOSIT_WATCH_ACTIVE_TTL_MS` it falls back to background
 *   on its own; other callers keep it until they demote it.
 * background — the flow closed; card/Fun deliveries can land minutes later,
 *   so keep a slow poll until the linger window passes with an empty wallet.
 * idle — the daemon's resting cadence (auto-sweep on): watch forever, cheaply.
 * off — not polling.
 */
export type DepositWatchMode = 'active' | 'background' | 'idle' | 'off'

export interface DepositWatcherStatus {
  mode: DepositWatchMode
  address: string
  /** Last observed hot-wallet USDC balance in base units. */
  usdcBalance: string
  sweepInFlight: boolean
  lastEvent: DepositWatchEvent | null
}

/** The read surface the watcher needs; DepositsClient satisfies it. */
export interface DepositWatcherDepositsReader {
  getUSDCBalance(address: string): Promise<bigint>
  getBuyerBalance(address: string): Promise<{ available: bigint; reserved: bigint }>
  getBuyerCreditLimit(address: string): Promise<bigint>
  /** The contract's first-deposit floor; the constant fallback covers readers without it. */
  getMinBuyerDeposit?(): Promise<bigint>
}

/** The relay surface the watcher needs; DepositRelayClient satisfies it. */
export interface DepositWatcherRelayReader {
  fee(): Promise<bigint>
  verifyUsdcDomain(usdcAddress: string, domain: ReturnType<typeof makeUsdcDomain>): Promise<boolean>
  getSweepConfirmation(
    txHash: string,
    expected: { buyer: string; deposited: bigint; fee: bigint; authNonce: string },
  ): Promise<{ deposited: bigint; txHash: string } | null>
  isAuthorizationUsed(usdcAddress: string, authorizer: string, nonce: string): Promise<boolean>
}

export interface DepositWatcherDeps {
  wallet: Identity['wallet']
  address: string
  depositsClient: DepositWatcherDepositsReader
  relayClient: DepositWatcherRelayReader
  usdcAddress: string
  evmChainId: number
  depositRelayAddress: string
  /** Offer the signed payload to relayers (one at a time, via a node). */
  dispatch: (payload: SweepRequestPayload) => Promise<{ offered: number; accepted: boolean }>
  /** Refresh discovery and connect to a few relay-capable peers. */
  connectRelayers: () => Promise<void>
  /** Latest relayer receipt for a sweep authNonce, if one arrived. */
  getReceipt: (authNonce: string) => Promise<SweepReceiptPayload | null>
  onEvent?: (event: DepositWatchEvent) => void
  /** Resting cadence once the background linger expires; null stops instead. */
  idleIntervalMs?: number | null
  /**
   * Shared poll loop for many watchers (the buyer daemon's wallets): one
   * batched balance read per tick instead of a timer and a read per wallet.
   * Without it the watcher polls on its own timer (one-shot commands).
   */
  scheduler?: DepositWatchScheduler
}

/** What a shared poll loop needs from a watcher; `DepositWatchHub` implements the other side. */
export interface DepositWatchScheduler {
  /** Poll the watcher every `intervalMs` (replacing an earlier registration); null unregisters. */
  schedule(watcher: DepositWatcher, intervalMs: number | null, options?: { pollNow?: boolean }): void
}

export const DEPOSIT_WATCH_ACTIVE_INTERVAL_MS = 2_000
export const DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS = 15_000
export const DEPOSIT_WATCH_IDLE_INTERVAL_MS = 30_000
/** A gateway console's active watch lapses to background unless promoted again within this window. */
export const DEPOSIT_WATCH_ACTIVE_TTL_MS = 5 * 60_000
// How long the background watch keeps polling an empty wallet before falling
// back to idle (or stopping). Any activity re-arms it.
const DEPOSIT_WATCH_LINGER_MS = 30 * 60_000
const SWEEP_AUTH_VALIDITY_SECS = 3_600
const SWEEP_CONFIRM_TIMEOUT_MS = 120_000
const SWEEP_POLL_INTERVAL_MS = 1_000
// After a failed/incomplete sweep the funds stay in the wallet; retry on the
// watcher tick once this cooldown passes instead of hammering the network.
const SWEEP_RETRY_COOLDOWN_MS = 60_000
// AntseedDeposits enforces a minimum first deposit (net of the fee). Read
// from the contract; this is the fallback when the read fails.
const MIN_FIRST_DEPOSIT_BASE_UNITS = 1_000_000n
// Minimum top-up when the sweep is clamped by the credit-limit headroom.
// Without a floor, a wallet holding more than the remaining headroom would
// grind it into the limit gap in dust increments — paying the fixed relay
// fee on each sliver every time spending frees a few cents of headroom.
const MIN_TOPUP_BASE_UNITS = 1_000_000n

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DepositWatcher {
  private readonly _deps: DepositWatcherDeps
  private _timer: NodeJS.Timeout | null = null
  /**
   * The two kinds of active hold: the gateway console's heartbeat (a TTL that
   * runs out) and the desktop's / `antseed deposit`'s (held until demoted).
   * The watch stays active while either holds.
   */
  private _activeExpiry: NodeJS.Timeout | null = null
  private _heldUntilDemoted = false
  private _mode: DepositWatchMode = 'off'
  private _lingerDeadline = 0
  private _lastBalance = 0n
  private _sweepInFlight = false
  private _lastSweepAttemptAt = 0
  private _lastEvent: DepositWatchEvent | null = null
  private _seq = 0
  private _stopped = false
  private _minFirstDeposit: bigint | null = null

  constructor(deps: DepositWatcherDeps) {
    this._deps = deps
  }

  get address(): string {
    return this._deps.address
  }

  get mode(): DepositWatchMode {
    return this._mode
  }

  status(): DepositWatcherStatus {
    return {
      mode: this._mode,
      address: this._deps.address,
      usdcBalance: this._lastBalance.toString(),
      sweepInFlight: this._sweepInFlight,
      lastEvent: this._lastEvent,
    }
  }

  /**
   * A deposit flow is on screen: poll fast, sweep existing funds promptly.
   * With `ttlMs` (the gateway console) it lapses to background unless
   * promoted again, so a page that closed without demoting does not keep the
   * fast poll forever; without it, it stays active until demoted.
   */
  promote(ttlMs: number | null = null): void {
    if (this._stopped) return
    this._setMode('active', DEPOSIT_WATCH_ACTIVE_INTERVAL_MS, { pollNow: true })
    if (ttlMs === null) {
      this._heldUntilDemoted = true
      return
    }
    this._clearActiveExpiry()
    this._activeExpiry = setTimeout(() => {
      this._activeExpiry = null
      if (this._mode === 'active' && !this._heldUntilDemoted) this._toBackground()
    }, ttlMs)
    this._activeExpiry.unref?.()
  }

  /**
   * The deposit flow closed: don't stop — deliveries (card/Fun purchases) can
   * land minutes later. Keep polling at the background cadence; once the
   * linger window passes with an empty wallet, fall back to the idle cadence
   * (or stop when idle polling is disabled). Releases only the hold taken
   * without a TTL: a gateway console's heartbeat keeps the watch active.
   */
  demote(): void {
    this._heldUntilDemoted = false
    if (this._mode === 'active' && this._activeExpiry) return
    this._toBackground()
  }

  /** Start the daemon's resting watch (auto-sweep). */
  startIdle(): void {
    this._setMode('idle', this._deps.idleIntervalMs ?? DEPOSIT_WATCH_IDLE_INTERVAL_MS, { pollNow: true })
  }

  stop(): void {
    this._stopped = true
    this._rest()
  }

  private _toBackground(): void {
    this._clearActiveExpiry()
    this._lingerDeadline = Date.now() + DEPOSIT_WATCH_LINGER_MS
    this._setMode('background', DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS)
  }

  /** Stop polling until promoted again (auto-sweep off: nothing to watch once the flow is over). */
  private _rest(): void {
    this._clearTimer()
    this._clearActiveExpiry()
    this._heldUntilDemoted = false
    this._mode = 'off'
    this._deps.scheduler?.schedule(this, null)
  }

  /** Poll every `intervalMs`; `pollNow` also polls right away (debounced by a shared loop). */
  private _setMode(mode: Exclude<DepositWatchMode, 'off'>, intervalMs: number, options: { pollNow?: boolean } = {}): void {
    if (this._stopped) return
    this._clearTimer()
    this._mode = mode
    if (this._deps.scheduler) {
      this._deps.scheduler.schedule(this, intervalMs, options)
      return
    }
    this._timer = setInterval(() => { void this._poll() }, intervalMs)
    // A busy interval must never pile up sweeps; the in-flight guard makes
    // overlapping polls harmless, so unref keeps the timer from holding the
    // process open in one-shot commands.
    this._timer.unref?.()
    if (options.pollNow) void this._poll()
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  private _clearActiveExpiry(): void {
    if (this._activeExpiry) {
      clearTimeout(this._activeExpiry)
      this._activeExpiry = null
    }
  }

  private _emit(event: Omit<DepositWatchEvent, 'seq' | 'at'>): void {
    this._lastEvent = { ...event, seq: ++this._seq, at: Date.now() }
    this._deps.onEvent?.(this._lastEvent)
  }

  private async _poll(): Promise<void> {
    if (this._stopped) return
    let balance: bigint
    try {
      balance = await this._deps.depositsClient.getUSDCBalance(this._deps.address)
    } catch {
      return // transient RPC failure — try again next tick
    }
    this.applyBalance(balance)
  }

  /** One observed hot-wallet balance (from this watcher's own read or a shared loop's batch). */
  applyBalance(balance: bigint): void {
    if (this._stopped) return
    if (this._mode === 'background') {
      if (balance > 0n || this._sweepInFlight) {
        this._lingerDeadline = Date.now() + DEPOSIT_WATCH_LINGER_MS
      } else if (Date.now() > this._lingerDeadline) {
        if (this._deps.idleIntervalMs === null) this._rest()
        else this._setMode('idle', this._deps.idleIntervalMs ?? DEPOSIT_WATCH_IDLE_INTERVAL_MS)
        return
      }
    }
    if (balance > this._lastBalance) {
      const delta = balance - this._lastBalance
      this._lastBalance = balance
      this._emit({ phase: 'received', amountBaseUnits: delta.toString() })
      void this.sweepNow()
    } else if (balance < this._lastBalance) {
      this._lastBalance = balance
    } else if (balance > 0n && !this._sweepInFlight && Date.now() - this._lastSweepAttemptAt > SWEEP_RETRY_COOLDOWN_MS) {
      // Funds from an earlier failed/partial sweep are still sitting in the
      // wallet — retry once the cooldown passes.
      void this.sweepNow()
    }
  }

  /** Sign and dispatch one sweep of the current hot-wallet balance. */
  async sweepNow(): Promise<void> {
    if (this._sweepInFlight) return
    this._sweepInFlight = true
    this._lastSweepAttemptAt = Date.now()
    try {
      await this._sweepOnce()
    } catch (err) {
      this._emit({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this._sweepInFlight = false
    }
  }

  private async _sweepOnce(): Promise<void> {
    const { depositsClient, relayClient, address, wallet } = this._deps

    const [usdcBalance, deposits, creditLimit, fee, minFirstDeposit] = await Promise.all([
      depositsClient.getUSDCBalance(address),
      depositsClient.getBuyerBalance(address),
      depositsClient.getBuyerCreditLimit(address),
      relayClient.fee(),
      this._readMinFirstDeposit(),
    ])

    const depositsBalance = deposits.available + deposits.reserved
    // Below the sweepable minimum (fee, plus the contract's first-deposit
    // floor) — keep waiting; more USDC may still be on the way. Say so, so
    // the UI can ask for the shortfall instead of spinning on "preparing".
    const minRequired = depositsBalance === 0n ? minFirstDeposit + fee : fee + 1n
    if (usdcBalance < minRequired) {
      this._emitDeferred({
        reason: 'below-minimum',
        amountBaseUnits: usdcBalance.toString(),
        minRequiredBaseUnits: minRequired.toString(),
      })
      return
    }

    // Deposits caps the credited balance at the buyer's credit limit; a net
    // amount past it would revert the whole sweep, so clamp and leave the
    // rest in the wallet for a later sweep.
    const headroom = creditLimit > depositsBalance ? creditLimit - depositsBalance : 0n
    if (headroom === 0n) {
      this._emitDeferred({ reason: 'credit-limit' })
      return
    }
    // Headroom-clamped top-up: wait until at least MIN_TOPUP_BASE_UNITS of
    // headroom is free instead of sweeping fee-heavy slivers repeatedly.
    if (usdcBalance - fee > headroom && headroom < MIN_TOPUP_BASE_UNITS) {
      this._emitDeferred({ reason: 'credit-limit' })
      return
    }
    let amount = usdcBalance
    if (amount - fee > headroom) amount = headroom + fee

    this._emit({ phase: 'sweeping', amountBaseUnits: amount.toString() })

    // A wrong USDC domain (name/version differ per deployment) would produce
    // signatures the token silently rejects — refuse to sign.
    const usdcDomain = makeUsdcDomain(this._deps.evmChainId, this._deps.usdcAddress)
    const domainOk = await relayClient.verifyUsdcDomain(this._deps.usdcAddress, usdcDomain)
    if (!domainOk) {
      throw new Error('USDC EIP-712 domain mismatch — refusing to sign the sweep authorization.')
    }

    // The single EIP-3009 signature, addressed to the relay contract, is the
    // consent to its immutable fixed FEE — no second signature.
    const nowSecs = Math.floor(Date.now() / 1000)
    const validAfter = nowSecs - 60
    const validBefore = nowSecs + SWEEP_AUTH_VALIDITY_SECS
    const { message, signature: sig3009 } = await buildReceiveAuthorization(wallet, usdcDomain, {
      to: this._deps.depositRelayAddress,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
    })

    const payload: SweepRequestPayload = {
      version: 1,
      evmChainId: this._deps.evmChainId,
      relayAddress: this._deps.depositRelayAddress,
      from: address,
      amount: amount.toString(),
      validAfter,
      validBefore,
      nonce: message.nonce,
      sig3009,
    }

    let dispatch = await this._deps.dispatch(payload)
    if (dispatch.offered === 0) {
      await this._deps.connectRelayers()
      dispatch = await this._deps.dispatch(payload)
    }
    if (dispatch.offered === 0) {
      throw new Error('No deposit relayers are reachable right now. Your USDC is safe in the wallet — retrying automatically.')
    }
    // accepted === false means every relayer in the round declined (or stayed
    // silent) — fail fast into the watcher's retry instead of waiting out the
    // full confirmation window.
    if (!dispatch.accepted) {
      throw new Error('No deposit relayer accepted the request right now. Your USDC is safe in the wallet — retrying automatically.')
    }

    const result = await this._waitForConfirmation({
      initialTotal: depositsBalance,
      expectedNet: amount - fee,
      fee,
      authNonce: message.nonce,
    })
    if (!result) {
      throw new Error('The deposit was not confirmed in time. Your USDC is safe in the wallet — retrying automatically.')
    }

    this._lastBalance = await depositsClient.getUSDCBalance(address).catch(() => 0n)
    this._emit({
      phase: 'credited',
      amountBaseUnits: result.credited.toString(),
      ...(result.txHash ? { txHash: result.txHash } : {}),
    })
    // The on-chain fallbacks often confirm before the relayer's 'confirmed'
    // receipt (the only carrier of the tx hash) arrives. Never delay the
    // credited status for it — backfill the hash when the receipt lands.
    if (!result.txHash) {
      void this._pollReceiptTxHash(message.nonce, 15_000).then((txHash) => {
        if (!txHash || this._stopped) return
        this._emit({ phase: 'credited', amountBaseUnits: result.credited.toString(), txHash })
      })
    }
  }

  /** Emit a deferral once — the 60s retry would otherwise repeat it forever. */
  private _emitDeferred(event: Omit<DepositWatchEvent, 'seq' | 'at' | 'phase'>): void {
    const last = this._lastEvent
    if (
      last?.phase === 'deferred'
      && last.reason === event.reason
      && last.amountBaseUnits === event.amountBaseUnits
      && last.minRequiredBaseUnits === event.minRequiredBaseUnits
    ) return
    this._emit({ phase: 'deferred', ...event })
  }

  private async _readMinFirstDeposit(): Promise<bigint> {
    if (this._minFirstDeposit !== null) return this._minFirstDeposit
    const { depositsClient } = this._deps
    if (!depositsClient.getMinBuyerDeposit) return MIN_FIRST_DEPOSIT_BASE_UNITS
    try {
      this._minFirstDeposit = await depositsClient.getMinBuyerDeposit()
      return this._minFirstDeposit
    } catch (err) {
      log(`MIN_BUYER_DEPOSIT read failed, assuming ${MIN_FIRST_DEPOSIT_BASE_UNITS} base units: ${err instanceof Error ? err.message : String(err)}`)
      return MIN_FIRST_DEPOSIT_BASE_UNITS // transient — re-read next sweep
    }
  }

  // Source of truth is on-chain: a matching SweepExecuted relay event, the
  // consumed EIP-3009 authorization, or the deposits-balance increase. Relayer
  // receipts only surface the txHash faster; zero receipts must be tolerated.
  private async _waitForConfirmation(params: {
    initialTotal: bigint
    expectedNet: bigint
    fee: bigint
    authNonce: string
  }): Promise<{ credited: bigint; txHash?: string } | null> {
    const { initialTotal, expectedNet, fee, authNonce } = params
    const { depositsClient, relayClient, address } = this._deps
    const deadline = Date.now() + SWEEP_CONFIRM_TIMEOUT_MS
    let txHash: string | undefined

    while (Date.now() < deadline) {
      const receipt = await this._deps.getReceipt(authNonce).catch(() => null)
      if (receipt?.txHash) txHash = receipt.txHash

      if (txHash) {
        const confirmation = await relayClient.getSweepConfirmation(txHash, {
          buyer: address,
          deposited: expectedNet,
          fee,
          authNonce,
        }).catch(() => null)
        if (confirmation) {
          return { credited: confirmation.deposited, txHash: confirmation.txHash }
        }
      }

      const authorizationUsed = await relayClient.isAuthorizationUsed(this._deps.usdcAddress, address, authNonce).catch(() => false)
      if (authorizationUsed) {
        return { credited: expectedNet, ...(txHash ? { txHash } : {}) }
      }

      const current = await depositsClient.getBuyerBalance(address).catch(() => null)
      if (current && current.available + current.reserved >= initialTotal + expectedNet) {
        return { credited: current.available + current.reserved - initialTotal, ...(txHash ? { txHash } : {}) }
      }

      await sleep(SWEEP_POLL_INTERVAL_MS)
    }
    return null
  }

  private async _pollReceiptTxHash(authNonce: string, graceMs: number): Promise<string | undefined> {
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      const receipt = await this._deps.getReceipt(authNonce).catch(() => null)
      if (receipt?.txHash) return receipt.txHash
      await sleep(1_000)
    }
    return undefined
  }
}
