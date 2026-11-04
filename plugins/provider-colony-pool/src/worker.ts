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
const CHANNEL_RECHECK_MS = 30_000;

/** Signs attestations about the machine the worker runs on (the Mac app does this with the Secure Enclave). */
export interface WorkerAttester {
  /** Uncompressed P-256 public key, lowercase hex. */
  publicKey: string;
  attest(nonce: string, worker: string, encryptionKey: string): Promise<WorkerAttestation>;
}

/** Whether `channel` on-chain belongs to `buyer` and to the pool's `seller`. `null` = not known yet. */
export type ChannelVerifier = (channel: string, buyer: string, seller: string) => Promise<boolean | null>;

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
  private backoffMs = 1_000;
  private paused = false;
  private welcome: WelcomeFrame | null = null;
  private seller: string | null = null;
  private checkTimes: number[] = [];
  /** channel → verdict: true (verified), false (belongs to someone else), or pending re-check time. */
  private readonly channels = new Map<string, boolean | number>();

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
    const ws = new WebSocket(this.opts.poolUrl, { maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parsePoolFrame(data.toString());
      if (frame) void this.handle(frame);
    });
    ws.on('open', () => this.log(`connected to ${this.opts.poolUrl}`));
    ws.on('close', (code, reason) => {
      this.welcome = null;
      for (const controller of this.active.values()) controller.abort();
      this.active.clear();
      if (this.stopped) return;
      this.log(`disconnected (${code}${reason.length ? ` ${reason.toString()}` : ''}); retrying in ${Math.round(this.backoffMs / 1000)}s`);
      setTimeout(() => this.connect(), this.backoffMs);
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
        await this.serve(frame);
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
   * Whether to serve a request bound to `channel`. Verification runs in the
   * background (RPC reads can lag a fresh reserve); a channel proven to belong
   * to someone else is refused from then on.
   */
  private channelAllowed(channel: string, buyer: string): boolean {
    const verifier = this.opts.channelVerifier;
    if (!verifier || !this.seller) return true;
    const verdict = this.channels.get(channel);
    if (verdict === true) return true;
    if (verdict === false) return false;
    if (typeof verdict === 'number' && Date.now() < verdict) return true;
    this.channels.set(channel, Date.now() + CHANNEL_RECHECK_MS);
    void verifier(channel, buyer, this.seller).then((result) => {
      if (result === null) return;
      this.channels.set(channel, result);
      if (!result) this.log(`channel ${channel.slice(0, 18)}… does not belong to buyer ${buyer} of this pool; refusing it`);
    }).catch(() => {});
    return true;
  }

  private async serve(frame: RequestFrame): Promise<void> {
    const fail = (message: string): void => { this.send({ t: 'response-error', id: frame.id, message }); };
    if (frame.method !== 'POST' || !ALLOWED_PATHS.has(frame.path)) {
      fail(`Unsupported route ${frame.method} ${frame.path}`);
      return;
    }
    const sealedBody = decodeBody(frame.body);
    if (!isSealedRequest(sealedBody)) {
      fail('Refusing an unencrypted request');
      return;
    }
    let opened: ReturnType<typeof openRequest>;
    let body: Record<string, unknown>;
    try {
      opened = openRequest(sealedBody, this.wallet.address, this.opts.encryptionKey);
      body = JSON.parse(new TextDecoder().decode(opened.body)) as Record<string, unknown>;
    } catch {
      fail('Request could not be decrypted for this worker');
      return;
    }

    if (opened.buyer && opened.channel && !/^0x0+$/.test(opened.channel)) {
      if (!this.channelAllowed(opened.channel.toLowerCase(), opened.buyer)) {
        fail('Request channel does not belong to a buyer of this pool');
        return;
      }
    } else {
      // No buyer binding: a pool check. Keep it small so it cannot buy real work.
      if (!this.allowCheck()) {
        fail('Check rate limit exceeded');
        return;
      }
      body['max_tokens'] = Math.min(typeof body['max_tokens'] === 'number' ? body['max_tokens'] : CHECK_MAX_TOKENS, CHECK_MAX_TOKENS);
      delete body['max_completion_tokens'];
    }

    const localModel = this.opts.services[opened.model];
    if (!localModel || this.paused) {
      fail(`Not serving ${opened.model}`);
      return;
    }
    body['model'] = localModel;
    // Usage in the final stream event is what the buyer is charged for.
    if (body['stream'] === true) {
      body['stream_options'] = { ...(body['stream_options'] as object | undefined), include_usage: true };
    }

    this.log(opened.buyer
      ? `serving ${opened.model} for buyer ${opened.buyer} on channel ${opened.channel?.slice(0, 18)}…`
      : `serving a pool check for ${opened.model}`);
    const controller = new AbortController();
    this.active.set(frame.id, controller);
    try {
      const upstream = await fetch(new URL(frame.path, this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: frame.headers['accept'] ?? 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const contentType = upstream.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && upstream.body) {
        this.send({ t: 'response-start', id: frame.id, status: upstream.status, headers: { 'content-type': contentType } });
        for await (const chunk of upstream.body) {
          const sealed = opened.sealer.pushStream(chunk as Uint8Array);
          if (sealed.length > 0) this.send({ t: 'response-chunk', id: frame.id, data: encodeBody(sealed) });
        }
        this.send({ t: 'response-chunk', id: frame.id, data: encodeBody(opened.sealer.finishStream()) });
      } else {
        const sealed = opened.sealer.sealBody(new Uint8Array(await upstream.arrayBuffer()));
        this.send({ t: 'response-start', id: frame.id, status: upstream.status, headers: { 'content-type': 'application/json' } });
        this.send({ t: 'response-chunk', id: frame.id, data: encodeBody(sealed) });
      }
      this.send({ t: 'response-end', id: frame.id });
    } catch (err) {
      fail(controller.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err));
    } finally {
      this.active.delete(frame.id);
    }
  }

  private send(frame: WorkerFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private log(line: string): void {
    this.opts.log?.(`[worker] ${line}`);
  }
}
