import { verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PeerId } from '../types/peer.js';
import type { SweepRequestPayload, SweepReceiptPayload } from '../types/protocol.js';
import type { SweepMux } from '../p2p/sweep-mux.js';
import { DepositRelayClient } from './evm/deposit-relay-client.js';
import { RECEIVE_WITH_AUTHORIZATION_TYPES, makeUsdcDomain } from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';

export interface DepositRelayerConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  /** The relayer's own configured AntseedDepositRelay address. Requests
   *  pointing anywhere else are dropped — never submit to a peer-supplied
   *  contract address. */
  relayAddress: string;
  usdcAddress: string;
  evmChainId: number;
  /** Minimum acceptable profit (FEE - estimated gas cost) in USDC base units.
   *  May be negative to relay at a loss (e.g. local testing where anvil's gas
   *  price dwarfs the fee). Default: 0. */
  minProfitBaseUnits?: bigint;
  /** Max concurrent sweep submissions. Default: 2. */
  maxInFlight?: number;
  /** Max sweep requests accepted per peer per minute. Default: 6. */
  maxPerPeerPerMinute?: number;
}

export type SweepHandleResult = 'submitted' | 'rejected' | 'dropped';

const DEFAULT_MIN_PROFIT = 0n;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_MAX_PER_PEER_PER_MINUTE = 6;
const SEEN_NONCES_MAX = 1024;
const RATE_WINDOW_MS = 60_000;
/** Don't bother submitting when the authorization expires too soon to land. */
const MIN_REMAINING_VALIDITY_SECS = 30;

/**
 * Seller-side permissionless relayer for buyer deposit sweeps.
 *
 * On SweepRequest: verify the buyer's EIP-3009 signature locally, simulate
 * the call, check the fixed FEE clears gas cost by the configured minimum
 * profit, then submit sweepDeposit with the seller's funded wallet and report
 * progress via SweepReceipt. Losing a submission race to another relayer
 * (EIP-3009 nonce already used) is normal — logged and dropped.
 */
export class DepositRelayer {
  private readonly _identity: Identity;
  private readonly _config: DepositRelayerConfig;
  private readonly _client: DepositRelayClient;
  private readonly _seenNonces = new Set<string>();
  private readonly _requestTimes = new Map<PeerId, number[]>();
  private _inFlight = 0;

