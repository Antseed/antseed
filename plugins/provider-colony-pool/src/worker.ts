import { Wallet } from 'ethers';
import WebSocket from 'ws';
import {
  isSealedRequest,
  openRequest,
  workerKeyCertificateMessage,
  workerKeyHex,
  type WorkerAttestation,
  type WorkerEncryptionKey,
} from '@antseed/node/worker-e2e';
import {
  decodeBody,
  encodeBody,
  parsePoolFrame,
  workerAuthMessage,
  type PoolFrame,
  type RequestFrame,
  type WelcomeFrame,
  type WorkerFrame,
  type WorkerStats,
} from './protocol.js';

/** The only upstream route a pool may reach on the worker's machine. */
const ALLOWED_PATHS = new Set(['/v1/chat/completions']);
const MAX_BACKOFF_MS = 60_000;
const CERTIFICATE_LIFETIME_S = 24 * 60 * 60;
/** Requests without a buyer binding are the pool's own checks: kept tiny and rare. */
const CHECK_MAX_TOKENS = 16;
const DEFAULT_CHECKS_PER_HOUR = 240;
/** How long a request waits for its channel to show on-chain (a fresh reserve can lag the RPC), and how often it looks. */
const DEFAULT_CHANNEL_WAIT_MS = 5_000;
const CHANNEL_POLL_MS = 1_000;
/** Bounds the per-channel caches; past it they start over. */
const MAX_CACHED_CHANNELS = 10_000;
/** A pool check's decrypted body may be at most this big, so it cannot buy prompt processing either. */
const MAX_CHECK_BODY_BYTES = 8 * 1024;
/** How long the local model has to send response headers, and then each next chunk. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_UPSTREAM_IDLE_MS = 60_000;

/** Signs attestations about the machine the worker runs on (the Mac app does this with the Secure Enclave). */
export interface WorkerAttester {
  /** Uncompressed P-256 public key, lowercase hex. */
  publicKey: string;
  attest(nonce: string, worker: string, encryptionKey: string): Promise<WorkerAttestation>;
}

/** Whether `channel` on-chain belongs to `buyer` and to the pool's `seller`. `null` = not on-chain (yet). */
export type ChannelVerifier = (channel: string, buyer: string, seller: string) => Promise<boolean | null>;

/**
 * A ChannelVerifier over `readChannel`, which must read the channel from the
 * worker's trusted Channels contract (from its chain config), never from a
 * contract the pool names: a pool could otherwise answer with a contract of
 * its own that vouches for any channel.
 */
export function trustedChannelVerifier(readChannel: (channel: string) => Promise<{ buyer: string; seller: string }>): ChannelVerifier {
  return async (channel, buyer, seller) => {
    const session = await readChannel(channel);
    if (/^0x0+$/.test(session.buyer)) return null; // not visible yet
    return session.buyer.toLowerCase() === buyer.toLowerCase() && session.seller.toLowerCase() === seller.toLowerCase();
  };
}

export interface PoolWorkerOptions {
  /** Pool WebSocket URL, e.g. wss://pool.example.com. */
  poolUrl: string;
  /** Local OpenAI-compatible server, e.g. http://127.0.0.1:8080 (mlx_lm.server) or http://127.0.0.1:11434 (Ollama). */
  baseUrl: string;
  /** Announced service → local model name. */
  services: Record<string, string>;
  /** Worker identity and payout address. */
  privateKey: string;
  /** Key buyers encrypt requests to. */
  encryptionKey: WorkerEncryptionKey;
  /** Attests hello and every `attest` frame; without it the worker joins unattested. */
  attester?: WorkerAttester;
  /** Checks that requests come from real buyers of this pool; without it, bindings are only signature-checked. */
  channelVerifier?: ChannelVerifier;
  /** How long a request waits for its channel to be verified before it is refused (default 5 s). */
  channelWaitMs?: number;
  /** How long the local model has to start answering (default 5 min), and then to send each next chunk (default 60 s). */
  upstreamTimeoutMs?: number;
  upstreamIdleMs?: number;
  maxConcurrency?: number;
  checksPerHour?: number;
  agent?: string;
  log?: (line: string) => void;
}

/**
 * Reference worker: keeps a connection to a pool open and serves its
 * encrypted requests from a local OpenAI-compatible model server. The pool
 * never sees prompts or answers.
 */
