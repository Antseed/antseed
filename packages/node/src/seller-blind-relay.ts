import { randomBytes } from 'node:crypto';
import type { BlindRelayCredential } from '@antseed/protocol/blind-relay';
import type { Provider } from './interfaces/seller-provider.js';
import type { RelayGrant } from './p2p/relay-mux.js';
import { debugLog, debugWarn } from './utils/debug.js';

/** The most live credentials one buyer may hold at once. */
const MAX_CREDENTIALS_PER_BUYER = 4;
/** How long the upstream's spend counter may take to show a finished request. */
const SPEND_SETTLE_WAIT_MS = 10_000;
const SPEND_POLL_INTERVAL_MS = 500;
/** A credential is not handed out with less life left than this. */
const MIN_REMAINING_MS = 30_000;

interface LiveCredential {
  id: string;
  buyerPeerId: string;
  service: string;
  provider: Provider;
  handle: string;
  host: string;
  port: number;
  expiresAt: number;
  /** Upstream USD spent as of the last bill. */
  billedSpendUsd: number;
  /** A stream is open on it, or its bill is not settled yet: one at a time, so each change in spend belongs to one request. */
  busy: boolean;
}

/** What the seller charges for one relayed request. */
export interface BlindRelayCharge {
  buyerPeerId: string;
  requestId: string;
  service: string;
  costUsdc: bigint;
}

export interface SellerBlindRelayDeps {
  /** Records the cost on the buyer's channel and asks the buyer to sign for it. */
  charge(charge: BlindRelayCharge): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** USD at upstream prices, times the seller's multiplier, in USDC base units, rounded up. */
export function blindRelayCostUsdc(spendUsd: number, multiplier: number): bigint {
  if (!(spendUsd > 0) || !(multiplier > 0)) return 0n;
  return BigInt(Math.ceil(spendUsd * multiplier * 1_000_000 - 1e-6));
}

/**
 * The seller's side of the blind relay: mints credentials for buyers, lets a
 * relay stream reach only its credential's upstream, and bills each stream by
 * the change in the upstream's spend counter for that credential.
 */
export class SellerBlindRelay {
  private readonly _credentials = new Map<string, LiveCredential>();

  constructor(private readonly _deps: SellerBlindRelayDeps) {}

  private _now(): number {
    return this._deps.now?.() ?? Date.now();
  }

  private _sweep(): void {
    const now = this._now();
    for (const [id, credential] of this._credentials) {
      if (credential.expiresAt <= now && !credential.busy) this._credentials.delete(id);
    }
  }

  /** Mints a credential for `buyerPeerId`. Throws with a reason the buyer may read. */
  async mint(buyerPeerId: string, service: string, provider: Provider): Promise<BlindRelayCredential> {
    if (!provider.mintBlindCredential || !provider.blindCredentialSpendUsd) {
      throw new Error(`service "${service}" is not served through the blind relay`);
    }
    this._sweep();
    const held = [...this._credentials.values()].filter((c) => c.buyerPeerId === buyerPeerId).length;
    if (held >= MAX_CREDENTIALS_PER_BUYER) throw new Error('too many live credentials; reuse one');
    const minted = await provider.mintBlindCredential(service);
    if (!minted) throw new Error(`service "${service}" is not served through the blind relay`);
    if (minted.expiresAt - this._now() < MIN_REMAINING_MS) throw new Error('the upstream credential expired too soon');
    const id = randomBytes(16).toString('hex');
    this._credentials.set(id, {
      id,
      buyerPeerId,
      service,
      provider,
      handle: minted.handle,
      host: minted.upstream.host,
      port: minted.upstream.port,
      expiresAt: minted.expiresAt,
      billedSpendUsd: 0,
      busy: false,
    });
    debugLog(`[BlindRelay] minted ${id.slice(0, 8)} for ${buyerPeerId.slice(0, 12)}... service=${service}`);
    return {
      credentialId: id,
      credential: minted.credential,
      upstream: minted.upstream,
      expiresAt: minted.expiresAt,
      spendLimitUsd: minted.spendLimitUsd,
    };
  }

  /** Relay authorizer for one buyer's connection. */
  authorize(buyerPeerId: string, streamId: string, credentialId: string): Promise<RelayGrant> {
    const credential = this._credentials.get(credentialId);
    // Another buyer's credential reads as unknown, so ids reveal nothing.
    if (!credential || credential.buyerPeerId !== buyerPeerId) return Promise.reject(new Error('unknown credential'));
    if (credential.expiresAt <= this._now()) return Promise.reject(new Error('credential expired'));
    if (credential.busy) return Promise.reject(new Error('credential busy'));
    credential.busy = true;
    return Promise.resolve({
      host: credential.host,
      port: credential.port,
      onClose: () => {
        void this._bill(credential, streamId).finally(() => { credential.busy = false; });
      },
    });
  }

  /**
   * Charges the stream by the change in the credential's upstream spend. The
   * counter can lag the response, so it is read until it moves or the wait
   * runs out; a stream that spent nothing (a refused or empty request) is free.
   */
  private async _bill(credential: LiveCredential, requestId: string): Promise<void> {
    const sleep = this._deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = this._now() + SPEND_SETTLE_WAIT_MS;
    let spent = credential.billedSpendUsd;
    for (;;) {
      try {
        spent = await credential.provider.blindCredentialSpendUsd!(credential.handle);
      } catch (error) {
        debugWarn(`[BlindRelay] spend read failed for ${credential.id.slice(0, 8)}: ${error instanceof Error ? error.message : error}`);
      }
      if (spent > credential.billedSpendUsd || this._now() >= deadline) break;
      await sleep(SPEND_POLL_INTERVAL_MS);
    }
    const delta = spent - credential.billedSpendUsd;
    if (!(delta > 0)) return;
    credential.billedSpendUsd = spent;
    const costUsdc = blindRelayCostUsdc(delta, credential.provider.blindRelayPriceMultiplier ?? 1);
    debugLog(`[BlindRelay] ${credential.id.slice(0, 8)} spent ${delta} USD upstream; charging ${costUsdc}`);
    this._deps.charge({ buyerPeerId: credential.buyerPeerId, requestId, service: credential.service, costUsdc });
  }
}
