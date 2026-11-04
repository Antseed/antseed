import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { verifyMessage } from 'ethers';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  APPLE_ATTESTATION_REISSUE_S,
  DEVICE_ATTESTATION_MAX_AGE_S,
  deviceAttestationChallenge,
  deviceAttestationNonce,
  MAX_WORKER_RECIPIENTS,
  sealRequest,
  verifyDeviceAttestation,
  verifyWorkerAttestation,
  type DeviceAttestation,
  verifyWorkerKeyCertificate,
  type WorkerAssignment,
  type WorkerAttestation,
  type WorkerKeyCertificate,
} from '@antseed/node/worker-e2e';
import type { SerializedHttpRequest } from '@antseed/node';
import type { WorkerLedger } from './ledger.js';
import type { DeviceAttestor } from './mdm.js';
import { newRank, rankScores, recordOutcome, recordSpeed, type WorkerRank } from './ranking.js';
import {
  COLONY_POOL_PROTOCOL_VERSION,
  decodeBody,
  encodeBody,
  parseWorkerFrame,
  workerAuthMessage,
  type PoolFrame,
  type WorkerFrame,
} from './protocol.js';

const HELLO_TIMEOUT_MS = 10_000;
const CANARY_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 15_000;
/** A worker that misses this many pings in a row is disconnected (a sleeping Mac, a dropped path). */
const MAX_MISSED_PINGS = 2;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_CONCURRENCY = 64;
/** A started response that sends nothing for this long is cancelled. */
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 60_000;
/** How long a worker has to pick a request up (its `accepted` frame). */
const DEFAULT_ACCEPT_TIMEOUT_MS = 20_000;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
/** Most a worker may send for one buyer response, and for one of the pool's own checks. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CHECK_RESPONSE_BYTES = 1024 * 1024;
/** How often a join check looks for a free slot on a busy worker. */
const CHECK_SLOT_POLL_MS = 1_000;
/** A certificate must outlive the connection's first minute to be accepted. */
const MIN_CERTIFICATE_LIFETIME_S = 60;
/** Reconnect a worker this long before its certificate expires (buyers stop using one 5 minutes before). */
const CERTIFICATE_RENEW_MARGIN_S = 3600;
/** Assignments count toward a worker's load for this long, so new buyers spread out. */
const ASSIGNMENT_WEIGHT_MS = 10 * 60_000;
/** Attested workers re-attest this often, and have this long to answer. */
const ATTESTATION_INTERVAL_MS = 5 * 60_000;
const ATTESTATION_REPLY_MS = 30_000;
/** An attestation answering a challenge must be this fresh. */
const ATTESTATION_MAX_AGE_S = 120;
/** How often the pool asks again while Apple still returns an attestation older than its reissue interval. */
const DEVICE_ATTESTATION_INTERVAL_MS = 24 * 60 * 60_000;

export interface ColonyPoolOptions {
  poolId: string;
  /** Address buyers pay (the AntseedColonyPool contract, or the seller node's address). */
  seller: string;
  /** Services this pool sells. Workers' other services are ignored. */
  catalog: string[];
  workerShareBps: number;
  ledger: WorkerLedger;
  port: number;
  host?: string;
  tls?: { cert: string; key: string };
  /** If set, only these worker addresses may join. */
  allowedWorkers?: Set<string>;
  /** Send each newly offered service a short completion before routing buyers to it. */
  verifyOnJoin?: boolean;
  /** How long a worker has to start answering a request (default 120 s). */
  firstByteTimeoutMs?: number;
  /** How long a worker has to pick a request up with an `accepted` frame (default 20 s). */
  acceptTimeoutMs?: number;
  /** Operator weights by worker address (COLONY_POOL_WORKER_PRIORITY); 1 by default, 0 never routes. */
  workerPriority?: Map<string, number>;
  /** How long a started response may go without a chunk before it is cancelled. */
  responseIdleTimeoutMs?: number;
  /** How often workers are pinged; one that misses two pings in a row is disconnected (default 15 s). */
  heartbeatIntervalMs?: number;
  /** Only admit workers whose attestation reports a hardened Mac (signed app, SIP on, app-bound key). */
  requireAttestation?: boolean;
  /** If set, only apps signed by these Apple Developer teams count as hardened. */
  attestedTeams?: Set<string>;
  attestationIntervalMs?: number;
  /** The operator's MDM, for Apple-signed attestations of enrolled Macs (optional). */
  deviceAttestor?: DeviceAttestor;
  /** Only route to Macs Apple attests through the operator's MDM (SIP on, serial matches). */
  requireDeviceAttestation?: boolean;
  /** How often to ask again while Apple still returns an attestation past its 7-day reissue interval (default daily). */
  deviceAttestationIntervalMs?: number;
  /** Trust anchors for device attestations; Apple's root unless a test overrides it. */
  deviceAttestationRoots?: string[];
  log?: (line: string) => void;
}

export interface DispatchHandlers {
  onStart(status: number, headers: Record<string, string>): void;
  onChunk(data: Uint8Array): void;
  onEnd(): void;
  onError(error: Error): void;
  /** The request went to `worker` under the pool's `dispatchId` (once per failover attempt). */
  onAttempt?(worker: string, dispatchId: string): void;
}

export type DispatchRequest = SerializedHttpRequest;

export class NoWorkerAvailableError extends Error {
  constructor(service: string) {
    super(`No worker is available for ${service}`);
    this.name = 'NoWorkerAvailableError';
  }
}