export class PoolWorker {
  private readonly opts: PoolWorkerOptions;
  private readonly wallet: Wallet;
  private ws: WebSocket | null = null;
  private readonly active = new Map<string, AbortController>();
  private readonly statsWaiters = new Map<string, (stats: WorkerStats) => void>();
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private paused = false;
  private welcome: WelcomeFrame | null = null;
  private seller: string | null = null;
  private checkTimes: number[] = [];
  /** Verified: channel → the buyer the chain says owns it. */
  private readonly channelOwners = new Map<string, string>();
  /** Refused: `channel|buyer` pairs the chain shows are not that buyer's channel with this pool. */
  private readonly refusedChannels = new Set<string>();
  /** Pending: one lookup per `channel|buyer`, shared by the requests waiting on it. */
  private readonly verifying = new Map<string, Promise<boolean | null>>();

  constructor(opts: PoolWorkerOptions) {
    this.opts = opts;
    this.wallet = new Wallet(opts.privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  get acceptedServices(): string[] {
    return this.welcome?.accepted ?? [];
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const controller of this.active.values()) controller.abort();
    this.ws?.close(1000, 'worker stopping');
  }

  /** Stop taking new requests (owner is using the machine) without leaving the pool. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ t: 'services', services: paused ? [] : Object.keys(this.opts.services) });
  }

  /** Ask the pool for this worker's earnings. */
  requestStats(timeoutMs = 10_000): Promise<WorkerStats> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statsWaiters.delete(id);
        reject(new Error('Pool did not answer the stats request'));
      }, timeoutMs);
      this.statsWaiters.set(id, (stats) => {
        clearTimeout(timer);
        resolve(stats);
      });
      if (!this.send({ t: 'stats-request', id })) {
        clearTimeout(timer);
        this.statsWaiters.delete(id);
        reject(new Error('Not connected to the pool'));
      }
    });
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.poolUrl, { maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary || this.stopped) return;
      const frame = parsePoolFrame(data.toString());
      if (frame) this.handle(frame).catch((err: unknown) => this.log(`could not handle ${frame.t}: ${err instanceof Error ? err.message : String(err)}`));
    });
    ws.on('open', () => this.log(`connected to ${this.opts.poolUrl}`));
    ws.on('close', (code, reason) => {
      this.welcome = null;
      // Requests release their slots as they unwind; their answers can't reach the next connection.
      for (const controller of this.active.values()) controller.abort();
      if (this.stopped) return;
      this.log(`disconnected (${code}${reason.length ? ` ${reason.toString()}` : ''}); retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    });
    ws.on('error', (err) => this.log(`connection error: ${err.message}`));
  }

  private async handle(frame: PoolFrame): Promise<void> {
    switch (frame.t) {
      case 'challenge': {
        this.seller = frame.seller;
        const key = workerKeyHex(this.opts.encryptionKey.publicKey);
        const expires = Math.floor(Date.now() / 1000) + CERTIFICATE_LIFETIME_S;
        const attester = this.opts.attester;
        const [signature, certificate, attestation] = await Promise.all([
          this.wallet.signMessage(workerAuthMessage(frame.pool, frame.nonce)),
          this.wallet.signMessage(workerKeyCertificateMessage(frame.seller, key, expires, attester?.publicKey)),
          attester?.attest(frame.nonce, this.wallet.address, key),
        ]);
        this.send({
          t: 'hello',
          address: this.wallet.address,
          signature,
          services: this.paused ? [] : Object.keys(this.opts.services),
          maxConcurrency: this.opts.maxConcurrency ?? 1,
          encryption: { key, expires, certificate, ...(attester ? { attestationKey: attester.publicKey } : {}) },
          ...(attestation ? { attestation } : {}),
          agent: this.opts.agent ?? 'antseed-pool-worker/0.1.0',
        });
        return;
      }
      case 'welcome':
        this.welcome = frame;
        this.backoffMs = 1_000;
        this.log(`joined pool as ${frame.workerId}: serving ${frame.accepted.join(', ') || 'nothing'}${frame.rejected.length ? ` (pool doesn't sell ${frame.rejected.join(', ')})` : ''}, ${frame.workerShareBps / 100}% share`);
        return;
      case 'request':
        await this.serve(frame, this.ws);
        return;
      case 'cancel':
        this.active.get(frame.id)?.abort();
        return;
      case 'stats':
        this.statsWaiters.get(frame.id)?.(frame.stats);
        this.statsWaiters.delete(frame.id);
        return;
      case 'error':
        this.log(`pool error: ${frame.message}`);
        return;
      case 'attest':
        if (this.opts.attester) {
          const attestation = await this.opts.attester.attest(frame.nonce, this.wallet.address, workerKeyHex(this.opts.encryptionKey.publicKey));
          this.send({ t: 'attestation', attestation });
        }
        return;
    }
  }

  /** Room for one more pool check this hour. */
  private allowCheck(): boolean {
    const now = Date.now();
    this.checkTimes = this.checkTimes.filter((t) => now - t < 3_600_000);
    if (this.checkTimes.length >= (this.opts.checksPerHour ?? DEFAULT_CHECKS_PER_HOUR)) return false;
    this.checkTimes.push(now);
    return true;
  }

  /**
   * Whether `channel` is `buyer`'s channel with this pool: true (verified),
   * false (refused) or null (not on-chain within the wait). Only a verified
   * channel gets full requests, so a pool cannot buy real work by signing
   * bindings to channels that do not exist. Lookups are shared by concurrent
   * requests and both verdicts are cached; an unknown one is looked up again
   * by the next request.
   */
  private channelVerdict(channel: string, buyer: string): Promise<boolean | null> | boolean {
    const verifier = this.opts.channelVerifier;
    if (!verifier || !this.seller) return true;
    buyer = buyer.toLowerCase();
    // A channel proven to be another buyer's never serves this one.
    const owner = this.channelOwners.get(channel);
    if (owner !== undefined) return owner === buyer;
    const key = `${channel}|${buyer}`;
    if (this.refusedChannels.has(key)) return false;
    let pending = this.verifying.get(key);
    if (!pending) {
      pending = this.lookUpChannel(verifier, channel, buyer, this.seller).finally(() => this.verifying.delete(key));
      this.verifying.set(key, pending);
    }
    return pending;
  }

  private async lookUpChannel(verifier: ChannelVerifier, channel: string, buyer: string, seller: string): Promise<boolean | null> {
    const deadline = Date.now() + (this.opts.channelWaitMs ?? DEFAULT_CHANNEL_WAIT_MS);
    for (;;) {
      const remaining = deadline - Date.now();
      const result = await withTimeout(verifier(channel, buyer, seller), Math.max(remaining, 1)).catch(() => null);
      if (result === true) {
        if (this.channelOwners.size >= MAX_CACHED_CHANNELS) this.channelOwners.clear();
        this.channelOwners.set(channel, buyer);
        return true;
      }
      if (result === false) {
        if (this.refusedChannels.size >= MAX_CACHED_CHANNELS) this.refusedChannels.clear();
        this.refusedChannels.add(`${channel}|${buyer}`);
        this.log(`channel ${channel.slice(0, 18)}… does not belong to buyer ${buyer} of this pool; refusing it`);
        return false;
      }
      if (Date.now() + CHANNEL_POLL_MS >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, CHANNEL_POLL_MS));
    }
  }

  /**
   * Serve one request on the connection it arrived on. Its slot is taken
   * before any waiting (channel check, model), so the pool can never run
   * more than `maxConcurrency` at once, and it is cancellable throughout.
   */
  private async serve(frame: RequestFrame, ws: WebSocket | null): Promise<void> {
    const send = (out: WorkerFrame): void => { this.sendOn(ws, out); };
    const fail = (message: string): void => { send({ t: 'response-error', id: frame.id, message }); };
    if (this.active.has(frame.id)) {
      fail('Duplicate request id');
      return;
    }
    if (this.active.size >= (this.opts.maxConcurrency ?? 1)) {
      fail('Worker is at capacity');
      return;
    }
    const controller = new AbortController();
    this.active.set(frame.id, controller);
    try {
      await this.run(frame, controller.signal, send);
    } catch (err) {
      fail(controller.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err));
    } finally {
      if (this.active.get(frame.id) === controller) this.active.delete(frame.id);
    }
  }

  private async run(frame: RequestFrame, signal: AbortSignal, send: (out: WorkerFrame) => void): Promise<void> {
    if (frame.method !== 'POST' || !ALLOWED_PATHS.has(frame.path)) throw new Error(`Unsupported route ${frame.method} ${frame.path}`);
    const sealedBody = decodeBody(frame.body);
    if (!isSealedRequest(sealedBody)) throw new Error('Refusing an unencrypted request');
    let opened: ReturnType<typeof openRequest>;
    let body: Record<string, unknown>;
    try {
      opened = openRequest(sealedBody, this.wallet.address, this.opts.encryptionKey);
      body = JSON.parse(new TextDecoder().decode(opened.body)) as Record<string, unknown>;
    } catch {
      throw new Error('Request could not be decrypted for this worker');
    }
    const localModel = this.opts.services[opened.model];
    if (!localModel || this.paused) throw new Error(`Not serving ${opened.model}`);

    if (opened.buyer && opened.channel && !/^0x0+$/.test(opened.channel)) {
      const verdict = await abortable(this.channelVerdict(opened.channel.toLowerCase(), opened.buyer), signal);
      if (verdict === false) throw new Error('Request channel does not belong to a buyer of this pool');
      if (verdict === null) throw new Error('Request channel is not on-chain yet; retry shortly');
    } else {
      // No buyer binding: a pool check. Keep it small so it cannot buy real work, prompt processing included.
      if (opened.body.length > MAX_CHECK_BODY_BYTES) throw new Error(`Check requests are limited to ${MAX_CHECK_BODY_BYTES} bytes`);
      if (!this.allowCheck()) throw new Error('Check rate limit exceeded');
      body['max_tokens'] = Math.min(typeof body['max_tokens'] === 'number' ? body['max_tokens'] : CHECK_MAX_TOKENS, CHECK_MAX_TOKENS);
      delete body['max_completion_tokens'];
    }
    if (signal.aborted || this.stopped) throw new Error('cancelled');

    body['model'] = localModel;
    // Usage in the final stream event is what the buyer is charged for.
    if (body['stream'] === true) {
      body['stream_options'] = { ...(body['stream_options'] as object | undefined), include_usage: true };
    }
    this.log(opened.buyer
      ? `serving ${opened.model} for buyer ${opened.buyer} on channel ${opened.channel?.slice(0, 18)}…`
      : `serving a pool check for ${opened.model}`);

    // The local model gets its own deadlines: one to answer, then one per chunk.
    const upstreamAbort = new AbortController();
    const onAbort = (): void => upstreamAbort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; upstreamAbort.abort(); }, ms);
    };
    const idleMs = this.opts.upstreamIdleMs ?? DEFAULT_UPSTREAM_IDLE_MS;
    arm(this.opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
    try {
      const upstream = await fetch(new URL(frame.path, this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: frame.headers['accept'] ?? 'application/json' },
        body: JSON.stringify(body),
        signal: upstreamAbort.signal,
      });
      const contentType = upstream.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && upstream.body) {
        send({ t: 'response-start', id: frame.id, status: upstream.status, headers: { 'content-type': contentType } });
        arm(idleMs);
        for await (const chunk of upstream.body) {
          arm(idleMs);
          const sealed = opened.sealer.pushStream(chunk as Uint8Array);
          if (sealed.length > 0) send({ t: 'response-chunk', id: frame.id, data: encodeBody(sealed) });
        }
        send({ t: 'response-chunk', id: frame.id, data: encodeBody(opened.sealer.finishStream()) });
      } else {
        const sealed = opened.sealer.sealBody(new Uint8Array(await upstream.arrayBuffer()));
        send({ t: 'response-start', id: frame.id, status: upstream.status, headers: { 'content-type': 'application/json' } });
        send({ t: 'response-chunk', id: frame.id, data: encodeBody(sealed) });
      }
      send({ t: 'response-end', id: frame.id });
    } catch (err) {
      if (timedOut && !signal.aborted) throw new Error('Local model timed out');
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private send(frame: WorkerFrame): boolean {
    return this.sendOn(this.ws, frame);
  }

  private sendOn(ws: WebSocket | null, frame: WorkerFrame): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private log(line: string): void {
    this.opts.log?.(`[worker] ${line}`);
  }
}

/** `value`, or a rejection once `signal` aborts. */
function abortable<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (!(value instanceof Promise)) return signal.aborted ? Promise.reject(new Error('cancelled')) : Promise.resolve(value);
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  let onAbort: (() => void) | undefined;
  return Promise.race([
    value,
    new Promise<T>((_, reject) => {
      onAbort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener('abort', onAbort!));
}

/** `promise`, or a rejection after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
