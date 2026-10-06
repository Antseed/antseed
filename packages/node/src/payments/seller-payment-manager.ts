import { type AbstractSigner, keccak256, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  PaymentRequiredPayload,
  CloseChannelRequestPayload,
  CloseChannelResultPayload,
  CloseChannelRejectCode,
} from '../types/protocol.js';
import { ChannelsClient } from './evm/channels-client.js';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  makeChannelsDomain,
  encodeMetadata,
  ZERO_METADATA,
} from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { peerIdToAddress } from '../types/peer.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from './channel-store.js';
import { classifyOnChainChannel, matchesChannelParties } from './channel-session-state.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  channelsContractAddress: string;
  chainId: number;
  dataDir: string;
  /** Minimum USDC per request (base units). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Whether to immediately settle when buyer disconnects. Default: true. */
  settleOnDisconnect?: boolean;
  /**
   * Minimum unsettled delta (base units) required before idle settle will
   * submit a tx. Skips tiny settles whose gas cost exceeds the amount being
   * claimed. Only applied in `settleOnly` mode — final close() always settles
   * the full amount so no dust is left behind. Default: "2000" (~$0.002).
   */
  minSettleDelta?: string;
  /** Serve channels whose buyer already requested close on-chain, risking uncollectible work. Default: false. */
  serveWhileClosePending?: boolean;
}

/** Default minimum budget per request: $0.50 USDC (base units). */
const DEFAULT_MIN_BUDGET_PER_REQUEST = '500000';

/** ~200× typical Base settle gas cost at 0.006 gwei. */
export const DEFAULT_MIN_SETTLE_DELTA_STR = '2000';
const DEFAULT_MIN_SETTLE_DELTA = BigInt(DEFAULT_MIN_SETTLE_DELTA_STR);

/**
 * How long a buyer-requested close waits for an in-flight SpendingAuth to land
 * before declaring the channel still mid-accumulation. Mirrors the request
 * path's catch-up wait: the buyer's auth for the last response may still be on
 * the wire when the close request arrives.
 */
const CLOSE_CATCH_UP_WAIT_MS = 5_000;
/** `retryAfterMs` hint returned with 'busy' / 'pending_auth' rejections. */
const CLOSE_RETRY_AFTER_MS = 2_000;

const TOP_UP_THRESHOLD_NOT_MET_SELECTOR = '0x1ea4506b';
const INSUFFICIENT_BALANCE_SELECTOR = '0xf4d678b8';
const IN_FLIGHT_TX_LIMIT_PHRASE = 'in-flight transaction limit';
/** Backoff stays well inside the buyer's 30-second AuthAck timeout. */
const RESERVE_BACKPRESSURE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

type TopUpFailureKind = 'retryable-threshold' | 'retryable-tx-backpressure' | 'insufficient-balance' | 'non-retryable';
/** `amount`/`txHash` describe the close actually submitted on-chain, which may
 *  differ from what a caller that joined an in-flight close intended to submit. */
type CloseResult =
  | { closed: true; amount: bigint; txHash: string }
  | { closed: false; error: unknown };

/** Stored auth entry for buyer's SpendingAuth signature. */
interface LatestAuth {
  spendingAuthSig: string;
  cumulativeAmount: bigint;
  metadataHash: string;
  metadata: string;
}

/**
 * Manages seller-side payment sessions.
 * The buyer sends a single SpendingAuth signature with a monotonically
 * increasing cumulativeAmount on every request.
 * The seller tracks spending locally and settles/closes via the contract at session end.
 */
export class SellerPaymentManager {
  private readonly _signer: AbstractSigner;
  private readonly _channelsClient: ChannelsClient;
  private readonly _config: SellerPaymentConfig;
  private readonly _channelStore: ChannelStore;
  /** Lazily resolved: real AntseedChannels address (for EIP-712 domain +
   *  on-chain seller address detection). If the configured
   *  `channelsContractAddress` is a seller facade (e.g. DiemStakingProxy),
   *  this resolves to the underlying channels contract via the facade's
   *  `channelsAddress()` view. Otherwise equals the configured address. */
  private _resolvedAddresses: Promise<{
    /** Underlying AntseedChannels address — used for the EIP-712 domain. */
    channels: string;
    /** On-chain seller address: proxy when behind a facade, wallet otherwise. */
    seller: string;
  }> | null = null;
  /**
   * In-memory cache of buyer peerIds with an active payment session. Hydrated
   * sessions are included for existing hasSession() semantics; `_hydratedChannelIds`
   * lets timeout cleanup distinguish restart-only zero-auth zombies.
   */
  private readonly _activeBuyers = new Set<string>();
  private readonly _buyerDisconnectMarkers = new Map<string, object>();

  /** Channels restored from disk before the buyer has proven it reconnected. */
  private readonly _hydratedChannelIds = new Set<string>();
  /** Per-buyer mutex to prevent concurrent handleSpendingAuth for the same buyer. */
  private readonly _buyerLocks = new Map<string, Promise<void>>();

  /** channelId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
  private readonly _acceptedCumulative = new Map<string, bigint>();

  /** channelId -> total USDC spent so far (sum of recordSpend calls) */
  private readonly _spent = new Map<string, bigint>();

  /** channelId -> on-chain reserveMaxAmount (budget ceiling from ReserveAuth) */
  private readonly _reserveMax = new Map<string, bigint>();

  /** channelId -> latest buyer-signed auth (both sigs + cumulative values + metadata) for settle/close */
  private readonly _latestAuth = new Map<string, LatestAuth>();

  /**
   * channelId -> waiters blocked on acceptedCumulative reaching a target.
   * Used to hide the NeedAuth → SpendingAuth round-trip latency from the next
   * request: if a new request arrives while the prior response's NeedAuth is
   * still on the wire, the request handler parks on this waiter instead of
   * 402ing immediately. `resolve(true)` means the target was reached;
   * `resolve(false)` means the channel was evicted before that could happen.
   */
  private readonly _acceptedWaiters = new Map<string, Array<{ target: bigint; resolve: (reached: boolean) => void }>>();

  /** channelId -> number of failed close() attempts. In-memory only; resets on node restart. */
  private readonly _closeRetryCount = new Map<string, number>();

  /** channelId -> deferred topUp params when on-chain topUp failed (e.g. TopUpThresholdNotMet).
   *  Retried after the next SpendingAuth raises the settle amount high enough.
   *  Latest / largest top-up intent wins: if multiple deferred ReserveAuths arrive
   *  before a retry succeeds, we keep the most recent higher ceiling because it
   *  subsumes the older request. */
  private readonly _pendingTopUp = new Map<string, { newMaxAmount: bigint; deadline: number; reserveAuthSig: string }>();

  /** Channels that must not serve more paid work until closed/renegotiated. */
  private readonly _blockedChannels = new Set<string>();

  /**
   * channelId -> in-flight close() result. Every close path shares this map so
   * replacement negotiation can await an existing close instead of submitting
   * a duplicate transaction.
   */
  private readonly _closingChannels = new Map<string, Promise<CloseResult>>();

  /**
   * buyerPeerId -> number of billable requests currently being served.
   * Incremented before the provider call and decremented only after the
   * request's spend has been recorded and its NeedAuth sent, so a non-zero
   * count means "this buyer is still accumulating" and the channel must not be
   * closed out from under it.
   */
  private readonly _inFlightRequests = new Map<string, number>();

  /** channelId -> cumulative amount last successfully settled on-chain by this
   *  process. Lets the idle-settle loop skip the `getSession` RPC when the
   *  local accepted cumulative hasn't moved since our last settle. */
  private readonly _lastSettledCumulative = new Map<string, bigint>();

  private readonly _minSettleDelta: bigint;

  private readonly _serveWhileClosePending: boolean;

  /** Max close() retries before giving up (buyer must requestClose on-chain) */
  private static readonly MAX_CLOSE_RETRIES = 3;

