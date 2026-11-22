import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { isKeyedRequestTerms, type BlindRelayCredential } from '@antseed/protocol/blind-relay';
import type { KeyedRelayEvent, KeyedRelayProcess } from '@antseed/keyed-relay';
import type { KeyedRelayTarget, Provider } from './interfaces/seller-provider.js';
import type { RelayGrant } from './p2p/relay-mux.js';
import { keyedRelayEstimatedUsage, keyedRelayModelMatches, keyedRelayUnrevealedUsage, readKeyedRelayReveal } from './keyed-relay-billing.js';
import { checkKeyedRequest, keyedRequestInputTokens } from './keyed-relay-request.js';
import type { ResponseUsage } from './utils/response-usage.js';
import { debugLog, debugWarn } from './utils/debug.js';

/** The most live credentials one buyer may hold at once. */
const MAX_CREDENTIALS_PER_BUYER = 4;
/** How long a credential (a handle only: the upstream credential stays with the seller) lives. */
const CREDENTIAL_TTL_MS = 10 * 60_000;
/** The longest request head the relay writes. */
const MAX_HEAD_BYTES = 8192;
const REFUSED_BUYER = 'this seller no longer relays requests for this buyer';
const BLOCKED_BUYER = 'this seller does not serve your requests';

interface LiveCredential {
  id: string;
  buyerPeerId: string;
  service: string;
  provider: Provider;
  target: KeyedRelayTarget;
  expiresAt: number;
  /** A stream is open on it: one at a time. */
  busy: boolean;
}

/** A keyed request that passed its check, for the seller's payment checks before it is forwarded. */
export interface KeyedRequestAdmission {
  buyerPeerId: string;
  provider: Provider;
  service: string;
  /** Estimated from the body's length. */
  inputTokens: number;
  /** The limit the body ends with, or null for none. */
  maxOutputTokens: number | null;
}

/** The seller's answer to a keyed request: refused, or forwarded. */
export type KeyedRequestDecision =
  | { admitted: false; reason: string }
  | {
    admitted: true;
    /** The payment channel the request was checked against: its cost goes there and to no channel that replaces it. */
    channelId?: string;
    /**
     * Ends what the checks hold for the request (its estimated usage, the
     * channel kept from closing), with the tokens it used. Called once, after
     * the request is charged or when it ends uncharged.
     */
    finish?: (usedTokens: number) => void;
  };

/** What the seller charges for one relayed request. */
export interface BlindRelayCharge {
  buyerPeerId: string;
  requestId: string;
  service: string;
  costUsdc: bigint;
  /** The usage the cost is for. */
  usage: ResponseUsage;
  /** The channel that admitted the request. */
  channelId?: string;
}

/** One admitted request as it ended, for the seller's metering: charged, failed or never answered. */
export interface BlindRelayRecord {
  buyerPeerId: string;
  requestId: string;
  provider: Provider;
  service: string;
  /** The upstream path the request went to. */
  path: string;
  stream: boolean;
  /** The status the buyer revealed, or null when it revealed none. */
  statusCode: number | null;
  /** The usage charged, or null when nothing was. */
  usage: ResponseUsage | null;
  /** Whether `usage` is the seller's estimate, not a figure the buyer revealed. */
  estimated: boolean;
  costUsdc: bigint;
  /** Bytes of TLS records relayed each way; zero when the upstream never answered. */
  bytesUp: number;
  bytesDown: number;
  /** From the stream's opening to the sidecar's end. */
  latencyMs: number;
}

export interface SellerBlindRelayDeps {
  /** Records the cost on the buyer's channel and asks the buyer to sign for it. */
  charge(charge: BlindRelayCharge): void;
  /** Meters an admitted request once it has ended. */
  record?(record: BlindRelayRecord): void;
  /** Starts the seller's sidecar. Absent when it is not installed, and the relay is then off. */
  spawnKeyedRelay?: () => KeyedRelayProcess;
  /** What `usage` costs at the service's token prices, in USDC base units. */
  usageCostUsdc?: (provider: Provider, service: string, usage: ResponseUsage) => bigint;
  /**
   * The payment checks a request gets before it goes upstream (an open
   * channel, prior requests signed for, reserve headroom for its estimated
   * cost, the buyer limits).
   */
  admitKeyedRequest?: (request: KeyedRequestAdmission) => Promise<KeyedRequestDecision> | KeyedRequestDecision;
  /** The longest request body the seller holds for its check. */
  maxKeyedRequestBytes?: number;
  /**
   * The seller's budget for request bytes held at once, shared with direct
   * requests: what a stream sends before its request is forwarded or refused
   * is reserved from it, and a stream with no room left is closed.
   */
  requestBytes?: { tryReserve(bytes: number): boolean; release(bytes: number): void };
  /** Buyers the seller refuses to serve: asked when a handle is minted, when a stream opens and before a request is forwarded. */
  isBuyerBlocked?: (buyerPeerId: string) => boolean;
  now?: () => number;
}