  constructor(identity: Identity, config: DepositRelayerConfig) {
    this._identity = identity;
    this._config = config;
    this._client = new DepositRelayClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.relayAddress,
      evmChainId: config.evmChainId,
    });
  }

  get client(): DepositRelayClient { return this._client; }

  async handleSweepRequest(
    peerId: PeerId,
    payload: SweepRequestPayload,
    mux: SweepMux,
  ): Promise<SweepHandleResult> {
    // Never submit to a contract a peer told us about — only our own config.
    if (payload.evmChainId !== this._config.evmChainId ||
        payload.relayAddress.toLowerCase() !== this._config.relayAddress.toLowerCase()) {
      debugLog(`[Relayer] Dropping sweep from ${peerId.slice(0, 12)}...: chain/relay mismatch`);
      return 'dropped';
    }

    const nonceKey = payload.nonce.toLowerCase();
    if (this._seenNonces.has(nonceKey)) {
      debugLog(`[Relayer] Dropping sweep from ${peerId.slice(0, 12)}...: nonce already seen`);
      return 'dropped';
    }

    if (!this._admitPeerRequest(peerId)) {
      debugWarn(`[Relayer] Rate limit exceeded for ${peerId.slice(0, 12)}...`);
      return 'dropped';
    }

    const maxInFlight = this._config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (this._inFlight >= maxInFlight) {
      debugLog(`[Relayer] Dropping sweep from ${peerId.slice(0, 12)}...: ${this._inFlight} sweeps already in flight`);
      return 'dropped';
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs <= payload.validAfter || nowSecs >= payload.validBefore - MIN_REMAINING_VALIDITY_SECS) {
      this._sendReceipt(mux, payload, 'rejected', undefined, 'authorization window invalid or expiring');
      return 'rejected';
    }

    let amount: bigint;
    try {
      amount = BigInt(payload.amount);
    } catch {
      this._sendReceipt(mux, payload, 'rejected', undefined, 'malformed amount');
      return 'rejected';
    }

    if (!this._verifySignature(payload, amount)) {
      this._sendReceipt(mux, payload, 'rejected', undefined, 'invalid signature');
      return 'rejected';
    }

    this._rememberNonce(nonceKey);

    const params = {
      from: payload.from,
      amount,
      validAfter: BigInt(payload.validAfter),
      validBefore: BigInt(payload.validBefore),
      nonce: payload.nonce,
      sig3009: payload.sig3009,
    };

    this._inFlight++;
    try {
      // Simulation failure (used nonce, bad sig, amount <= FEE, min-deposit,
      // credit limit) → reject.
      let estimate;
      try {
        estimate = await this._client.estimateSweepProfit(this._identity.wallet, params, {
          minProfitUsdc: this._config.minProfitBaseUnits ?? DEFAULT_MIN_PROFIT,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`[Relayer] Simulation failed for nonce ${payload.nonce.slice(0, 10)}...: ${message}`);
        this._seenNonces.delete(nonceKey);
        this._sendReceipt(mux, payload, 'rejected', undefined, 'simulation failed');
        return 'rejected';
      }

      const minProfit = this._config.minProfitBaseUnits ?? DEFAULT_MIN_PROFIT;
      if (estimate.profitUsdc < minProfit) {
        debugLog(`[Relayer] Unprofitable sweep for nonce ${payload.nonce.slice(0, 10)}...: fee=${estimate.fee} gasEst=${estimate.estGasCostUsdc} profit=${estimate.profitUsdc} min=${minProfit}`);
        this._seenNonces.delete(nonceKey);
        this._sendReceipt(mux, payload, 'rejected', undefined, 'unprofitable for relayer');
        return 'rejected';
      }

      this._sendReceipt(mux, payload, 'submitted');
      // Speed-ups of a stalled sweep stop where it would no longer pay for itself.
      const txHash = await this._client.sweep(this._identity.wallet, params, { maxFeePerGasWei: estimate.maxFeePerGasWei });
      debugLog(`[Relayer] Sweep confirmed for ${payload.from.slice(0, 10)}...: tx=${txHash} fee=${estimate.fee}`);
      this._sendReceipt(mux, payload, 'confirmed', txHash);
      return 'submitted';
    } catch (err) {
      // Losing the submission race (nonce consumed by another relayer) is normal.
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`[Relayer] Sweep submission failed for nonce ${payload.nonce.slice(0, 10)}...: ${message}`);
      this._sendReceipt(mux, payload, 'rejected', undefined, 'submission failed');
      return 'rejected';
    } finally {
      this._inFlight--;
    }
  }

  private _rememberNonce(nonceKey: string): void {
    this._seenNonces.add(nonceKey);
    if (this._seenNonces.size > SEEN_NONCES_MAX) {
      const oldest = this._seenNonces.values().next().value;
      if (oldest !== undefined) this._seenNonces.delete(oldest);
    }
  }

  private _verifySignature(payload: SweepRequestPayload, amount: bigint): boolean {
    try {
      const usdcDomain = makeUsdcDomain(this._config.evmChainId, this._config.usdcAddress);
      const recovered = verifyTypedData(usdcDomain, RECEIVE_WITH_AUTHORIZATION_TYPES, {
        from: payload.from,
        to: this._config.relayAddress,
        value: amount,
        validAfter: BigInt(payload.validAfter),
        validBefore: BigInt(payload.validBefore),
        nonce: payload.nonce,
      }, payload.sig3009);
      return recovered.toLowerCase() === payload.from.toLowerCase();
    } catch {
      return false;
    }
  }

  private _admitPeerRequest(peerId: PeerId): boolean {
    const limit = this._config.maxPerPeerPerMinute ?? DEFAULT_MAX_PER_PEER_PER_MINUTE;
    const now = Date.now();
    const times = (this._requestTimes.get(peerId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= limit) {
      this._requestTimes.set(peerId, times);
      return false;
    }
    times.push(now);
    this._requestTimes.set(peerId, times);
    // Bound the map: drop stale peers opportunistically.
    if (this._requestTimes.size > 512) {
      for (const [key, value] of this._requestTimes) {
        if (value.every((t) => now - t >= RATE_WINDOW_MS)) this._requestTimes.delete(key);
      }
    }
    return true;
  }

  private _sendReceipt(
    mux: SweepMux,
    payload: SweepRequestPayload,
    status: SweepReceiptPayload['status'],
    txHash?: string,
    reason?: string,
  ): void {
    try {
      mux.sendSweepReceipt({
        version: 1,
        authNonce: payload.nonce,
        status,
        ...(txHash ? { txHash } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch (err) {
      debugLog(`[Relayer] Failed to send receipt: ${err instanceof Error ? err.message : err}`);
    }
  }
}