/** The worker a sealed request names is gone, busy, or no longer serves the model. */
export class WorkerUnavailableError extends Error {
  constructor(worker: string, reason: string) {
    super(`Worker ${worker} is unavailable: ${reason}`);
    this.name = 'WorkerUnavailableError';
  }
}

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface InFlight {
  handlers: DispatchHandlers;
  started: boolean;
  /** The worker said it took the request (`accepted`), or started answering. */
  accepted: boolean;
  /** A buyer dispatch: its outcome counts toward the worker's rank. */
  ranked: boolean;
  /** Re-arms `timer` with the first-byte deadline, once the worker accepted. */
  accept: () => void;
  /** First-byte deadline until the response starts, then the idle deadline, refreshed by every chunk. */
  timer: NodeJS.Timeout | null;
  /** Re-arms `timer` with the idle deadline. */
  touch: () => void;
  /** Response bytes received, bounded by `maxBytes`. */
  bytes: number;
  maxBytes: number;
  /** Removes the caller's abort listener. */
  release: () => void;
  startedAt: number;
  firstByteAt: number | null;
  /** The answer is an SSE stream, so its delivery time is its generation time. */
  streamed: boolean;
  /** The caller's request ID; worker frames use a pool-owned dispatch ID, since buyers' IDs can collide. */
  requestId: string;
}

export interface RequestTiming {
  startedAt: number;
  firstByteAt: number | null;
  endedAt: number;
  /**
   * Streamed answer. A buffered one arrives in one burst after the worker has
   * generated all of it, so first byte to end says nothing about decode speed.
   */
  streamed: boolean;
}

interface ConnectedWorker {
  address: string;
  agent: string;
  ws: WebSocket;
  certificate: WorkerKeyCertificate;
  /** Latest attestation that verified, and whether it reports a hardened Mac. */
  attestation: WorkerAttestation | null;
  hardened: boolean;
  attestTimer: NodeJS.Timeout | null;
  /** Nonce of the outstanding `attest` frame, while one is unanswered. */
  attestNonce: string | null;
  /** Apple's attestation from the operator's MDM, once one verified. */
  deviceAttestation: DeviceAttestation | null;
  /** Unix seconds when `deviceAttestation` grows too old or its chain expires. */
  deviceValidUntil: number;
  deviceTimer: NodeJS.Timeout | null;
  /** Bumped by each MDM lookup, so an older lookup still in flight can't overwrite a newer one. */
  deviceGeneration: number;
  /** Closes the connection before the key certificate expires, so the worker reconnects and certifies again. */
  renewTimer: NodeJS.Timeout | null;
  connectionId: number;
  maxConcurrency: number;
  /** Services the worker offers that the pool sells. */
  offered: Set<string>;
  /** Offered services that passed the join check (all of them when verification is off). */
  verified: Set<string>;
  inflight: Map<string, InFlight>;
  /** Timing of recently finished requests, kept until the charge hook reads it. */
  finished: Map<string, RequestTiming>;
  /** Join checks run one at a time, each in a free slot, so they never exceed the worker's capacity. */
  checks: Promise<void>;
  /** When buyers were recently assigned to this worker. */
  assignedAt: number[];
  /** Pings sent since the last pong. */
  missedPings: number;
  /** Shared with the pool's rank table, so it outlives this connection. */
  rank: WorkerRank;
}

export interface WorkerSummary {
  address: string;
  agent: string;
  services: string[];
  inflight: number;
  maxConcurrency: number;
  tokensPerSecond: number;
  /** The worker's latest attestation reports a hardened Mac. */
  attested: boolean;
  /** Apple attests this Mac (SIP on) through the operator's MDM. */
  appleVerified: boolean;
  /** Smoothed share of buyer dispatches that ended well, null until the first one. */
  reliability: number | null;
  /** Smoothed time to first byte, ms. */
  firstByteMs: number | null;
  /** Not routed before this time (ms), after failing to answer; null when not benched. */
  benchedUntil: number | null;
  /** Operator weight; 0 means the pool never routes to it. */
  priority: number;
}

/** How long stop() waits for connections to finish their close handshake. */
const STOP_GRACE_MS = 1_000;

/**
 * Accepts worker connections, verifies them, and routes requests to the
 * best-ranked worker that serves the requested service (ranking.ts).
 */
export class ColonyPool {
  private readonly opts: ColonyPoolOptions;
  private readonly catalog: Set<string>;
  private readonly workers = new Map<string, ConnectedWorker>();
  /** Every worker's rank, kept across reconnects (and in the ledger across restarts). */
  private readonly ranks = new Map<string, WorkerRank>();
  private readonly changeListeners: Array<() => void> = [];
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastServices = '';

  constructor(opts: ColonyPoolOptions) {
    this.opts = opts;
    this.catalog = new Set(opts.catalog);
  }