/** The request head the relay writes: request line, Host, the credential headers, then `Connection: close`. */
export function keyedRelayHead(target: KeyedRelayTarget): Uint8Array {
  const unsafe = (value: string): boolean => /[\r\n\0]/.test(value);
  if (!target.path.startsWith('/') || unsafe(target.path) || /\s/.test(target.path) || unsafe(target.host)) {
    throw new Error('the keyed relay target is malformed');
  }
  const host = target.port === 443 ? target.host : `${target.host}:${target.port}`;
  let head = `POST ${target.path} HTTP/1.1\r\nHost: ${host}\r\n`;
  for (const [name, value] of target.headers) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || unsafe(value)) throw new Error('the keyed relay target has a malformed header');
    head += `${name}: ${value}\r\n`;
  }
  // One request per stream, and the credential is never the last header (no line folding onto it).
  head += 'Connection: close\r\n';
  const bytes = new TextEncoder().encode(head);
  if (bytes.length > MAX_HEAD_BYTES) throw new Error('the keyed relay head is too long');
  return bytes;
}

/**
 * The seller's side of the blind relay: hands buyers credential handles, lets
 * a relay stream reach only its handle's upstream, and bills each stream by
 * the usage the buyer reveals.
 */
export class SellerBlindRelay {
  private readonly _credentials = new Map<string, LiveCredential>();
  /** Buyers whose answer contradicted the request the seller checked: they get no more handles and no stream on one they hold. */
  private readonly _keyedRefused = new Set<string>();

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

  /** Drops the handles of `buyerPeerId` that carry no stream. */
  private _dropIdle(buyerPeerId: string): void {
    for (const [id, held] of this._credentials) {
      if (held.buyerPeerId === buyerPeerId && !held.busy) this._credentials.delete(id);
    }
  }

  /** Whether the seller refuses to serve `buyerPeerId`; the handles such a buyer holds idle are dropped. */
  private _blocked(buyerPeerId: string): boolean {
    if (!this._deps.isBuyerBlocked?.(buyerPeerId)) return false;
    this._dropIdle(buyerPeerId);
    return true;
  }

  /** Whether `provider` can serve relay streams here: it names a target and the sidecar is installed. */
  servesKeyed(provider: Provider): boolean {
    return Boolean(provider.keyedRelayTarget && this._deps.spawnKeyedRelay && this._deps.usageCostUsdc);
  }

  /**
   * Mints a credential for `buyerPeerId`: a handle only, the upstream
   * credential never leaves the seller. Throws with a reason the buyer may read.
   */
  mint(buyerPeerId: string, service: string, provider: Provider): BlindRelayCredential {
    const unserved = `service "${service}" is not served through the blind relay`;
    if (!this.servesKeyed(provider)) throw new Error(unserved);
    this._sweep();
    if (this._blocked(buyerPeerId)) throw new Error(BLOCKED_BUYER);
    if (this._keyedRefused.has(buyerPeerId)) throw new Error(REFUSED_BUYER);
    const target = provider.keyedRelayTarget?.(service);
    if (!target) throw new Error(unserved);
    if (!isKeyedRequestTerms(target.request)) throw new Error(`service "${service}" has malformed request terms`);
    keyedRelayHead(target);
    // A buyer keeps a handle per service it used. At the limit the oldest one carrying no stream makes room
    // (the buyer asks again for that service), so only streams, not services, are limited.
    const held = [...this._credentials.values()].filter((c) => c.buyerPeerId === buyerPeerId);
    if (held.length >= MAX_CREDENTIALS_PER_BUYER) {
      const idle = held.find((c) => !c.busy);
      if (!idle) throw new Error('too many live credentials; reuse one');
      this._credentials.delete(idle.id);
    }
    const id = randomBytes(16).toString('hex');
    const expiresAt = this._now() + CREDENTIAL_TTL_MS;
    this._credentials.set(id, { id, buyerPeerId, service, provider, target, expiresAt, busy: false });
    debugLog(`[BlindRelay] handle ${id.slice(0, 8)} for ${buyerPeerId.slice(0, 12)}... service=${service}`);
    return {
      credentialId: id,
      upstream: { host: target.host, port: target.port, baseUrl: target.baseUrl, model: target.model, path: target.path },
      request: target.request,
      expiresAt,
    };
  }