  constructor(identity: Identity, config: SellerPaymentConfig, channelStore: ChannelStore) {
    this._config = config;
    this._signer = identity.wallet;
    const channelsClient = new ChannelsClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.channelsContractAddress,
      evmChainId: config.chainId,
    });
    this._channelsClient = channelsClient;
    // Kick off address resolution in the background; every async call site
    // awaits `_resolvedAddresses` before using the EIP-712 domain or the
    // on-chain seller address.
    const identityAddress = identity.wallet.address;
    this._resolvedAddresses = (async () => {
      const channels = await channelsClient.readAddress;
      const configured = channelsClient.contractAddress;
      const seller = channels.toLowerCase() !== configured.toLowerCase()
        ? configured      // facade mode: seller on-chain = proxy = configured addr
        : identityAddress; // no facade: seller = peer wallet
      return { channels, seller };
    })();
    this._channelStore = channelStore;
    this._minSettleDelta = config.minSettleDelta !== undefined
      ? BigInt(config.minSettleDelta)
      : DEFAULT_MIN_SETTLE_DELTA;

    this._serveWhileClosePending = config.serveWhileClosePending ?? false;

    // Hydrate from persisted channels
    const activeChannels = this._channelStore.getActiveChannels(CHANNEL_ROLE.SELLER);
    for (const channel of activeChannels) {
      this._activeBuyers.add(channel.peerId);
      this._hydratedChannelIds.add(channel.sessionId);
      this._acceptedCumulative.set(channel.sessionId, BigInt(channel.authMax));
      this._spent.set(channel.sessionId, BigInt(channel.tokensDelivered));
      // Hydrate reserveMax from previousConsumption (repurposed field)
      const storedReserveMax = BigInt(channel.previousConsumption || '0');
      if (storedReserveMax > 0n) {
        this._reserveMax.set(channel.sessionId, storedReserveMax);
      }
      // Hydrate latest auth sigs so close() works after restart
      if (channel.latestSpendingAuthSig) {
        this._latestAuth.set(channel.sessionId, {
          spendingAuthSig: channel.latestSpendingAuthSig,
          cumulativeAmount: BigInt(channel.authMax),
          metadataHash: '',
          metadata: channel.latestMetadata ?? '',
        });
      }
    }
  }

  /**
   * Validate hydrated channels against on-chain state.
   * Evicts channels that no longer exist or are no longer active on-chain.
   * Must be called after construction (async, cannot run in constructor).
   */
  async validateHydratedChannels(): Promise<void> {
    const activeChannels = this._channelStore.getActiveChannels(CHANNEL_ROLE.SELLER);
    if (activeChannels.length === 0) return;

    const { seller: sellerEvmAddr } = await this._resolvedAddresses!;
    let evicted = 0;

    for (const channel of activeChannels) {
      try {
        const onChainState = classifyOnChainChannel(
          await this._channelsClient.getSession(channel.sessionId),
        );

        if (!onChainState.exists || (onChainState.status !== 'active' && onChainState.status !== 'unknown')) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, `on-chain status=${onChainState.exists ? onChainState.status : 'missing'}`);
          evicted++;
          continue;
        }

        if (!matchesChannelParties(onChainState.channel, channel.buyerEvmAddr, sellerEvmAddr)) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, 'on-chain parties mismatch');
          evicted++;
          continue;
        }

        // Close requested while this seller was offline — the event poller
        // starts at the current block and would miss it. Handle it as if live.
        if (onChainState.channel.closeRequestedAt > 0n && !this._serveWhileClosePending) {
          await this.handleCloseRequested(channel.sessionId);
          evicted++;
          continue;
        }

        // Reconcile: if on-chain settled > local spent, update local to avoid double-charging
        const onChainSettled = onChainState.channel.settled;
        const localSpent = this._spent.get(channel.sessionId) ?? 0n;
        if (onChainSettled > localSpent) {
          this._spent.set(channel.sessionId, onChainSettled);
          // Clear auth only if its cumulative would revert settle() with InvalidAmount
          // (cumulativeAmount must be > on-chain settled). If auth is still valid
          // (cumulative > settled), keep it so the seller can close if buyer disconnects.
          const existingAuth = this._latestAuth.get(channel.sessionId);
          if (existingAuth && existingAuth.cumulativeAmount <= onChainSettled) {
            this._latestAuth.delete(channel.sessionId);
            debugLog(`[SellerPayment] Reconciled spent for ${channel.sessionId.slice(0, 18)}...: local=${localSpent} → on-chain=${onChainSettled} (cleared stale auth, authCumulative=${existingAuth.cumulativeAmount})`);
          } else {
            debugLog(`[SellerPayment] Reconciled spent for ${channel.sessionId.slice(0, 18)}...: local=${localSpent} → on-chain=${onChainSettled}`);
          }
        }
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to validate channel ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
        // Keep channel hydrated on RPC failure — periodic check will retry
      }
    }

    if (evicted > 0) {
      debugLog(`[SellerPayment] Startup validation: evicted ${evicted}/${activeChannels.length} stale channel(s)`);
    }
  }

  private _evictStaleChannel(
    channelId: string,
    peerId: string,
    reason: string,
    status: typeof CHANNEL_STATUS.SETTLED | typeof CHANNEL_STATUS.TIMEOUT = CHANNEL_STATUS.SETTLED,
  ): void {
    this._channelStore.updateChannelStatus(channelId, status);
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._hydratedChannelIds.delete(channelId);
    this._reserveMax.delete(channelId);
    this._pendingTopUp.delete(channelId);
    this._blockedChannels.delete(channelId);
    this._lastSettledCumulative.delete(channelId);
    this._releaseAcceptedWaiters(channelId);
    this._deactivateBuyerForChannel(peerId, channelId);
    debugLog(`[SellerPayment] Evicted stale channel ${channelId.slice(0, 18)}... — ${reason}`);
  }

  /** Remove connectivity only if it still belongs to the channel being cleaned up. */
  private _deactivateBuyerForChannel(peerId: string, channelId: string): void {
    const current = this._channelStore.getActiveChannelByPeer(peerId, CHANNEL_ROLE.SELLER);
    if (!current || current.sessionId === channelId) {
      this._activeBuyers.delete(peerId);
      if (current) this._buyerDisconnectMarkers.set(peerId, {});
      else this._buyerDisconnectMarkers.delete(peerId);
    }
  }

  /**
   * Submit at most one close transaction per channel and share its outcome.
   * Callers that join an in-flight close receive the amount that close actually
   * submitted, not the one they asked for — persist that, not `amount`.
   */
  private _submitClose(channelId: string, amount: bigint, submit: () => Promise<string>): Promise<CloseResult> {
    const existing = this._closingChannels.get(channelId);
    if (existing) return existing;

    const operation: Promise<CloseResult> = submit().then(
      (txHash: string) => ({ closed: true as const, amount, txHash }),
      (error: unknown) => ({ closed: false as const, error }),
    );
    this._closingChannels.set(channelId, operation);
    void operation.finally(() => {
      if (this._closingChannels.get(channelId) === operation) {
        this._closingChannels.delete(channelId);
      }
    });
    return operation;
  }

  /**
   * Restore a persisted SpendingAuth after in-memory cleanup. This prevents the
   * timeout checker from mistaking an active channel with a durable signed auth
   * for a zero-auth zombie and closing it at the already-settled amount.
   */
  private _restorePersistedSpendingAuth(channel: StoredChannel): bigint | null {
    const persistedCumulative = BigInt(channel.authMax || '0');
    if (persistedCumulative <= 0n || !channel.latestSpendingAuthSig) {
      return null;
    }

    this._acceptedCumulative.set(channel.sessionId, persistedCumulative);
    this._latestAuth.set(channel.sessionId, {
      spendingAuthSig: channel.latestSpendingAuthSig,
      cumulativeAmount: persistedCumulative,
      metadataHash: '',
      metadata: channel.latestMetadata ?? '',
    });
    this._spent.set(channel.sessionId, BigInt(channel.tokensDelivered || '0'));

    const storedReserveMax = BigInt(channel.previousConsumption || '0');
    if (storedReserveMax > 0n) {
      this._reserveMax.set(channel.sessionId, storedReserveMax);
    }

    this._hydratedChannelIds.delete(channel.sessionId);
    this._notifyAcceptedUpdate(channel.sessionId, persistedCumulative);
    debugLog(`[SellerPayment] Restored persisted SpendingAuth for ${channel.sessionId.slice(0, 18)}... cumulative=${persistedCumulative}`);
    return persistedCumulative;
  }

  /**
   * Block until `acceptedCumulative(channelId)` reaches `target`, or `timeoutMs`
   * elapses. Returns true if the target was reached, false on timeout. Used by
   * the request handler to wait out the buyer's NeedAuth → SpendingAuth round
   * trip when a follow-up request arrives before the catch-up auth has landed.
   */
  awaitAcceptedAtLeast(channelId: string, target: bigint, timeoutMs: number): Promise<boolean> {
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;
    if (accepted >= target) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const waiter = {
        target,
        resolve: (reached: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(reached);
        },
      };
      const waiters = this._acceptedWaiters.get(channelId) ?? [];
      waiters.push(waiter);
      this._acceptedWaiters.set(channelId, waiters);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = this._acceptedWaiters.get(channelId);
        if (list) {
          const filtered = list.filter((w) => w !== waiter);
          if (filtered.length > 0) this._acceptedWaiters.set(channelId, filtered);
          else this._acceptedWaiters.delete(channelId);
        }
        resolve(false);
      }, timeoutMs);
    });
  }

  private _notifyAcceptedUpdate(channelId: string, newAccepted: bigint): void {
    const waiters = this._acceptedWaiters.get(channelId);
    if (!waiters || waiters.length === 0) return;
    const remaining: typeof waiters = [];
    for (const w of waiters) {
      if (newAccepted >= w.target) w.resolve(true);
      else remaining.push(w);
    }
    if (remaining.length > 0) this._acceptedWaiters.set(channelId, remaining);
    else this._acceptedWaiters.delete(channelId);
  }

  /**
   * Wake all waiters for a channel with `reached=false` — the target can no
   * longer be reached (channel evicted, settled, or closed). Preserves the
   * `awaitAcceptedAtLeast` contract: `true` only when the target was actually
   * hit, `false` otherwise.
   */
  private _releaseAcceptedWaiters(channelId: string): void {
    const waiters = this._acceptedWaiters.get(channelId);
    if (!waiters) return;
    for (const w of waiters) w.resolve(false);
    this._acceptedWaiters.delete(channelId);
  }

  get channelsClient(): ChannelsClient {
    return this._channelsClient;
  }

  // ── SpendingAuth handler ─────────────────────────────────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * First auth: verify SpendingAuth, reserve on-chain, send AuthAck.
   * Subsequent: verify SpendingAuth signature, validate monotonic increase, persist.
   */
  async handleSpendingAuth(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    const disconnectMarker = this._buyerDisconnectMarkers.get(buyerPeerId);
    // Per-buyer mutex: serialize concurrent auths for the same buyer
    const existing = this._buyerLocks.get(buyerPeerId);
    let result: 'accepted' | 'reserved' | 'rejected' = 'rejected';
    const lock = (existing ?? Promise.resolve()).then(async () => {
      result = await this._handleSpendingAuthInner(buyerPeerId, payload, paymentMux, disconnectMarker);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    await lock;
    return result;
  }

  /**
   * Wait for any in-flight SpendingAuth processing for this buyer to complete.
   * Used by the request handler so a budget check doesn't race an on-chain top-up
   * (whose follow-up auths are queued behind the per-buyer mutex).
   */
  async waitForPendingAuths(buyerPeerId: string): Promise<void> {
    const pending = this._buyerLocks.get(buyerPeerId);
    if (pending) {
      await pending;
    }
  }

  private async _handleSpendingAuthInner(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
    disconnectMarker: object | undefined,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    try {
      const channelId = payload.channelId;
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      const existingCumulative = this._acceptedCumulative.get(channelId);

      if (!this._metadataMatchesHash(payload)) {
        debugWarn(
          `[SellerPayment] Rejecting SpendingAuth: metadataHash mismatch ` +
          `channel=${channelId.slice(0, 18)}...`,
        );
        return 'rejected';
      }

      const { channels: channelsAddr } = await this._resolvedAddresses!;
      const channelsDomain = makeChannelsDomain(this._config.chainId, channelsAddr);

      if (existingCumulative === undefined) {
        const hasReserveFields = payload.reserveSalt != null
          || payload.reserveMaxAmount != null
          || payload.reserveDeadline != null;

        if (!hasReserveFields) {
          const recovered = await this._recoverOnChainSession(
            buyerPeerId,
            buyerEvmAddr,
            payload,
            cumulativeAmount,
            paymentMux,
            channelsDomain,
          );
          if (recovered) {
            return 'accepted';
          }
        }

        // ── First SpendingAuth: verify ReserveAuth and reserve on-chain ──
        // The buyer signs ReserveAuth(channelId, maxAmount, deadline) to bind escrow terms.
        const reserveMaxAmount = payload.reserveMaxAmount ? BigInt(payload.reserveMaxAmount) : cumulativeAmount;
        const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const reserveMsg = {
          channelId,
          maxAmount: reserveMaxAmount,
          deadline: BigInt(reserveDeadline),
        };
        const reserveRecovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (reserveRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid ReserveAuth signature: recovered=${reserveRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }
        debugLog(`[SellerPayment] ReserveAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);

        const superseded = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
        if (superseded && superseded.sessionId !== channelId) {
          const closed = await this._closeSupersededChannel(superseded);
          if (!closed) {
            debugWarn(
              `[SellerPayment] Cannot reserve replacement channel ${channelId.slice(0, 18)}... ` +
              `while prior channel ${superseded.sessionId.slice(0, 18)}... remains active`,
            );
            return 'rejected';
          }
        }

        const reserveSalt = payload.reserveSalt ?? channelId;
        await this._reserveWithBackpressureRetry(channelId, () => this._channelsClient.reserve(
          this._signer,
          buyerEvmAddr,
          reserveSalt,
          reserveMaxAmount,
          BigInt(reserveDeadline),
          payload.spendingAuthSig,
        ));

        // Store new session (sessionId field stores channelId for backward compat)
        const now = Date.now();
        const { seller: sellerEvmAddr } = await this._resolvedAddresses!;
        const session: StoredChannel = {
          sessionId: channelId,
          peerId: buyerPeerId,
          role: CHANNEL_ROLE.SELLER,
          sellerEvmAddr,
          buyerEvmAddr,
          nonce: 0,
          authMax: payload.cumulativeAmount,
          previousConsumption: reserveMaxAmount.toString(), // repurposed: stores reserveMax
          deadline: reserveDeadline,
          previousSessionId: '',
          tokensDelivered: '0',
          requestCount: 0,
          reservedAt: now,
          settledAt: null,
          settledAmount: null,
          status: CHANNEL_STATUS.ACTIVE,
          latestBuyerSig: payload.spendingAuthSig,
          // The initial signature is a ReserveAuth, not a SpendingAuth. Keep it
          // out of the persisted SpendingAuth column so restart hydration cannot
          // restore it under the wrong EIP-712 type and repeatedly fail close().
          latestSpendingAuthSig: null,
          latestMetadata: payload.metadata,
          createdAt: now,
          updatedAt: now,
        };
        // Note: do NOT store the ReserveAuth sig as spendingAuthSig in _latestAuth.
        // The ReserveAuth uses a different EIP-712 type and will fail
        // _verifySpendingAuth in close(). A real SpendingAuth will arrive
        // via the NeedAuth flow after the first request is served.
        // Start accepted at 0 — the buyer's _cumulativeAmount also starts at 0.
        // The reserve ceiling (reserveMaxAmount) bounds what can be spent;
        // accepted grows from NeedAuth-driven SpendingAuths.
        this._activateSession(
          session,
          buyerPeerId,
          0n,
          reserveMaxAmount,
          0n,
          {
            spendingAuthSig: '',
            cumulativeAmount: 0n,
            metadataHash: payload.metadataHash,
            metadata: payload.metadata,
          },
        );

        // Send AuthAck
        paymentMux.sendAuthAck({
          channelId,
        });

        debugLog(`[SellerPayment] AuthAck sent for channel ${channelId.slice(0, 18)}...`);
        return 'reserved';
      } else if (
        payload.reserveMaxAmount
        && BigInt(payload.reserveMaxAmount) > (this._reserveMax.get(channelId) ?? 0n)
      ) {
        // ── Top-up: buyer is extending the reserve ceiling ──
        const newMaxAmount = BigInt(payload.reserveMaxAmount);
        const topUpDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const currentReserveMax = this._reserveMax.get(channelId) ?? 0n;

        // Verify as ReserveAuth (not SpendingAuth)
        const reserveMsg = {
          channelId,
          maxAmount: newMaxAmount,
          deadline: BigInt(topUpDeadline),
        };
        const recovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid top-up ReserveAuth signature: recovered=${recovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Call topUp() on-chain — includes settle of current cumulative spend
        const { amount: settleAmount, metadata: settleMetadata, sig: settleSig } = this._getSettleParams(channelId);
        debugLog(`[SellerPayment] Top-up verified: channel=${channelId.slice(0, 18)}... ceiling ${currentReserveMax} → ${newMaxAmount} (settling cumulative=${settleAmount})`);
        try {
          await this._channelsClient.topUp(
            this._signer,
            channelId,
            settleAmount,
            settleMetadata,
            settleSig,
            newMaxAmount,
            BigInt(topUpDeadline),
            payload.spendingAuthSig,
          );

          // Update tracking
          this._hydratedChannelIds.delete(channelId);
          this._reserveMax.set(channelId, newMaxAmount);
          const session = this._channelStore.getChannel(channelId);
          if (session) {
            session.previousConsumption = newMaxAmount.toString(); // repurposed: stores reserveMax
            session.deadline = topUpDeadline;
            session.updatedAt = Date.now();
            this._channelStore.upsertChannel(session);
          }

          debugLog(`[SellerPayment] Top-up completed: channel=${channelId.slice(0, 18)}... new ceiling=${newMaxAmount}`);
        } catch (topUpErr) {
          const failureKind = this._classifyTopUpFailure(topUpErr);
          if (failureKind === 'retryable-threshold' || failureKind === 'retryable-tx-backpressure') {
            // TopUpThresholdNotMet is a timing/settlement race; tx backpressure
            // means the RPC/delegated-account queue is saturated. In both cases
            // keep the ReserveAuth pending and retry after a later SpendingAuth
            // instead of treating the active channel as permanently broken.
            const reason = failureKind === 'retryable-threshold' ? 'threshold not met' : 'transaction backpressure';
            debugWarn(
              `[SellerPayment] Top-up ${reason}: channel=${channelId.slice(0, 18)}... ` +
              `error=${this._formatError(topUpErr)} — ` +
              `deferring topUp (will retry after next SpendingAuth)`,
            );
            this._storePendingTopUp(channelId, {
              newMaxAmount,
              deadline: topUpDeadline,
              reserveAuthSig: payload.spendingAuthSig,
            });
            return 'accepted';
          }

          debugWarn(
            `[SellerPayment] Top-up on-chain failed permanently: channel=${channelId.slice(0, 18)}... ` +
            `kind=${failureKind} error=${this._formatError(topUpErr)} — closing latest auth and rejecting topUp`,
          );
          this._pendingTopUp.delete(channelId);
          this._blockedChannels.add(channelId);
          await this.settleSession(buyerPeerId);
          return 'rejected';
        }
        return 'accepted';
      } else {
        // ── Subsequent SpendingAuth: verify SpendingAuth signature ──
        const metadataMsg = {
          channelId,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
        };
        const metadataRecovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, payload.spendingAuthSig);
        if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid SpendingAuth signature: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Validate monotonic (equal = idempotent retransmit)
        if (cumulativeAmount < existingCumulative) {
          debugWarn(
            `[SellerPayment] Rejecting non-monotonic SpendingAuth: ` +
            `new=${cumulativeAmount} existing=${existingCumulative} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }
        const requiresReactivation = !this._activeBuyers.has(buyerPeerId) || this._hydratedChannelIds.has(channelId);
        if (cumulativeAmount === existingCumulative) {
          if (requiresReactivation
            && !await this._validateRetainedChannel(buyerPeerId, channelId, cumulativeAmount, disconnectMarker)) {
            return 'rejected';
          }
          debugLog(`[SellerPayment] Idempotent SpendingAuth (same cumulative=${cumulativeAmount}) — accepted`);
          this._acknowledgeRetainedChannel(buyerPeerId, channelId, paymentMux, disconnectMarker);
          return 'accepted';
        }

        // Reject if buyer's cumulative doesn't cover what the seller has already spent
        const spent = this._spent.get(channelId) ?? 0n;
        if (cumulativeAmount < spent) {
          debugWarn(
            `[SellerPayment] Rejecting underfunded SpendingAuth: ` +
            `cumulative=${cumulativeAmount} < spent=${spent} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Reject if cumulative exceeds the on-chain deposit. Pending topUps do
        // not count here: until topUp() succeeds, the extra funds are not
        // locked, and accepting an over-reserve SpendingAuth would leave the
        // seller with an auth the contract cannot settle.
        const currentReserveMax = this._reserveMax.get(channelId) ?? 0n;
        const pendingTopUpForCheck = this._pendingTopUp.get(channelId);
        if (currentReserveMax > 0n && cumulativeAmount > currentReserveMax) {
          debugWarn(
            `[SellerPayment] Rejecting SpendingAuth exceeding deposit ceiling: ` +
            `cumulative=${cumulativeAmount} > reserveMax=${currentReserveMax}` +
            `${pendingTopUpForCheck ? ` (pending topUp to ${pendingTopUpForCheck.newMaxAmount})` : ''} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Update tracking
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._latestAuth.set(channelId, {
          spendingAuthSig: payload.spendingAuthSig,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
        });
        this._notifyAcceptedUpdate(channelId, cumulativeAmount);

        // Persist latest auth + sigs to ChannelStore
        const session = this._channelStore.getChannel(channelId);
        if (session) {
          session.authMax = payload.cumulativeAmount;
          session.latestBuyerSig = payload.spendingAuthSig;
          session.latestSpendingAuthSig = payload.spendingAuthSig;
          session.latestMetadata = payload.metadata;
          session.updatedAt = Date.now();
          this._channelStore.upsertChannel(session);
        }

        debugLog(`[SellerPayment] Budget updated: channel=${channelId.slice(0, 18)}... cumulative=${cumulativeAmount}`);

        // Retry any deferred topUp now that we have a higher settle amount.
        const pendingTopUp = this._pendingTopUp.get(channelId);
        if (pendingTopUp) {
          const { amount: retrySettleAmount, metadata: retryMetadata, sig: retrySig } = this._getSettleParams(channelId);
          await this._retryPendingTopUp(buyerPeerId, channelId, pendingTopUp, retrySettleAmount, retryMetadata, retrySig);
        }

        if (requiresReactivation
          && await this._validateRetainedChannel(buyerPeerId, channelId, cumulativeAmount, disconnectMarker)) {
          this._acknowledgeRetainedChannel(buyerPeerId, channelId, paymentMux, disconnectMarker);
        }
        return 'accepted';
      }
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to process SpendingAuth: ${err instanceof Error ? err.message : err}`);
      return 'rejected';
    }
  }

  private _canAcknowledgeRetainedChannel(buyerPeerId: string, channelId: string, disconnectMarker: object | undefined): boolean {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    return session?.sessionId === channelId
      && this._acceptedCumulative.has(channelId)
      && !this._closingChannels.has(channelId)
      && !this._blockedChannels.has(channelId)
      && this._buyerDisconnectMarkers.get(buyerPeerId) === disconnectMarker;
  }

  private async _validateRetainedChannel(
    buyerPeerId: string,
    channelId: string,
    cumulativeAmount: bigint,
    disconnectMarker: object | undefined,
  ): Promise<boolean> {
    if (!this._canAcknowledgeRetainedChannel(buyerPeerId, channelId, disconnectMarker)) return false;
    try {
      const state = classifyOnChainChannel(await this._channelsClient.getSession(channelId));
      const { seller } = await this._resolvedAddresses!;
      return state.exists && state.status === 'active'
        && matchesChannelParties(state.channel, peerIdToAddress(buyerPeerId), seller)
        && (state.channel.closeRequestedAt === 0n || this._serveWhileClosePending)
        && cumulativeAmount >= state.channel.settled
        && cumulativeAmount <= state.channel.deposit
        && this._canAcknowledgeRetainedChannel(buyerPeerId, channelId, disconnectMarker);
    } catch (err) {
      debugWarn(`[SellerPayment] Retained channel validation failed: ${this._formatError(err)}`);
      return false;
    }
  }

  private _acknowledgeRetainedChannel(
    buyerPeerId: string,
    channelId: string,
    paymentMux: PaymentMux,
    disconnectMarker: object | undefined,
  ): void {
    if (!this._canAcknowledgeRetainedChannel(buyerPeerId, channelId, disconnectMarker)) return;
    this._hydratedChannelIds.delete(channelId);
    this._activeBuyers.add(buyerPeerId);
    paymentMux.sendAuthAck({ channelId });
  }

  /**
   * Retry initial reserves rejected by delegated-account transaction
   * backpressure. BaseEvmClient already assigns distinct nonces across buyers;
   * retries let a rejected submission land as soon as the provider's account
   * queue has room, without holding unrelated buyers until a receipt is mined.
   */
  private async _reserveWithBackpressureRetry(
    channelId: string,
    submit: () => Promise<string>,
  ): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        debugLog(
          `[SellerPayment] Reserving channel ${channelId.slice(0, 18)}... on-chain` +
          `${attempt > 0 ? ` (retry ${attempt}/${RESERVE_BACKPRESSURE_RETRY_DELAYS_MS.length})` : ''}`,
        );
        return await submit();
      } catch (err) {
        const delayMs = RESERVE_BACKPRESSURE_RETRY_DELAYS_MS[attempt];
        if (!this._isRetryableTxSubmissionFailure(err) || delayMs === undefined) {
          throw err;
        }
        debugWarn(
          `[SellerPayment] Reserve hit transaction backpressure for ${channelId.slice(0, 18)}... ` +
          `— retrying in ${delayMs}ms: ${this._formatError(err)}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private _metadataMatchesHash(payload: SpendingAuthPayload): boolean {
    try {
      const metadata = payload.metadata || encodeMetadata(ZERO_METADATA);
      return keccak256(metadata).toLowerCase() === payload.metadataHash.toLowerCase();
    } catch (err) {
      debugWarn(`[SellerPayment] Invalid metadata payload: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private _storePendingTopUp(
    channelId: string,
    pending: { newMaxAmount: bigint; deadline: number; reserveAuthSig: string },
  ): void {
    const existing = this._pendingTopUp.get(channelId);
    if (!existing || pending.newMaxAmount >= existing.newMaxAmount) {
      this._pendingTopUp.set(channelId, pending);
    }
  }

  private _formatError(err: unknown): string {
    const text = this._flattenErrorText(err);
    const formatted = text.length > 0 ? text : String(err);
    return formatted.length > 500 ? `${formatted.slice(0, 500)}…` : formatted;
  }

  private _classifyTopUpFailure(err: unknown): TopUpFailureKind {
    const text = this._flattenErrorText(err).toLowerCase();
    if (text.includes('topupthresholdnotmet') || text.includes(TOP_UP_THRESHOLD_NOT_MET_SELECTOR)) {
      return 'retryable-threshold';
    }
    if (this._isRetryableTxSubmissionFailure(text)) {
      return 'retryable-tx-backpressure';
    }
    if (text.includes('insufficientbalance') || text.includes(INSUFFICIENT_BALANCE_SELECTOR)) {
      return 'insufficient-balance';
    }
    return 'non-retryable';
  }

  private _isRetryableTxSubmissionFailure(errOrText: unknown): boolean {
    const text = typeof errOrText === 'string'
      ? errOrText.toLowerCase()
      : this._flattenErrorText(errOrText).toLowerCase();
    return text.includes(IN_FLIGHT_TX_LIMIT_PHRASE);
  }

  private _flattenErrorText(value: unknown, seen = new Set<object>(), depth = 0): string {
    if (value == null || depth > 5) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    const parts: string[] = [];
    if (value instanceof Error) {
      parts.push(value.name, value.message);
      if ('cause' in value) {
        parts.push(this._flattenErrorText((value as { cause?: unknown }).cause, seen, depth + 1));
      }
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'stack') continue;
      const nested = (value as Record<string, unknown>)[key];
      parts.push(key);
      parts.push(this._flattenErrorText(nested, seen, depth + 1));
    }
    return parts.filter(Boolean).join(' ');
  }

  private async _settleLatestAuth(
    channelId: string,
    reason: string,
    { respectMinSettleDelta = true }: { respectMinSettleDelta?: boolean } = {},
  ): Promise<void> {
    const { amount, metadata, sig } = this._getSettleParams(channelId);
    if (amount <= 0n || sig === '0x') {
      debugLog(`[SellerPayment] Skipping settle after ${reason}: channel=${channelId.slice(0, 18)}... no signed spend`);
      return;
    }

    let delta: bigint | null = null;
    if (respectMinSettleDelta) {
      // Skip the getSession RPC entirely when our local cumulative hasn't
      // moved since we last settled this channel — the contract would revert
      // with InvalidAmount (strict `>` check) and we'd waste an RPC round-trip.
      const lastSettled = this._lastSettledCumulative.get(channelId);
      if (lastSettled !== undefined && amount <= lastSettled) {
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — cumulative unchanged since last settle (${amount})`);
        return;
      }

      // Cache miss (e.g. after restart) or local cumulative has advanced —
      // confirm against on-chain state in case another process settled.
      let onChainSettled: bigint;
      try {
        const onChain = await this._channelsClient.getSession(channelId);
        onChainSettled = onChain.settled;
      } catch (err) {
        debugWarn(`[SellerPayment] getSession failed for ${channelId.slice(0, 18)}...: ${err instanceof Error ? err.message : err} — attempting settle anyway`);
        onChainSettled = 0n;
      }
      delta = amount - onChainSettled;
      if (delta <= 0n) {
        // Resync the cache so we stop hitting the RPC on every idle tick.
        this._lastSettledCumulative.set(channelId, onChainSettled);
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — already settled on-chain (local=${amount}, onChain=${onChainSettled})`);
        return;
      }
      if (delta < this._minSettleDelta) {
        // Mark this cumulative as a no-op so the next tick short-circuits
        // without re-querying getSession until amount actually advances.
        this._lastSettledCumulative.set(channelId, amount);
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — delta=${delta} below minSettleDelta=${this._minSettleDelta}`);
        return;
      }
    }

    const deltaText = delta === null ? '' : ` delta=${delta}`;
    debugLog(`[SellerPayment] Settling channel ${channelId.slice(0, 18)}... cumulative=${amount}${deltaText} (${reason})`);
    try {
      await this._channelsClient.settle(this._signer, channelId, amount, metadata, sig);
      this._lastSettledCumulative.set(channelId, amount);
      debugLog(`[SellerPayment] Settled channel ${channelId.slice(0, 18)}... — channel remains open`);
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to settle channel after ${reason}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _retryPendingTopUp(
    buyerPeerId: string,
    channelId: string,
    pendingTopUp: { newMaxAmount: bigint; deadline: number; reserveAuthSig: string },
    settleAmount: bigint,
    settleMetadata: string,
    settleSig: string,
  ): Promise<'succeeded' | 'retryable-failure' | 'permanent-failure'> {
    this._pendingTopUp.delete(channelId);
    debugLog(`[SellerPayment] Retrying deferred topUp: channel=${channelId.slice(0, 18)}... settling=${settleAmount} newMax=${pendingTopUp.newMaxAmount}`);
    try {
      await this._channelsClient.topUp(
        this._signer,
        channelId,
        settleAmount,
        settleMetadata,
        settleSig,
        pendingTopUp.newMaxAmount,
        BigInt(pendingTopUp.deadline),
        pendingTopUp.reserveAuthSig,
      );
      this._reserveMax.set(channelId, pendingTopUp.newMaxAmount);
      const topUpSession = this._channelStore.getChannel(channelId);
      if (topUpSession) {
        topUpSession.previousConsumption = pendingTopUp.newMaxAmount.toString();
        topUpSession.deadline = pendingTopUp.deadline;
        topUpSession.updatedAt = Date.now();
        this._channelStore.upsertChannel(topUpSession);
      }
      debugLog(`[SellerPayment] Deferred topUp succeeded: channel=${channelId.slice(0, 18)}... new ceiling=${pendingTopUp.newMaxAmount}`);
      return 'succeeded';
    } catch (retryErr) {
      const failureKind = this._classifyTopUpFailure(retryErr);
      if (failureKind === 'retryable-threshold' || failureKind === 'retryable-tx-backpressure') {
        const reason = failureKind === 'retryable-threshold' ? 'threshold not met' : 'transaction backpressure';
        debugWarn(
          `[SellerPayment] Deferred topUp ${reason}: channel=${channelId.slice(0, 18)}... ` +
          `error=${this._formatError(retryErr)} — keeping pending`,
        );
        this._storePendingTopUp(channelId, pendingTopUp);
        return 'retryable-failure';
      }

      debugWarn(
        `[SellerPayment] Deferred topUp failed permanently: channel=${channelId.slice(0, 18)}... ` +
        `kind=${failureKind} error=${this._formatError(retryErr)} — closing latest auth and dropping pending topUp`,
      );
      this._blockedChannels.add(channelId);
      await this.settleSession(buyerPeerId);
      return 'permanent-failure';
    }
  }

  private async _recoverOnChainSession(
    buyerPeerId: string,
    buyerEvmAddr: string,
    payload: SpendingAuthPayload,
    cumulativeAmount: bigint,
    paymentMux: PaymentMux,
    channelsDomain: ReturnType<typeof makeChannelsDomain>,
  ): Promise<boolean> {
    const channelId = payload.channelId;
    const onChainState = classifyOnChainChannel(await this._channelsClient.getSession(channelId));
    const { seller: sellerEvmAddr } = await this._resolvedAddresses!;

    if (!onChainState.exists || onChainState.status !== 'active') return false;
    if (!matchesChannelParties(onChainState.channel, buyerEvmAddr, sellerEvmAddr)) return false;
    const onChain = onChainState.channel;

    // Active status hides a running withdraw timer that may already have matured.
    if (onChain.closeRequestedAt > 0n && !this._serveWhileClosePending) {
      debugWarn(
        `[SellerPayment] Refusing to recover channel ${channelId.slice(0, 18)}... — ` +
        `buyer requested close on-chain at ${onChain.closeRequestedAt}; funds served against it ` +
        `may be unrecoverable. Set serveWhileClosePending to accept this risk.`,
      );
      return false;
    }

    const metadataMsg = {
      channelId,
      cumulativeAmount,
      metadataHash: payload.metadataHash,
    };
    const metadataRecovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, payload.spendingAuthSig);
    if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
      debugWarn(`[SellerPayment] Invalid recovered SpendingAuth during channel recovery: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
      return false;
    }

    if (cumulativeAmount < onChain.settled) {
      debugWarn(
        `[SellerPayment] Rejecting recovered SpendingAuth below on-chain settled amount: ` +
        `cumulative=${cumulativeAmount} settled=${onChain.settled} channel=${channelId.slice(0, 18)}...`,
      );
      return false;
    }

    const now = Date.now();
    const session: StoredChannel = {
      sessionId: channelId,
      peerId: buyerPeerId,
      role: CHANNEL_ROLE.SELLER,
      sellerEvmAddr,
      buyerEvmAddr,
      nonce: 0,
      authMax: payload.cumulativeAmount,
      previousConsumption: onChain.deposit.toString(),
      deadline: Number(onChain.deadline),
      previousSessionId: '',
      tokensDelivered: onChain.settled.toString(),
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: onChain.settled > 0n ? onChain.settled.toString() : null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: payload.spendingAuthSig,
      latestSpendingAuthSig: payload.spendingAuthSig,
      latestMetadata: payload.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this._activateSession(
      session,
      buyerPeerId,
      cumulativeAmount,
      onChain.deposit,
      onChain.settled,
      {
        spendingAuthSig: payload.spendingAuthSig,
        cumulativeAmount,
        metadataHash: payload.metadataHash,
        metadata: payload.metadata,
      },
    );

    paymentMux.sendAuthAck({ channelId });
    debugLog(`[SellerPayment] Recovered active on-chain channel ${channelId.slice(0, 18)}... for buyer ${buyerPeerId.slice(0, 12)}...`);
    return true;
  }

  private _activateSession(
    session: StoredChannel,
    buyerPeerId: string,
    cumulativeAmount: bigint,
    reserveMaxAmount: bigint,
    spent: bigint,
    latestAuth: LatestAuth,
  ): void {
    this._channelStore.upsertChannel(session);
    this._hydratedChannelIds.delete(session.sessionId);
    this._acceptedCumulative.set(session.sessionId, cumulativeAmount);
    this._reserveMax.set(session.sessionId, reserveMaxAmount);
    this._spent.set(session.sessionId, spent);
    this._latestAuth.set(session.sessionId, latestAuth);
    this._activeBuyers.add(buyerPeerId);
  }

  // ── Spend tracking ──────────────────────────────────────────

  /**
   * Record USDC consumption after serving a request.
   */
  recordSpend(sessionId: string, costUsdc: bigint): void {
    const current = this._spent.get(sessionId);
    if (current === undefined) {
      debugWarn(`[SellerPayment] recordSpend: unknown channelId ${sessionId.slice(0, 18)}...`);
      return;
    }

    const newSpent = current + costUsdc;
    this._spent.set(sessionId, newSpent);

    // Persist spent amount to ChannelStore (using tokensDelivered field)
    this._channelStore.updateTokensDelivered(sessionId, newSpent.toString(), 0);
  }

  // ── Settlement ──────────────────────────────────────────────

  /** Get the latest SpendingAuth params for a channel, or zero-auth if none exists. */
  private _getSettleParams(channelId: string): { amount: bigint; metadata: string; sig: string } {
    const latestAuth = this._latestAuth.get(channelId);
    if (latestAuth && latestAuth.spendingAuthSig.length > 0) {
      return {
        amount: latestAuth.cumulativeAmount,
        metadata: latestAuth.metadata || encodeMetadata(ZERO_METADATA),
        sig: latestAuth.spendingAuthSig,
      };
    }
    return { amount: 0n, metadata: encodeMetadata(ZERO_METADATA), sig: '0x' };
  }

  /**
   * Settle or close a session's payment channel on-chain.
   *
   * - settleOnly=false (default): calls close() — charges buyer, credits seller, ends channel.
   * - settleOnly=true: calls settle() — charges buyer, credits seller, keeps channel open
   *   for future requests. No cleanup is performed so the session can resume.
   */
  async settleSession(buyerPeerId: string, { cleanupOnFailure = false, settleOnly = false } = {}): Promise<void> {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    if (!session) {
      debugWarn(`[SellerPayment] settleSession: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    const channelId = session.sessionId;
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;
    const { amount, metadata, sig } = this._getSettleParams(channelId);

    if (accepted === 0n) {
      if (settleOnly) return;
      debugLog(`[SellerPayment] Zero-cumulative channel ${channelId.slice(0, 18)}... — deferring to timeout checker`);
    } else if (settleOnly) {
      await this._settleLatestAuth(channelId, 'idle settle', { respectMinSettleDelta: true });
      return;
    } else {
      const retries = this._closeRetryCount.get(channelId) ?? 0;
      if (retries >= SellerPaymentManager.MAX_CLOSE_RETRIES) {
        debugWarn(`[SellerPayment] close() failed ${retries} times for ${channelId.slice(0, 18)}... — falling back to timeout path`);
        this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.TIMEOUT);
      } else {
        debugLog(`[SellerPayment] Closing channel ${channelId.slice(0, 18)}... cumulative=${amount} (attempt ${retries + 1}/${SellerPaymentManager.MAX_CLOSE_RETRIES})`);
        const closeResult = await this._submitClose(
          channelId,
          amount,
          () => this._channelsClient.close(this._signer, channelId, amount, metadata, sig),
        );
        if (closeResult.closed) {
          this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.SETTLED, closeResult.amount.toString());
          this._closeRetryCount.delete(channelId);
        } else {
          if (this._isRetryableTxSubmissionFailure(closeResult.error)) {
            debugWarn(
              `[SellerPayment] Close hit transaction backpressure for ${channelId.slice(0, 18)}... ` +
              `— keeping channel state for retry: ${this._formatError(closeResult.error)}`,
            );
            if (cleanupOnFailure) {
              this._deactivateBuyerForChannel(buyerPeerId, channelId);
            }
            return;
          }

          const failedAttempts = retries + 1;
          debugWarn(`[SellerPayment] Failed to close channel (attempt ${failedAttempts}): ${this._formatError(closeResult.error)}`);
          this._closeRetryCount.set(channelId, failedAttempts);

          if (failedAttempts < SellerPaymentManager.MAX_CLOSE_RETRIES) {
            if (cleanupOnFailure) {
              this._deactivateBuyerForChannel(buyerPeerId, channelId);
            }
            return;
          }

          debugWarn(`[SellerPayment] close() failed ${failedAttempts} times for ${channelId.slice(0, 18)}... — falling back to timeout path`);
          this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.TIMEOUT);
        }
      }
    }

    // Clean up maps after successful close, zero-cumulative deferral, or exhausted retries
    this._forgetChannel(channelId, buyerPeerId);
  }

  /**
   * Drop all in-memory state for a channel that is no longer live. Does not
   * touch persisted status — callers set that first (SETTLED / TIMEOUT).
   */
  private _forgetChannel(channelId: string, buyerPeerId: string): void {
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._reserveMax.delete(channelId);
    this._pendingTopUp.delete(channelId);
    this._blockedChannels.delete(channelId);
    this._lastSettledCumulative.delete(channelId);
    this._hydratedChannelIds.delete(channelId);
    this._releaseAcceptedWaiters(channelId);
    this._deactivateBuyerForChannel(buyerPeerId, channelId);
  }

  // ── In-flight request tracking ────────────────────────────────

  /** Mark a billable request as started for this buyer. */
  beginBillableRequest(buyerPeerId: string): void {
    this._inFlightRequests.set(buyerPeerId, (this._inFlightRequests.get(buyerPeerId) ?? 0) + 1);
  }

  /** Mark a billable request as fully accounted for (spend recorded, NeedAuth sent). */
  endBillableRequest(buyerPeerId: string): void {
    const next = (this._inFlightRequests.get(buyerPeerId) ?? 0) - 1;
    if (next > 0) this._inFlightRequests.set(buyerPeerId, next);
    else this._inFlightRequests.delete(buyerPeerId);
  }

  /** Whether this buyer has requests still being served and billed. */
  hasInFlightRequests(buyerPeerId: string): boolean {
    return (this._inFlightRequests.get(buyerPeerId) ?? 0) > 0;
  }

  /**
   * Whether a close transaction is in flight for this buyer's active channel.
   * Request admission refuses new billable work while this is true: the close
   * would remove the session mid-request and its spend would never be recorded.
   */
  hasClosingChannel(buyerPeerId: string): boolean {
    if (this._closingChannels.size === 0) return false;
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    return session != null && this._closingChannels.has(session.sessionId);
  }

  // ── Disconnect handling ───────────────────────────────────────

  onBuyerDisconnect(buyerPeerId: string): void {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    if (!session) return;
    this._buyerDisconnectMarkers.set(buyerPeerId, {});

    const settleOnDisconnect = this._config.settleOnDisconnect ?? true;

    if (settleOnDisconnect) {
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;
      if (accepted > 0n) {
        debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — closing channel immediately`);
        // Fire and forget settlement. Permanent close failures clean up according
        // to cleanupOnFailure; transient tx backpressure keeps channel state for retry.
        this.settleSession(buyerPeerId, { cleanupOnFailure: true }).catch((err) => {
          debugWarn(`[SellerPayment] Failed to close on disconnect: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    }

    // Preserve session for reconnect; timeout checker handles ghost scenarios
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — channel ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Stale session cleanup ────────────────────────────────────

  /**
   * Check for stale sessions and attempt to close them.
   * - Channels with a buyer SpendingAuth go through `settleSession()`.
   * - Zombie channels (buyer gone, no auth, deadline elapsed) can be closed
   *   on-chain with `finalAmount == channel.settled`, which intentionally
   *   skips SpendingAuth verification and lets the seller release the lock,
   *   decrement activeChannelCount, and advance channel stats without buyer
   *   cooperation.
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const activeChannels = this._channelStore.getActiveChannels(CHANNEL_ROLE.SELLER);

    for (const channel of activeChannels) {
      let accepted = this._acceptedCumulative.get(channel.sessionId) ?? 0n;
      if (accepted === 0n) {
        accepted = this._restorePersistedSpendingAuth(channel) ?? accepted;
      }

      try {
        // Validate on-chain state — evict if channel no longer exists
        const onChainState = classifyOnChainChannel(
          await this._channelsClient.getSession(channel.sessionId),
        );
        if (!onChainState.exists || (onChainState.status !== 'active' && onChainState.status !== 'unknown')) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, `periodic check: on-chain status=${onChainState.exists ? onChainState.status : 'missing'}`);
          continue;
        }

        const buyerDisconnected = !this._activeBuyers.has(channel.peerId);
        const hydratedZeroAuthExpired = accepted === 0n
          && this._hydratedChannelIds.has(channel.sessionId)
          && nowSecs > channel.deadline;

        // If we have auths and the buyer is disconnected, try to close
        if (accepted > 0n && buyerDisconnected) {
          debugLog(`[SellerPayment] Channel ${channel.sessionId.slice(0, 18)}... buyer disconnected — attempting close`);
          await this.settleSession(channel.peerId);
          continue;
        }
        // No auths, buyer gone, deadline elapsed: close with the current
        // on-chain settled amount. The contract skips signature verification
        // when finalAmount == settled, so this safely cleans up zombie
        // channels without claiming any unproven spend.
        if (accepted === 0n && (buyerDisconnected || hydratedZeroAuthExpired) && nowSecs > channel.deadline) {
          if (onChainState.status !== 'active') {
            // 'unknown' means the RPC returned partial data. Evict locally
            // rather than risking a close() against an ambiguous channel.
            this._evictStaleChannel(
              channel.sessionId,
              channel.peerId,
              'no auths, past deadline, on-chain status unknown',
              CHANNEL_STATUS.TIMEOUT,
            );
            continue;
          }
          await this._closeWithoutAuth(channel.sessionId, channel.peerId, onChainState.channel.settled);
        }
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to process channel ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Close the seller's previous channel before accepting a replacement
   * ReserveAuth from the same buyer. Buyers may lose local channel state and
   * generate a new channel ID while the previous reserve remains active
   * on-chain. The contract rejects a second active channel for the same pair,
   * so recover synchronously using the seller's durable state instead of
   * leaving both peers in an unrecoverable negotiation loop.
   */
  private async _closeSupersededChannel(channel: StoredChannel): Promise<boolean> {
    const channelId = channel.sessionId;
    const accepted = this._acceptedCumulative.get(channelId)
      ?? this._restorePersistedSpendingAuth(channel)
      ?? 0n;

    try {
      if (accepted > 0n) {
        const { amount, metadata, sig } = this._getSettleParams(channelId);
        const closeResult = await this._submitClose(
          channelId,
          amount,
          () => this._channelsClient.close(this._signer, channelId, amount, metadata, sig),
        );
        if (!closeResult.closed) return false;
        this._evictStaleChannel(
          channelId,
          channel.peerId,
          'closed before replacement reserve',
          CHANNEL_STATUS.SETTLED,
        );
      } else {
        const onChainState = classifyOnChainChannel(await this._channelsClient.getSession(channelId));
        if (!onChainState.exists || onChainState.status !== 'active') {
          this._evictStaleChannel(
            channelId,
            channel.peerId,
            `replacement reserve: on-chain status=${onChainState.exists ? onChainState.status : 'missing'}`,
          );
        } else {
          const closeResult = await this._submitClose(
            channelId,
            onChainState.channel.settled,
            () => this._channelsClient.close(
              this._signer,
              channelId,
              onChainState.channel.settled,
              '0x',
              '0x',
            ),
          );
          if (!closeResult.closed) return false;
          this._evictStaleChannel(
            channelId,
            channel.peerId,
            'zero-auth channel closed before replacement reserve',
            CHANNEL_STATUS.SETTLED,
          );
        }
      }
      return true;
    } catch (err) {
      debugWarn(
        `[SellerPayment] Failed to close superseded channel ${channelId.slice(0, 18)}...: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * Close a zombie channel (buyer gone, no signed auth) using the current
   * on-chain settled cumulative as finalAmount. This intentionally settles no
   * additional spend, but still marks the channel closed and releases the
   * remaining reserved deposit back to the buyer.
   */
  private async _closeWithoutAuth(channelId: string, peerId: string, onChainSettled: bigint): Promise<void> {
    const retries = this._closeRetryCount.get(channelId) ?? 0;
    if (retries >= SellerPaymentManager.MAX_CLOSE_RETRIES) {
      debugWarn(`[SellerPayment] Zombie close failed ${retries} times for ${channelId.slice(0, 18)}... — falling back to local eviction`);
      this._evictStaleChannel(channelId, peerId, 'no auths, past deadline, close retries exhausted', CHANNEL_STATUS.TIMEOUT);
      return;
    }

    debugLog(`[SellerPayment] Closing zombie channel ${channelId.slice(0, 18)}... finalAmount=${onChainSettled} (attempt ${retries + 1}/${SellerPaymentManager.MAX_CLOSE_RETRIES})`);
    const closeResult = await this._submitClose(
      channelId,
      onChainSettled,
      () => this._channelsClient.close(this._signer, channelId, onChainSettled, '0x', '0x'),
    );
    if (closeResult.closed) {
      this._closeRetryCount.delete(channelId);
      this._evictStaleChannel(channelId, peerId, 'zombie closed on-chain', CHANNEL_STATUS.SETTLED);
    } else if (this._isRetryableTxSubmissionFailure(closeResult.error)) {
      debugWarn(
        `[SellerPayment] Zombie close hit transaction backpressure for ${channelId.slice(0, 18)}... ` +
        `— keeping channel for retry: ${this._formatError(closeResult.error)}`,
      );
    } else {
      this._closeRetryCount.set(channelId, retries + 1);
      debugWarn(`[SellerPayment] Zombie close failed (attempt ${retries + 1}): ${this._formatError(closeResult.error)}`);
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  hasSession(buyerPeerId: string): boolean {
    return this._activeBuyers.has(buyerPeerId);
  }

  /** Get the active session for a buyer peer, or null. */
  getChannelByPeer(buyerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
  }

  /** Get total USDC spent for a session (sum of recordSpend calls). */
  getCumulativeSpend(sessionId: string): bigint {
    return this._spent.get(sessionId) ?? 0n;
  }

  /** Get the highest accepted cumulative amount for a session. */
  getAcceptedCumulative(sessionId: string): bigint {
    return this._acceptedCumulative.get(sessionId) ?? 0n;
  }

  /** Get the on-chain reserve budget ceiling for a session. */
  getReserveMax(sessionId: string): bigint {
    return this._reserveMax.get(sessionId) ?? 0n;
  }

  /** Get the effective reserve max for serving decisions. Pending topUps do not count until confirmed on-chain. */
  getEffectiveReserveMax(sessionId: string): bigint {
    return this.getReserveMax(sessionId);
  }

  /** Whether this channel is blocked from serving more paid work. */
  isChannelBlocked(sessionId: string): boolean {
    return this._blockedChannels.has(sessionId);
  }

  /** Whether a topUp is pending (on-chain call deferred). */
  hasPendingTopUp(sessionId: string): boolean {
    return this._pendingTopUp.has(sessionId);
  }

  private static readonly DEFAULT_SUGGESTED_AMOUNT = 1_000_000n; // $1.00 — matches contract FIRST_SIGN_CAP and buyer default

  /**
   * Build the PaymentRequired payload for a buyer that doesn't have a session.
   */
  getPaymentRequirements(
    requestId: string,
    buyerPeerId?: string,
    pricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number },
  ): PaymentRequiredPayload {
    const minBudgetPerRequest = this._config.minBudgetPerRequest ?? DEFAULT_MIN_BUDGET_PER_REQUEST;

    let suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
    if (buyerPeerId) {
      const priorSession = this._channelStore.getLatestChannel(buyerPeerId, 'seller');
      if (priorSession && priorSession.status === CHANNEL_STATUS.SETTLED) {
        // Returning buyer with proven history — could use a different amount
        // For now, use the same default; config can override later
        suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
      }
    }

    return {
      minBudgetPerRequest,
      suggestedAmount: suggestedAmount.toString(),
      requestId,
      ...(pricing?.inputUsdPerMillion != null ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
      ...(pricing?.outputUsdPerMillion != null ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
      ...(pricing?.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
    };
  }

  // ── Buyer-requested cooperative close ─────────────────────────

  /**
   * Handle a buyer's CloseChannelRequest: close the channel on-chain right
   * away so the buyer's reserve is released without the `requestClose()` →
   * 15-minute grace → `withdraw()` detour.
   *
   * The seller only agrees when it is not mid-accumulation with this buyer:
   * no billable request in flight, and no served work the buyer has not signed
   * for. It closes at `max(own last-accepted auth, buyer-supplied auth)`, so a
   * buyer cannot use this path to settle below what it already owes, and a
   * seller that lost the buyer's latest auth can still be paid in full by the
   * copy the buyer attaches.
   */
  async handleCloseChannelRequest(
    buyerPeerId: string,
    payload: CloseChannelRequestPayload,
    paymentMux: PaymentMux,
  ): Promise<CloseChannelResultPayload> {
    const reject = (
      code: CloseChannelRejectCode,
      reason: string,
      extra: Partial<CloseChannelResultPayload> = {},
    ): CloseChannelResultPayload => {
      debugLog(`[SellerPayment] Declining close of ${payload.channelId.slice(0, 18)}... — ${code}: ${reason}`);
      return { version: 1, channelId: payload.channelId, status: 'rejected', code, reason, ...extra };
    };

    let session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    if (!session) {
      return reject('no_channel', 'no active channel for this buyer');
    }
    if (session.sessionId.toLowerCase() !== payload.channelId.toLowerCase()) {
      return reject('no_channel', `active channel is ${session.sessionId}, not the requested channel`);
    }

    const channelId = session.sessionId;

    if (this.hasInFlightRequests(buyerPeerId)) {
      return reject('busy', 'a request is still being served on this channel', {
        retryAfterMs: CLOSE_RETRY_AFTER_MS,
      });
    }
    if (this._closingChannels.has(channelId)) {
      return reject('busy', 'a close is already in flight for this channel', {
        retryAfterMs: CLOSE_RETRY_AFTER_MS,
      });
    }

    // Let any SpendingAuth already being processed finish before reading the
    // accepted cumulative, then re-check the channel still exists.
    await this.waitForPendingAuths(buyerPeerId);
    session = this._channelStore.getActiveChannelByPeer(buyerPeerId, CHANNEL_ROLE.SELLER);
    if (!session || session.sessionId !== channelId) {
      return reject('no_channel', 'channel was retired while the close request was being processed');
    }

    // Verify the buyer's optional auth before comparing it with our own.
    let buyerAuth: LatestAuth | null;
    try {
      buyerAuth = await this._verifyBuyerCloseAuth(session, payload);
    } catch (err) {
      return reject('invalid_auth', err instanceof Error ? err.message : String(err));
    }
    if (buyerAuth) {
      this._adoptBuyerCloseAuth(channelId, buyerAuth);
    }

    // Anything served but not yet signed for is unclaimable — ask for the
    // catch-up auth rather than closing at a loss.
    let spent = this._spent.get(channelId) ?? 0n;
    let best = this._getSettleParams(channelId);
    if (spent > best.amount) {
      await this.awaitAcceptedAtLeast(channelId, spent, CLOSE_CATCH_UP_WAIT_MS);
      spent = this._spent.get(channelId) ?? 0n;
      best = this._getSettleParams(channelId);
    }
    if (spent > best.amount) {
      const accepted = this._acceptedCumulative.get(channelId) ?? 0n;
      try {
        paymentMux.sendNeedAuth({
          channelId,
          requiredCumulativeAmount: spent.toString(),
          currentAcceptedCumulative: accepted.toString(),
          deposit: session.authMax ?? '0',
        });
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to send catch-up NeedAuth before close: ${this._formatError(err)}`);
      }
      return reject('pending_auth', `unsigned spend outstanding (spent=${spent} signed=${best.amount})`, {
        retryAfterMs: CLOSE_RETRY_AFTER_MS,
        requiredCumulativeAmount: spent.toString(),
      });
    }

    // The contract rejects a finalAmount at or below what is already settled
    // (InvalidAmount) and skips signature verification when they are equal, so
    // fall back to an unsigned close-at-settled when we have nothing better.
    let onChainSettled: bigint;
    try {
      onChainSettled = (await this._channelsClient.getSession(channelId)).settled;
    } catch (err) {
      return reject('close_failed', `could not read on-chain channel state: ${this._formatError(err)}`);
    }

    // Re-check after the awaits above: a request admitted while this handler
    // was verifying and waiting must finish billing before the channel closes,
    // and any spend it recorded must be signed for or the close settles short.
    // Everything from here to the submission is synchronous, so nothing can
    // land in between.
    if (this.hasInFlightRequests(buyerPeerId)) {
      return reject('busy', 'a request is still being served on this channel', {
        retryAfterMs: CLOSE_RETRY_AFTER_MS,
      });
    }
    spent = this._spent.get(channelId) ?? 0n;
    best = this._getSettleParams(channelId);
    if (spent > best.amount) {
      return reject('pending_auth', `unsigned spend outstanding (spent=${spent} signed=${best.amount})`, {
        retryAfterMs: CLOSE_RETRY_AFTER_MS,
        requiredCumulativeAmount: spent.toString(),
      });
    }

    const useSignedAuth = best.sig !== '0x' && best.amount > onChainSettled;
    const finalAmount = useSignedAuth ? best.amount : onChainSettled;
    const metadata = useSignedAuth ? best.metadata : '0x';
    const sig = useSignedAuth ? best.sig : '0x';

    debugLog(
      `[SellerPayment] Buyer-requested close of ${channelId.slice(0, 18)}... ` +
      `finalAmount=${finalAmount} (signed=${useSignedAuth})`,
    );
    // Share the close with every other close path. The busy check above runs
    // before several awaits, so a background close can still start in between —
    // report that transaction rather than submitting a competing one.
    const closeResult = await this._submitClose(
      channelId,
      finalAmount,
      () => this._channelsClient.close(this._signer, channelId, finalAmount, metadata, sig),
    );
    if (!closeResult.closed) {
      const message = this._formatError(closeResult.error);
      debugWarn(`[SellerPayment] Buyer-requested close failed for ${channelId.slice(0, 18)}...: ${message}`);
      return reject('close_failed', message, {
        ...(this._isRetryableTxSubmissionFailure(closeResult.error) ? { retryAfterMs: CLOSE_RETRY_AFTER_MS } : {}),
      });
    }

    this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.SETTLED, closeResult.amount.toString());
    this._forgetChannel(channelId, buyerPeerId);
    debugLog(`[SellerPayment] Channel ${channelId.slice(0, 18)}... closed on buyer request (tx=${closeResult.txHash})`);

    return {
      version: 1,
      channelId,
      status: 'closed',
      txHash: closeResult.txHash,
      finalAmount: closeResult.amount.toString(),
    };
  }

  /**
   * Verify a SpendingAuth attached to a CloseChannelRequest. Returns null when
   * the buyer attached nothing; throws with a caller-safe message when the
   * attached auth does not check out.
   */
  private async _verifyBuyerCloseAuth(
    session: StoredChannel,
    payload: CloseChannelRequestPayload,
  ): Promise<LatestAuth | null> {
    const { cumulativeAmount, metadataHash, metadata, spendingAuthSig } = payload;
    if (
      cumulativeAmount === undefined || metadataHash === undefined
      || metadata === undefined || spendingAuthSig === undefined
    ) {
      return null;
    }

    let amount: bigint;
    try {
      amount = BigInt(cumulativeAmount);
    } catch {
      throw new Error(`cumulativeAmount "${cumulativeAmount}" is not an integer`);
    }
    if (amount < 0n) throw new Error('cumulativeAmount must not be negative');

    if (keccak256(metadata).toLowerCase() !== metadataHash.toLowerCase()) {
      throw new Error('metadataHash does not match metadata');
    }

    const { channels } = await this._resolvedAddresses!;
    const channelsDomain = makeChannelsDomain(this._config.chainId, channels);
    const recovered = verifyTypedData(
      channelsDomain,
      SPENDING_AUTH_TYPES,
      { channelId: session.sessionId, cumulativeAmount: amount, metadataHash },
      spendingAuthSig,
    );
    if (recovered.toLowerCase() !== session.buyerEvmAddr.toLowerCase()) {
      throw new Error(`signature recovers to ${recovered}, not the channel buyer`);
    }

    return { spendingAuthSig, cumulativeAmount: amount, metadataHash, metadata };
  }

  /**
   * Take the buyer-supplied auth as our latest when it authorizes strictly more
   * than what we already hold. Persisted so a crash between here and close()
   * doesn't lose the higher claim.
   */
  private _adoptBuyerCloseAuth(channelId: string, buyerAuth: LatestAuth): void {
    const current = this._latestAuth.get(channelId);
    if (current && current.spendingAuthSig.length > 0 && current.cumulativeAmount >= buyerAuth.cumulativeAmount) {
      return;
    }

    this._latestAuth.set(channelId, buyerAuth);
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;
    if (buyerAuth.cumulativeAmount > accepted) {
      this._acceptedCumulative.set(channelId, buyerAuth.cumulativeAmount);
      this._notifyAcceptedUpdate(channelId, buyerAuth.cumulativeAmount);
    }

    const stored = this._channelStore.getChannel(channelId);
    if (stored) {
      stored.authMax = (
        buyerAuth.cumulativeAmount > BigInt(stored.authMax || '0') ? buyerAuth.cumulativeAmount : BigInt(stored.authMax)
      ).toString();
      stored.latestBuyerSig = buyerAuth.spendingAuthSig;
      stored.latestSpendingAuthSig = buyerAuth.spendingAuthSig;
      stored.latestMetadata = buyerAuth.metadata;
      stored.updatedAt = Date.now();
      this._channelStore.upsertChannel(stored);
    }

    debugLog(
      `[SellerPayment] Adopted buyer-supplied close auth for ${channelId.slice(0, 18)}... ` +
      `cumulative=${buyerAuth.cumulativeAmount} (was ${current?.cumulativeAmount ?? 0n})`,
    );
  }

  // ── CloseRequested handling ───────────────────────────────────

  /**
   * Handle a CloseRequested event for a channel this seller manages.
   * If the seller has a stored SpendingAuth, immediately close the channel
   * on-chain to claim earnings before the grace period expires.
   */
  async handleCloseRequested(channelId: string): Promise<void> {
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;

    if (accepted > 0n) {
      const { amount, metadata, sig } = this._getSettleParams(channelId);
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — closing with cumulative=${amount}`);
      const closeResult = await this._submitClose(
        channelId,
        amount,
        () => this._channelsClient.close(this._signer, channelId, amount, metadata, sig),
      );
      if (!closeResult.closed) {
        debugWarn(
          `[SellerPayment] Failed to close channel ${channelId.slice(0, 18)}... ` +
          `after CloseRequested: ${this._formatError(closeResult.error)}`,
        );
        return;
      }
      this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.SETTLED, closeResult.amount.toString());
      debugLog(`[SellerPayment] Channel ${channelId.slice(0, 18)}... closed successfully after CloseRequested`);
    } else {
      // No voucher — seller can't claim anything. Clean up locally;
      // buyer will withdraw after grace period.
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — no SpendingAuth, cleaning up locally`);
      this._channelStore.updateChannelStatus(channelId, CHANNEL_STATUS.TIMEOUT);
    }

    // Clean up in-memory state, including removing the buyer from the active set
    this._forgetChannel(channelId, this._channelStore.getChannel(channelId)?.peerId ?? '');
  }

  /**
   * Poll for CloseRequested events and handle any that match active channels.
   * Returns the block number to use as the next fromBlock cursor.
   */
  async pollCloseRequested(fromBlock: number): Promise<number> {
    try {
      // Fetch block number first and pin as toBlock to avoid race:
      // if blocks are mined between the two calls, events in the gap would be missed.
      const latestBlock = await this._channelsClient.getBlockNumber();
      const events = await this._channelsClient.getCloseRequestedEvents(fromBlock, latestBlock);

      for (const event of events) {
        // Only handle channels this seller is actively tracking
        if (this._acceptedCumulative.has(event.channelId) || this._channelStore.getChannel(event.channelId)?.status === CHANNEL_STATUS.ACTIVE) {
          await this.handleCloseRequested(event.channelId);
        }
      }

      return latestBlock + 1;
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to poll CloseRequested events: ${err instanceof Error ? err.message : err}`);
      return fromBlock; // Retry from same block on next poll
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // ChannelStore is shared with BuyerPaymentManager, closed from node.ts
  }
}