  async start(): Promise<number> {
    const server = this.opts.tls ? createHttpsServer(this.opts.tls) : createHttpServer();
    server.on('request', (_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('Antseed colony pool: connect with a WebSocket.\n');
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
    wss.on('connection', (ws) => this.accept(ws));
    // The server's errors (a taken port) reach the listen below; without this
    // handler their re-emit on `wss` would throw before it can reject.
    wss.on('error', () => {});
    this.server = server;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.pingTimer = setInterval(() => {
      for (const worker of [...this.workers.values()]) {
        if (worker.missedPings >= MAX_MISSED_PINGS) {
          this.log(`worker ${worker.address} stopped answering pings; disconnecting it`);
          worker.ws.terminate(); // its close event drops it and fails what it was serving
          continue;
        }
        worker.missedPings += 1;
        worker.ws.ping();
      }
    }, this.opts.heartbeatIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref();
    const address = server.address();
    return typeof address === 'object' && address ? address.port : this.opts.port;
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    await this.opts.deviceAttestor?.stop?.();
    const wss = this.wss;
    // Every connection, including ones that never finished joining: the
    // server only reports closed once they are all gone.
    for (const client of wss?.clients ?? []) client.close(1001, 'pool stopping');
    const closed = new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    const grace = setTimeout(() => { for (const client of wss?.clients ?? []) client.terminate(); }, STOP_GRACE_MS);
    await closed;
    clearTimeout(grace);
    const server = this.server;
    this.server = null;
    this.wss = null;
    // Upgraded worker sockets would otherwise hold the port until their close handshake ends.
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /** Services at least one connected worker can serve right now. */
  availableServices(): string[] {
    const services = new Set<string>();
    for (const worker of this.workers.values()) {
      if (!this.routable(worker) || this.priority(worker.address) === 0) continue;
      for (const service of worker.verified) services.add(service);
    }
    return this.opts.catalog.filter((service) => services.has(service));
  }

  capacity(): { current: number; max: number } {
    let current = 0;
    let max = 0;
    for (const worker of this.workers.values()) {
      current += worker.inflight.size;
      max += worker.maxConcurrency;
    }
    return { current, max };
  }

  workerSummaries(): WorkerSummary[] {
    const now = Date.now();
    return [...this.workers.values()].map((worker) => ({
      address: worker.address,
      agent: worker.agent,
      services: [...worker.verified],
      inflight: worker.inflight.size,
      maxConcurrency: worker.maxConcurrency,
      tokensPerSecond: worker.rank.tokensPerSecond,
      attested: worker.hardened,
      appleVerified: this.appleVerified(worker),
      reliability: worker.rank.reliability,
      firstByteMs: worker.rank.firstByteMs,
      benchedUntil: worker.rank.benchedUntil > now ? worker.rank.benchedUntil : null,
      priority: this.priority(worker.address),
    }));
  }

  /**
   * The best-ranked `count` workers for a buyer (1 to MAX_WORKER_RECIPIENTS),
   * each with its key certificate and attestations: the buyer encrypts each
   * request for all of them, and the pool tries them in rank order. Throws
   * NoWorkerAvailableError.
   */
  assign(service: string, count = 1): WorkerAssignment[] {
    const workers = this.rankedWorkers(service, true).slice(0, Math.max(1, Math.min(MAX_WORKER_RECIPIENTS, Math.floor(count))));
    if (workers.length === 0) throw new NoWorkerAvailableError(service);
    // Only the first is tried first, so only it takes the new buyer's load.
    workers[0]!.assignedAt.push(Date.now());
    return workers.map((worker) => ({
      ...worker.certificate,
      ...(worker.attestation ? { attestation: worker.attestation } : {}),
      ...(worker.deviceAttestation && this.appleVerified(worker) ? { deviceAttestation: worker.deviceAttestation } : {}),
    }));
  }

  /**
   * Send a buyer's sealed request to one of the workers it is encrypted for,
   * best-ranked first. A worker that fails before the response starts (it
   * never picks the request up, refuses it, disconnects, or is benched) is
   * replaced by the next recipient: never a worker outside the set, and never
   * two at once. The response arrives through `handlers`; `onAttempt` names
   * each worker tried and its dispatch ID (unique even when buyers reuse
   * request IDs). Throws WorkerUnavailableError when no recipient can take
   * it, or reports it through `onError` once every one has failed, so the
   * buyer reassigns.
   */
  dispatch(recipients: readonly string[], service: string, req: DispatchRequest, handlers: DispatchHandlers, signal?: AbortSignal): void {
    const set = [...new Set(recipients.map((address) => address.toLowerCase()))].slice(0, MAX_WORKER_RECIPIENTS);
    const tried = new Set<string>();
    const failures: string[] = [];
    let first = true;
    const next = (): void => {
      const worker = this.nextRecipient(set, service, tried, failures);
      if (!worker) {
        const error = new WorkerUnavailableError(set.join(', '), failures.join('; ') || 'no recipient can take it');
        if (first) throw error;
        handlers.onError(error);
        return;
      }
      first = false;
      tried.add(worker.address);
      let started = false;
      const dispatchId = this.send(worker, req, {
        onStart: (status, headers) => {
          started = true;
          handlers.onStart(status, headers);
        },
        onChunk: (data) => handlers.onChunk(data),
        onEnd: () => handlers.onEnd(),
        onError: (error) => {
          // Nothing reached the buyer yet: the next recipient can still answer.
          if (started || signal?.aborted) {
            handlers.onError(error);
            return;
          }
          failures.push(error.message);
          next();
        },
      }, signal, { ranked: true });
      if (dispatchId) handlers.onAttempt?.(worker.address, dispatchId);
    };
    next();
  }

  /** The best-ranked recipient not tried yet that can take a request now; why each other one can't is added to `failures`. */
  private nextRecipient(set: readonly string[], service: string, tried: ReadonlySet<string>, failures: string[]): ConnectedWorker | null {
    const now = Date.now();
    const candidates: ConnectedWorker[] = [];
    for (const address of set) {
      if (tried.has(address)) continue;
      const worker = this.workers.get(address);
      const reason = this.unavailableReason(worker, service, now);
      if (reason) {
        if (!failures.some((f) => f.startsWith(`Worker ${address} `))) failures.push(`Worker ${address} ${reason}`);
        continue;
      }
      candidates.push(worker!);
    }
    return this.byScore(candidates, false)[0] ?? null;
  }

  /** Why `worker` can't take a request for `service` now, in order of precedence; null when it can. */
  private unavailableReason(worker: ConnectedWorker | undefined, service: string, now: number): string | null {
    if (!worker) return 'not connected';
    if (!worker.verified.has(service) || !this.routable(worker)) return `not serving ${service}`;
    if (this.priority(worker.address) === 0) return 'the operator routes nothing to it';
    if (now < worker.rank.benchedUntil) return 'benched after failing to answer';
    if (worker.inflight.size >= worker.maxConcurrency) return 'at capacity';
    return null;
  }

  /**
   * Run a request of the pool's own (a health probe or join check) on a
   * worker for `service`: the pool seals it like a buyer would, without a
   * buyer binding, so workers cap it as a check.
   */
  async probe(service: string, body: Uint8Array, requestId: string, path = '/v1/chat/completions', worker = this.pickWorker(service)): Promise<PlainResponse> {
    if (!worker) throw new NoWorkerAvailableError(service);
    return this.sealedRoundTrip(worker, body, requestId, path, this.opts.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS);
  }

  private async sealedRoundTrip(worker: ConnectedWorker, body: Uint8Array, requestId: string, path: string, timeoutMs: number): Promise<PlainResponse> {
    const sealed = await sealRequest({ body, worker: worker.address, workerKey: worker.certificate.key });
    return new Promise((resolve, reject) => {
      let status = 0;
      let headers: Record<string, string> = {};
      const chunks: Uint8Array[] = [];
      this.send(worker, {
        requestId,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
        body: sealed.body,
      }, {
        onStart: (code, responseHeaders) => { status = code; headers = responseHeaders; },
        onChunk: (data) => { chunks.push(data); },
        onEnd: () => {
          try {
            const raw = Buffer.concat(chunks);
            const streamed = (headers['content-type'] ?? '').includes('text/event-stream');
            const plain = streamed ? sealed.opener.pushStream(raw) : sealed.opener.openBody(raw);
            resolve({ status, headers, body: plain });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        onError: reject,
      }, undefined, { firstByteTimeoutMs: timeoutMs, maxBytes: MAX_CHECK_RESPONSE_BYTES });
    });
  }

  /** Fold one finished request's decode speed into the worker's average. */
  recordThroughput(address: string, outputTokens: number, streamMs: number): void {
    const worker = this.workers.get(address.toLowerCase());
    if (!worker || outputTokens <= 0 || streamMs <= 0) return;
    // Kept in the rank (and the ledger), so it survives reconnects and the dashboard ranks by it too.
    recordSpeed(worker.rank, outputTokens / (streamMs / 1000));
    this.opts.ledger.saveRank(worker.address, worker.rank, this.priority(worker.address));
  }

  /** Timing of a finished dispatch, read once by the provider when the request is charged. */
  takeTiming(address: string, dispatchId: string): RequestTiming | null {
    const worker = this.workers.get(address.toLowerCase());
    const timing = worker?.finished.get(dispatchId) ?? null;
    worker?.finished.delete(dispatchId);
    return timing;
  }

  private priority(address: string): number {
    return this.opts.workerPriority?.get(address) ?? 1;
  }

  /**
   * The best-ranked worker for `service` that is free, not benched, and not
   * excluded by the operator (ranking.ts); for assignments, recent
   * assignments count as load too, so new buyers spread out.
   */
  private pickWorker(service: string, forAssignment = false): ConnectedWorker | null {
    return this.rankedWorkers(service, forAssignment)[0] ?? null;
  }

  /** Every worker that could take a request for `service` now, best-ranked first. */
  private rankedWorkers(service: string, forAssignment: boolean): ConnectedWorker[] {
    const now = Date.now();
    const candidates: ConnectedWorker[] = [];
    for (const worker of this.workers.values()) {
      if (this.unavailableReason(worker, service, now) !== null) continue;
      worker.assignedAt = worker.assignedAt.filter((at) => now - at < ASSIGNMENT_WEIGHT_MS);
      candidates.push(worker);
    }
    return this.byScore(candidates, forAssignment);
  }

  /** `workers` ordered by rank score (ranking.ts), highest first; ties keep their order. */
  private byScore(workers: ConnectedWorker[], forAssignment: boolean): ConnectedWorker[] {
    const scores = rankScores(workers.map((worker) => ({
      reliability: worker.rank.reliability,
      tokensPerSecond: worker.rank.tokensPerSecond,
      priority: this.priority(worker.address),
      load: (worker.inflight.size + (forAssignment ? worker.assignedAt.length : 0)) / worker.maxConcurrency,
    })));
    return workers.map((worker, i) => ({ worker, score: scores[i]!, i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ worker }) => worker);
  }

  /** Fold a buyer dispatch's outcome into the worker's rank, and record it for the dashboard. */
  private recordDispatch(worker: ConnectedWorker, entry: InFlight, ok: boolean, failure?: { reason: string; bench: boolean }): void {
    if (!entry.ranked) return;
    const at = Date.now();
    const firstByteMs = entry.firstByteAt !== null ? entry.firstByteAt - entry.startedAt : undefined;
    const wasBenched = at < worker.rank.benchedUntil;
    recordOutcome(worker.rank, { ok, at, ...(failure?.bench ? { bench: true } : {}), ...(firstByteMs !== undefined ? { firstByteMs } : {}) });
    this.opts.ledger.recordDispatch({ worker: worker.address, ok, at, ...(failure ? { reason: failure.reason } : {}), ...(firstByteMs !== undefined ? { firstByteMs } : {}) });
    this.opts.ledger.saveRank(worker.address, worker.rank, this.priority(worker.address), at);
    if (!wasBenched && at < worker.rank.benchedUntil) {
      this.log(`worker ${worker.address} failed a request (${failure?.reason}); benched for ${Math.round((worker.rank.benchedUntil - at) / 1000)}s`);
    }
  }

  /** Returns the dispatch ID (empty when `signal` had already aborted). */
  private send(
    worker: ConnectedWorker,
    req: DispatchRequest,
    handlers: DispatchHandlers,
    signal?: AbortSignal,
    opts: { firstByteTimeoutMs?: number; maxBytes?: number; ranked?: boolean } = {},
  ): string {
    if (signal?.aborted) {
      handlers.onError(new Error('Request aborted'));
      return '';
    }
    const table = worker.inflight;
    const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? this.opts.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    const acceptTimeoutMs = Math.min(firstByteTimeoutMs, this.opts.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS);
    const idleTimeoutMs = this.opts.responseIdleTimeoutMs ?? DEFAULT_RESPONSE_IDLE_TIMEOUT_MS;
    // Each buyer connection names its own request IDs, so two can collide on one worker.
    const dispatchId = randomUUID();
    const cancel = (error: Error, failure?: { reason: string; bench: boolean }): void => {
      if (table.get(dispatchId) !== entry) return;
      this.sendFrame(worker.ws, { t: 'cancel', id: dispatchId });
      this.finish(table, dispatchId);
      if (failure) this.recordDispatch(worker, entry, false, failure);
      handlers.onError(error);
    };
    const onAbort = (): void => cancel(new Error('Request aborted'));
    const arm = (ms: number, message: string, failure: { reason: string; bench: boolean }): void => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => cancel(new Error(message), failure), ms);
    };
    const noAnswer = { reason: 'timeout', bench: true };
    const entry: InFlight = {
      handlers,
      started: false,
      accepted: false,
      ranked: opts.ranked ?? false,
      timer: null,
      accept: () => {
        entry.accepted = true;
        arm(firstByteTimeoutMs, `Worker ${worker.address} did not answer within ${firstByteTimeoutMs}ms`, noAnswer);
      },
      touch: () => arm(idleTimeoutMs, `Worker ${worker.address} sent nothing for ${idleTimeoutMs}ms`, { reason: 'idle', bench: false }),
      bytes: 0,
      maxBytes: opts.maxBytes ?? MAX_RESPONSE_BYTES,
      release: () => signal?.removeEventListener('abort', onAbort),
      startedAt: Date.now(),
      firstByteAt: null,
      streamed: false,
      requestId: req.requestId,
    };
    // The worker must pick the request up quickly, then start answering in time.
    arm(acceptTimeoutMs, `Worker ${worker.address} did not take the request within ${acceptTimeoutMs}ms`, noAnswer);
    table.set(dispatchId, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.sendFrame(worker.ws, {
      t: 'request',
      id: dispatchId,
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: encodeBody(req.body),
    });
    return dispatchId;
  }

  private finish(table: Map<string, InFlight>, dispatchId: string): void {
    const entry = table.get(dispatchId);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.release();
    table.delete(dispatchId);
  }

  private accept(ws: WebSocket): void {
    const nonce = randomBytes(32).toString('hex');
    const helloTimer = setTimeout(() => {
      this.log('a connection sent no valid hello in time; closing it');
      ws.close(4001, 'no hello');
    }, HELLO_TIMEOUT_MS);
    this.sendFrame(ws, { t: 'challenge', version: COLONY_POOL_PROTOCOL_VERSION, pool: this.opts.poolId, nonce, seller: this.opts.seller });
    let worker: ConnectedWorker | null = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parseWorkerFrame(data.toString());
      if (!frame) {
        this.log(`ignored a malformed frame from ${worker?.address ?? 'an unauthenticated connection'}`);
        return;
      }
      if (!worker) {
        if (frame.t !== 'hello') return;
        clearTimeout(helloTimer);
        worker = this.authenticate(ws, nonce, frame);
        return;
      }
      this.handleFrame(worker, frame);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (worker) this.drop(worker);
    });
    ws.on('error', () => ws.terminate());
  }

  private authenticate(ws: WebSocket, nonce: string, hello: Extract<WorkerFrame, { t: 'hello' }>): ConnectedWorker | null {
    let address: string;
    try {
      address = verifyMessage(workerAuthMessage(this.opts.poolId, nonce), hello.signature).toLowerCase();
    } catch {
      address = '';
    }
    if (!address || address !== hello.address.toLowerCase()) {
      this.reject(ws, 'signature does not match address');
      return null;
    }
    if (this.opts.allowedWorkers && !this.opts.allowedWorkers.has(address)) {
      this.reject(ws, 'worker is not on this pool\'s allow-list');
      return null;
    }
    const certificate: WorkerKeyCertificate = {
      worker: address,
      key: hello.encryption.key.toLowerCase(),
      expires: hello.encryption.expires,
      certificate: hello.encryption.certificate,
      pool: this.opts.seller,
      ...(hello.encryption.attestationKey ? { attestationKey: hello.encryption.attestationKey.toLowerCase() } : {}),
    };
    if (!verifyWorkerKeyCertificate(certificate, this.opts.seller, Math.floor(Date.now() / 1000) + MIN_CERTIFICATE_LIFETIME_S)) {
      this.reject(ws, 'encryption key certificate is invalid, expired, or for another seller');
      return null;
    }
    let hardened = false;
    if (hello.attestation) {
      const check = verifyWorkerAttestation(hello.attestation, certificate, this.attestationPolicy(nonce));
      if (!check.valid) {
        this.reject(ws, `attestation rejected: ${check.reason}`);
        return null;
      }
      hardened = check.hardened;
    }
    if (this.opts.requireAttestation && !hardened) {
      this.reject(ws, 'this pool only admits attested hardened Macs (signed app, SIP on, app-bound key)');
      return null;
    }
    // One connection per worker: a reconnect replaces the stale socket.
    this.workers.get(address)?.ws.close(4002, 'replaced by a new connection');
    // Its rank survives reconnects (and, through the ledger, pool restarts), so a flaky Mac can't reset it.
    let rank = this.ranks.get(address);
    if (!rank) {
      rank = this.opts.ledger.loadRank(address) ?? newRank();
      this.ranks.set(address, rank);
    }
    this.opts.ledger.saveRank(address, rank, this.priority(address));

    const worker: ConnectedWorker = {
      address,
      agent: hello.agent ?? 'unknown',
      ws,
      certificate,
      attestation: hello.attestation ?? null,
      hardened,
      attestTimer: null,
      attestNonce: null,
      deviceAttestation: null,
      deviceValidUntil: 0,
      deviceTimer: null,
      deviceGeneration: 0,
      renewTimer: null,
      connectionId: this.opts.ledger.recordConnect(address, hello.agent),
      maxConcurrency: Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, Math.floor(hello.maxConcurrency))),
      offered: new Set(),
      verified: new Set(),
      inflight: new Map(),
      finished: new Map(),
      checks: Promise.resolve(),
      assignedAt: [],
      missedPings: 0,
      rank,
    };
    ws.on('pong', () => { worker.missedPings = 0; });
    this.workers.set(address, worker);
    const { accepted, rejected } = this.setOffered(worker, hello.services);
    this.sendFrame(ws, { t: 'welcome', workerId: address, accepted, rejected, workerShareBps: this.opts.workerShareBps });
    this.log(`worker ${address} joined (${worker.agent}${hardened ? ', attested' : ''}) offering ${accepted.join(', ') || 'nothing'}`);
    if (worker.attestation) this.scheduleAttestation(worker);
    if (this.opts.deviceAttestor) void this.attestDevice(worker);
    const renewInMs = (certificate.expires - CERTIFICATE_RENEW_MARGIN_S) * 1000 - Date.now();
    worker.renewTimer = setTimeout(() => {
      this.log(`worker ${address}'s key certificate expires soon; reconnecting it to renew`);
      ws.close(4006, 'renew key certificate');
    }, Math.max(MIN_CERTIFICATE_LIFETIME_S * 500, renewInMs));
    worker.renewTimer.unref();
    return worker;
  }

  /** With `requireDeviceAttestation`, only Macs Apple attests get buyers. */
  private routable(worker: ConnectedWorker): boolean {
    if (worker.certificate.expires <= Math.floor(Date.now() / 1000) + 300) return false;
    return !this.opts.requireDeviceAttestation || this.appleVerified(worker);
  }

  private appleVerified(worker: ConnectedWorker): boolean {
    return worker.deviceAttestation !== null && worker.deviceValidUntil > Math.floor(Date.now() / 1000);
  }

  /**
   * Ask the operator's MDM for Apple's attestation of the Mac this worker
   * says it runs on, bound to the worker and its attestation key. Apple
   * issues a new one at most every 7 days and returns the cached one in
   * between, so the challenge is derived (deviceAttestationChallenge) and the
   * pool asks again once the attestation is 7 days old, then daily until
   * Apple issues the next. A pool that requires it disconnects workers that fail.
   */
  private async attestDevice(worker: ConnectedWorker): Promise<void> {
    const generation = ++worker.deviceGeneration;
    // A newer lookup (the worker named another Mac) or a dropped connection makes this one's result moot.
    const current = (): boolean => this.workers.get(worker.address) === worker && worker.deviceGeneration === generation;
    const attestation = worker.attestation;
    const attestationKey = worker.certificate.attestationKey;
    const retryMs = this.opts.deviceAttestationIntervalMs ?? DEVICE_ATTESTATION_INTERVAL_MS;
    let reason: string | undefined;
    let nextMs = retryMs;
    if (!attestation?.udid || !attestation.serial || !attestationKey) {
      reason = 'it reports no Mac to attest';
    } else {
      const challenge = deviceAttestationChallenge(worker.address, attestationKey, attestation.udid);
      try {
        const chain = await this.opts.deviceAttestor!.attest(attestation.udid, deviceAttestationNonce(worker.address, attestationKey, challenge));
        const check = verifyDeviceAttestation({ chain, challenge }, {
          worker: worker.address, attestationKey, serialNumber: attestation.serial, maxAgeS: DEVICE_ATTESTATION_MAX_AGE_S,
          ...(this.opts.deviceAttestationRoots ? { roots: this.opts.deviceAttestationRoots } : {}),
        });
        if (check.valid && check.report && check.validUntil !== undefined) {
          if (!current()) return;
          worker.deviceAttestation = { chain, challenge };
          worker.deviceValidUntil = check.validUntil;
          const nowS = Math.floor(Date.now() / 1000);
          // Ask again once Apple can issue a new one (daily while it still returns this one), and by the time this one lapses.
          const reissueS = check.report.issued + APPLE_ATTESTATION_REISSUE_S;
          const nextS = Math.min(reissueS > nowS ? reissueS : nowS + Math.ceil(retryMs / 1000), check.validUntil);
          nextMs = Math.max(1000, (nextS - nowS) * 1000);
          this.log(`Apple attests worker ${worker.address}'s Mac ${attestation.serial} (SIP on, ${check.report.osVersion ?? 'macOS'}, issued ${new Date(check.report.issued * 1000).toISOString()})`);
          this.emitChangeIfNeeded();
        } else {
          reason = check.reason;
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    if (!current()) return;
    if (reason) {
      worker.deviceAttestation = null;
      worker.deviceValidUntil = 0;
      this.log(`no Apple attestation for worker ${worker.address}: ${reason}`);
      this.emitChangeIfNeeded();
      if (this.opts.requireDeviceAttestation) {
        worker.ws.close(4005, 'this pool only admits Macs Apple attests through its MDM');
        return;
      }
    }
    worker.deviceTimer = setTimeout(() => void this.attestDevice(worker), nextMs);
    worker.deviceTimer.unref();
  }

  private attestationPolicy(nonce: string) {
    return { nonce, maxAgeS: ATTESTATION_MAX_AGE_S, ...(this.opts.attestedTeams ? { teams: this.opts.attestedTeams } : {}) };
  }

  /** Re-challenge an attested worker; one that stops attesting, or stops reporting hardened, is dropped. */
  private scheduleAttestation(worker: ConnectedWorker): void {
    worker.attestTimer = setTimeout(() => {
      const nonce = randomBytes(32).toString('hex');
      worker.attestNonce = nonce;
      this.sendFrame(worker.ws, { t: 'attest', nonce });
      worker.attestTimer = setTimeout(() => {
        this.log(`worker ${worker.address} did not re-attest in time; disconnecting it`);
        worker.ws.close(4004, 'attestation timed out');
      }, ATTESTATION_REPLY_MS);
      worker.attestTimer.unref();
    }, this.opts.attestationIntervalMs ?? ATTESTATION_INTERVAL_MS);
    worker.attestTimer.unref();
  }

  private reattested(worker: ConnectedWorker, attestation: WorkerAttestation): void {
    if (!worker.attestNonce || this.workers.get(worker.address) !== worker) return;
    const check = verifyWorkerAttestation(attestation, worker.certificate, this.attestationPolicy(worker.attestNonce));
    if (!check.valid || (worker.hardened && !check.hardened)) {
      this.log(`worker ${worker.address} failed re-attestation (${check.reason ?? 'no longer hardened'}); disconnecting it`);
      worker.ws.close(4004, 'attestation failed');
      return;
    }
    if (worker.attestTimer) clearTimeout(worker.attestTimer);
    const deviceChanged = attestation.serial !== worker.attestation?.serial || attestation.udid !== worker.attestation?.udid;
    worker.attestNonce = null;
    worker.attestation = attestation;
    this.scheduleAttestation(worker);
    // A worker that now names a different Mac loses Apple's word for the old one until its MDM attests the new one.
    if (deviceChanged && this.opts.deviceAttestor) {
      if (worker.deviceTimer) clearTimeout(worker.deviceTimer);
      worker.deviceAttestation = null;
      worker.deviceValidUntil = 0;
      this.emitChangeIfNeeded();
      void this.attestDevice(worker);
    }
  }

  private reject(ws: WebSocket, message: string): void {
    this.log(`rejected a worker: ${message}`);
    this.sendFrame(ws, { t: 'error', message });
    ws.close(4003, message);
  }

  private setOffered(worker: ConnectedWorker, services: string[]): { accepted: string[]; rejected: string[] } {
    const accepted = [...new Set(services)].filter((service) => this.catalog.has(service));
    const rejected = [...new Set(services)].filter((service) => !this.catalog.has(service));
    worker.offered = new Set(accepted);
    for (const service of [...worker.verified]) {
      if (!worker.offered.has(service)) worker.verified.delete(service);
    }
    for (const service of accepted) {
      if (worker.verified.has(service)) continue;
      if (this.opts.verifyOnJoin) worker.checks = worker.checks.then(() => this.verify(worker, service));
      else worker.verified.add(service);
    }
    this.emitChangeIfNeeded();
    return { accepted, rejected };
  }

  /** A short completion the worker must answer correctly before buyers reach it. */
  private async verify(worker: ConnectedWorker, service: string): Promise<void> {
    // Wait for a free slot, so the check never pushes the worker past its capacity.
    const deadline = Date.now() + CANARY_TIMEOUT_MS;
    while (worker.inflight.size >= worker.maxConcurrency) {
      if (this.workers.get(worker.address) !== worker || !worker.offered.has(service)) return;
      if (Date.now() >= deadline) {
        this.log(`worker ${worker.address} stayed busy; skipping the check for ${service} until it offers it again`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, CHECK_SLOT_POLL_MS));
    }
    if (this.workers.get(worker.address) !== worker || !worker.offered.has(service) || worker.verified.has(service)) return;
    const body = new TextEncoder().encode(JSON.stringify({
      model: service,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 16,
      stream: false,
    }));
    const passed = await this.sealedRoundTrip(worker, body, `canary-${randomUUID()}`, '/v1/chat/completions', CANARY_TIMEOUT_MS)
      .then((response) => response.status === 200 && isChatCompletion(Buffer.from(response.body)))
      .catch(() => false);
    if (this.workers.get(worker.address) !== worker || !worker.offered.has(service)) return;
    if (passed) {
      worker.verified.add(service);
      this.emitChangeIfNeeded();
    } else {
      this.log(`worker ${worker.address} failed the check for ${service}; not routing it`);
    }
  }

  private handleFrame(worker: ConnectedWorker, frame: WorkerFrame): void {
    switch (frame.t) {
      case 'services':
        this.setOffered(worker, frame.services);
        return;
      case 'stats-request':
        this.sendFrame(worker.ws, { t: 'stats', id: frame.id, stats: this.opts.ledger.stats(worker.address) });
        return;
      case 'accepted': {
        const entry = worker.inflight.get(frame.id);
        if (entry && !entry.accepted && !entry.started) entry.accept();
        return;
      }
      case 'response-start': {
        const entry = worker.inflight.get(frame.id);
        if (!entry || entry.started) return;
        entry.started = true;
        entry.accepted = true;
        entry.firstByteAt = Date.now();
        entry.streamed = Object.entries(frame.headers ?? {})
          .some(([name, value]) => name.toLowerCase() === 'content-type' && String(value).includes('text/event-stream'));
        entry.touch();
        entry.handlers.onStart(frame.status, frame.headers);
        return;
      }
      case 'response-chunk': {
        const entry = worker.inflight.get(frame.id);
        if (!entry?.started) return;
        const data = decodeBody(frame.data);
        entry.bytes += data.length;
        if (entry.bytes > entry.maxBytes) {
          this.sendFrame(worker.ws, { t: 'cancel', id: frame.id });
          this.finish(worker.inflight, frame.id);
          this.recordDispatch(worker, entry, false, { reason: 'oversize', bench: false });
          entry.handlers.onError(new Error(`Worker ${worker.address} sent more than ${entry.maxBytes} bytes`));
          return;
        }
        entry.touch();
        entry.handlers.onChunk(data);
        return;
      }
      case 'response-end': {
        const entry = worker.inflight.get(frame.id);
        if (!entry?.started) return;
        this.finish(worker.inflight, frame.id);
        this.recordDispatch(worker, entry, true);
        // Paid requests are charged right after they end; free ones never read this.
        const timing = { startedAt: entry.startedAt, firstByteAt: entry.firstByteAt, endedAt: Date.now(), streamed: entry.streamed };
        worker.finished.set(frame.id, timing);
        setTimeout(() => { if (worker.finished.get(frame.id) === timing) worker.finished.delete(frame.id); }, 60_000).unref();
        entry.handlers.onEnd();
        return;
      }
      case 'response-error': {
        const entry = worker.inflight.get(frame.id);
        if (!entry) return;
        this.finish(worker.inflight, frame.id);
        // Workers refuse a request (its channel, its binding, their capacity) before
        // `accepted`, and fail one they took (the model threw or timed out) after it.
        // Only the second is the worker's fault: a refusal the buyer caused never
        // counts against it, or anyone could sink a Mac's rank with bad requests.
        if (entry.accepted) this.recordDispatch(worker, entry, false, { reason: 'worker-error', bench: !entry.started });
        entry.handlers.onError(new Error(`Worker ${worker.address}: ${frame.message}`));
        return;
      }
      case 'attestation':
        this.reattested(worker, frame.attestation);
        return;
      case 'hello':
        return;
    }
  }

  private drop(worker: ConnectedWorker): void {
    if (worker.attestTimer) clearTimeout(worker.attestTimer);
    if (worker.deviceTimer) clearTimeout(worker.deviceTimer);
    if (worker.renewTimer) clearTimeout(worker.renewTimer);
    if (this.workers.get(worker.address) === worker) this.workers.delete(worker.address);
    this.opts.ledger.recordDisconnect(worker.connectionId);
    for (const [dispatchId, entry] of [...worker.inflight]) {
      this.finish(worker.inflight, dispatchId);
      // Dropping a request before answering it benches the worker; mid-response it only counts against it.
      this.recordDispatch(worker, entry, false, { reason: 'disconnect', bench: !entry.started });
      entry.handlers.onError(new Error(`Worker ${worker.address} disconnected`));
    }
    this.log(`worker ${worker.address} left`);
    this.emitChangeIfNeeded();
  }

  private emitChangeIfNeeded(): void {
    const services = this.availableServices().join('\n');
    if (services === this.lastServices) return;
    this.lastServices = services;
    for (const listener of this.changeListeners) listener();
  }

  private sendFrame(ws: WebSocket, frame: PoolFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  private log(line: string): void {
    this.opts.log?.(`[colony-pool] ${line}`);
  }
}

function isChatCompletion(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString()) as { choices?: unknown };
    return Array.isArray(parsed.choices) && parsed.choices.length > 0;
  } catch {
    return false;
  }
}