  /** Relay authorizer for one buyer's connection. */
  authorize(buyerPeerId: string, streamId: string, credentialId: string): Promise<RelayGrant> {
    // Whatever handle it names: the handles a blocked or refused buyer held are gone.
    if (this._blocked(buyerPeerId)) return Promise.reject(new Error(BLOCKED_BUYER));
    if (this._keyedRefused.has(buyerPeerId)) return Promise.reject(new Error(REFUSED_BUYER));
    const credential = this._credentials.get(credentialId);
    // Another buyer's credential reads as unknown, so ids reveal nothing.
    if (!credential || credential.buyerPeerId !== buyerPeerId) return Promise.reject(new Error('unknown credential'));
    if (credential.expiresAt <= this._now()) return Promise.reject(new Error('credential expired'));
    if (credential.busy) return Promise.reject(new Error('credential busy'));
    credential.busy = true;
    return Promise.resolve(this._grant(credential, streamId));
  }

  /**
   * The relay stream carries the sidecars' session, and the
   * seller's sidecar connects to the upstream itself. It holds the buyer's
   * request until the request passes `checkKeyedRequest` on the parts the
   * buyer reveals and the payment checks (`admitKeyedRequest`), so the
   * upstream never sees a request the seller has not bounded. The stream is
   * billed from the usage the buyer reveals at the end; a delivered answer
   * with no usage shown is billed by an estimate within the request the
   * seller checked (`keyedRelayUnrevealedUsage`), which the buyer signs only
   * up to its tolerance over the usage it read.
   */
  private _grant(credential: LiveCredential, streamId: string): RelayGrant {
    const { target } = credential;
    let release = (): void => {
      credential.busy = false;
      // A refused buyer's handle opens no further stream: dropped once the stream on it is billed.
      if (this._keyedRefused.has(credential.buyerPeerId)) this._credentials.delete(credential.id);
    };
    /** A sidecar is running for the stream: its exit, after the stream is billed, frees the credential. */
    let live = false;
    const refuseBuyer = (why: string): void => {
      debugWarn(`[BlindRelay] ${streamId.slice(0, 8)} ${why}; refusing ${credential.buyerPeerId.slice(0, 12)}...`);
      this._keyedRefused.add(credential.buyerPeerId);
      this._dropIdle(credential.buyerPeerId);
    };
    /** Bytes reserved from the seller's request budget: what the stream sent while its sidecar holds its request. */
    let reserved = 0;
    /** From the stream's opening until its request is forwarded or refused. */
    let holding = false;
    const letGo = (): void => {
      holding = false;
      if (reserved > 0) this._deps.requestBytes?.release(reserved);
      reserved = 0;
    };
    return {
      accept: (bytes: number): boolean => {
        const budget = this._deps.requestBytes;
        if (!holding || !budget) return true;
        if (!budget.tryReserve(bytes)) return false;
        reserved += bytes;
        return true;
      },
      open: (): Duplex => {
        const sidecar = this._deps.spawnKeyedRelay!();
        live = true;
        holding = true;
        const openedAt = this._now();
        /** The request as admitted: what the seller checked of it, and the channel it was checked against. */
        let admitted: { stream: boolean; inputTokens: number; maxTokens: number | null; channelId?: string } | null = null;
        /** The answer as relayed: its plaintext length and the bytes of TLS records each way. */
        let lengths: { length: number; bytesUp: number; bytesDown: number } | null = null;
        /** Ends what the payment checks hold for the request, with the tokens it used. */
        let finishHold = (_usedTokens: number): void => {};
        let ended = false;
        let billed = false;
        let outcome: Pick<BlindRelayRecord, 'statusCode' | 'usage' | 'estimated' | 'costUsdc'> = { statusCode: null, usage: null, estimated: false, costUsdc: 0n };
        const estimate = (): ResponseUsage | null => {
          if (!lengths) return null;
          if (!admitted) return keyedRelayEstimatedUsage(lengths.bytesUp, lengths.bytesDown);
          // No byte of an answer was relayed: nothing was delivered.
          return lengths.length > 0 ? keyedRelayUnrevealedUsage(admitted.inputTokens, lengths.length, admitted.maxTokens) : null;
        };
        const bill = (usage: ResponseUsage | null, statusCode: number | null): void => {
          if (billed) return;
          billed = true;
          outcome = { ...outcome, statusCode };
          // A failed request is never charged.
          if (statusCode !== null && statusCode >= 400) return;
          const used = usage ?? estimate();
          if (!used) return;
          const costUsdc = this._deps.usageCostUsdc!(credential.provider, credential.service, used);
          outcome = { statusCode, usage: used, estimated: !usage, costUsdc };
          debugLog(`[BlindRelay] ${streamId.slice(0, 8)} in=${used.inputTokens} out=${used.outputTokens}${usage ? '' : ' (estimated)'}; charging ${costUsdc}`);
          if (costUsdc > 0n) {
            this._deps.charge({
              buyerPeerId: credential.buyerPeerId,
              requestId: streamId,
              service: credential.service,
              costUsdc,
              usage: used,
              ...(admitted?.channelId ? { channelId: admitted.channelId } : {}),
            });
          }
          // After the charge: the hold keeps the channel open until the cost is on it.
          finishHold(used.inputTokens + used.outputTokens);
        };
        const admit = async (event: Extract<KeyedRelayEvent, { type: 'request' }>): Promise<void> => {
          const check = checkKeyedRequest(event, target.model, target.request);
          const inputTokens = check.ok ? keyedRequestInputTokens(check.bodyLength) : 0;
          let decision: KeyedRequestDecision = check.ok ? { admitted: true } : { admitted: false, reason: check.reason };
          if (check.ok && this._deps.admitKeyedRequest) {
            try {
              decision = await this._deps.admitKeyedRequest({
                buyerPeerId: credential.buyerPeerId,
                provider: credential.provider,
                service: credential.service,
                inputTokens,
                maxOutputTokens: check.maxTokens,
              });
            } catch (error) {
              debugWarn(`[BlindRelay] ${streamId.slice(0, 8)} payment check failed: ${error instanceof Error ? error.message : error}`);
              decision = { admitted: false, reason: 'the seller could not check the request' };
            }
          }
          // The payment checks waited: the seller may have blocked the buyer meanwhile.
          if (decision.admitted && this._blocked(credential.buyerPeerId)) {
            decision.finish?.(0);
            decision = { admitted: false, reason: BLOCKED_BUYER };
          }
          if (ended) {
            // The sidecar is gone: nothing goes upstream.
            if (decision.admitted) decision.finish?.(0);
            return;
          }
          if (!check.ok || !decision.admitted) {
            const reason = decision.admitted ? 'refused' : decision.reason;
            debugWarn(`[BlindRelay] ${streamId.slice(0, 8)} request refused: ${reason}`);
            sidecar.refuse(reason);
            return;
          }
          if (decision.finish) {
            const finish = decision.finish;
            finishHold = (usedTokens) => {
              finishHold = () => {};
              finish(usedTokens);
            };
          }
          admitted = { stream: check.stream, inputTokens, maxTokens: check.maxTokens, ...(decision.channelId ? { channelId: decision.channelId } : {}) };
          sidecar.admit();
        };
        sidecar.on('event', (event: KeyedRelayEvent) => {
          if (event.type === 'request') void admit(event);
          // Forwarded or dropped: the sidecar holds the request no longer.
          if (event.type === 'admitted' || event.type === 'refused') letGo();
          if (event.type === 'responseEnd') lengths = { length: event.length, bytesUp: event.bytesUp ?? 0, bytesDown: event.bytesDown ?? 0 };
          if (event.type === 'revealed') {
            const { statusCode, usage, model, streamed } = readKeyedRelayReveal(event);
            // Answers that contradict the checked request mean a field hidden in the body won over the checked
            // one (an upstream that keeps the first copy of a key or ignores trailing bytes): billed, and the buyer refused.
            if (model && !keyedRelayModelMatches(model, target.model)) refuseBuyer(`ran model "${model}", not "${target.model}"`);
            const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
            if (ok && admitted && streamed !== null && streamed !== admitted.stream) {
              refuseBuyer(`was answered ${streamed ? 'as a stream' : 'in one body'}, not as checked`);
            }
            bill(usage, statusCode);
          }
        });
        sidecar.on('exit', (exit: { code: number | null; stderr: string }) => {
          // An answer that was delivered but never revealed is still paid for.
          ended = true;
          letGo();
          if (lengths) bill(null, null);
          finishHold(0);
          if (exit.code) debugWarn(`[BlindRelay] ${streamId.slice(0, 8)} sidecar: ${exit.stderr || `exit ${exit.code}`}`);
          const request: { stream: boolean } | null = admitted;
          if (request) {
            this._deps.record?.({
              buyerPeerId: credential.buyerPeerId,
              requestId: streamId,
              provider: credential.provider,
              service: credential.service,
              path: target.path,
              stream: request.stream,
              ...outcome,
              bytesUp: lengths?.bytesUp ?? 0,
              bytesDown: lengths?.bytesDown ?? 0,
              latencyMs: Math.max(0, this._now() - openedAt),
            });
          }
          live = false;
          release();
          release = () => {};
        });
        try {
          sidecar.startSeller({
            host: target.host,
            port: target.port,
            serverName: target.host,
            head: keyedRelayHead(target),
            ...(this._deps.maxKeyedRequestBytes !== undefined ? { maxRequestBytes: this._deps.maxKeyedRequestBytes } : {}),
          });
        } catch (error) {
          letGo();
          sidecar.kill();
          throw error;
        }
        return sidecar.peer;
      },
      onClose: () => {
        // A stream that opened is freed by its sidecar's exit, which bills it first; one that never opened is freed here.
        if (live) return;
        release();
        release = () => {};
      },
    };
  }
}
