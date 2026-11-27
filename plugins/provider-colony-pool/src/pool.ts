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
  type AttestedModel,
  type WorkerAssignment,
  type WorkerAttestation,
  type WorkerKeyCertificate,
  WORKER_CERTIFICATE_USABILITY_MARGIN_S,
} from '@antseed/node/worker-e2e';
import type { SerializedHttpRequest } from '@antseed/node';
import type { WorkerLedger } from './ledger.js';
import type { DeviceAttestor } from './mdm.js';
import { splitModelPin } from './model-pins.js';
import { newRank, rankScores, recordOutcome, recordSpeed, type WorkerRank } from './ranking.js';
import {
  COLONY_POOL_PROTOCOL_VERSION,
  decodeBody,
  encodeBody,
  parseWorkerFrame,
  workerAuthMessage,
  type PoolFrame,
  type ServicePrice,
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
/**
 * Before a renewal reconnect the worker gets no new requests and finishes the
 * ones it has, for at most this long (a long streamed answer takes minutes)
 * and never past its certificate's expiry less RENEW_DRAIN_SAFETY_MS.
 */
const RENEW_DRAIN_MAX_MS = 10 * 60_000;
const RENEW_DRAIN_SAFETY_MS = 60_000;
/** After a renewal close, requests sealed for the worker wait this long for it to reconnect (it does so at once). */
const RENEW_RECONNECT_GRACE_MS = 30_000;
/** How long a request whose workers are all busy waits for a free slot, and how many may wait at once. */
const DEFAULT_BUSY_WAIT_MS = 15_000;
const DEFAULT_MAX_WAITING = 64;
/** Shorter answers say little about decode speed: a few tokens that arrive in one burst read as instant. */
const MIN_SPEED_TOKENS = 32;
const MIN_SPEED_STREAM_MS = 100;
const AT_CAPACITY = 'at capacity';
/** A worker finishing its requests before it reconnects to renew its certificate: back in seconds, with the same key. */
const RENEWING = 'reconnecting to renew its key certificate';
/** Assignments count toward a worker's load for this long, so new buyers spread out. */
const ASSIGNMENT_WEIGHT_MS = 10 * 60_000;
/** Attested workers re-attest this often, and have this long to answer. */
const ATTESTATION_INTERVAL_MS = 5 * 60_000;
const ATTESTATION_REPLY_MS = 30_000;
/** An attestation answering a challenge must be this fresh: the nonce already proves it is new, so this only bounds clock skew. */
const ATTESTATION_MAX_AGE_S = 300;
/** How often the pool asks again while Apple still returns an attestation older than its reissue interval. */
const DEVICE_ATTESTATION_INTERVAL_MS = 24 * 60 * 60_000;

export interface ColonyPoolOptions {
  poolId: string;
  /** Address buyers pay (the AntseedColonyPool contract, or the seller node's address). */
  seller: string;
  /** Services this pool sells. Workers' other services are ignored. */
  catalog: string[];
  /**
   * What buyers pay for each catalog service; workers are told, to check they
   * are paid at it. A worker serves buyers only services with a price.
   */
  prices?: Record<string, ServicePrice>;
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
  /** How long a request whose workers are all busy waits for a free slot (default 15 s). */
  busyWaitMs?: number;
  /** How many requests may wait for a free slot at once (default 64). */
  maxWaiting?: number;
  /** Operator weights by worker address (COLONY_POOL_WORKER_PRIORITY); 1 by default, 0 never routes. */
  workerPriority?: Map<string, number>;
  /** How long a started response may go without a chunk before it is cancelled. */
  responseIdleTimeoutMs?: number;
  /** How often workers are pinged; one that misses two pings in a row is disconnected (default 15 s). */
  heartbeatIntervalMs?: number;
  /**
   * If set, only apps signed by these Apple Developer teams are labelled hardened. The label is the
   * worker's own report, signed with a key it chose, so it is shown, never enforced: only Apple's
   * attestation through the operator's MDM (`requireDeviceAttestation`) gates routing.
   */
  attestedTeams?: Set<string>;
  attestationIntervalMs?: number;
  /** The operator's MDM, for Apple-signed attestations of enrolled Macs (optional). */
  deviceAttestor?: DeviceAttestor;
  /**
   * Enrolled Mac (UDID, upper case) → the worker address the operator bound it
   * to when enrolling it. Apple's attestation names the Mac, not the worker
   * process, so the pool asks about a Mac only for the worker it is bound to:
   * a worker naming a Mac bound to no one, or to another worker, gets none.
   */
  deviceBindings?: Map<string, string>;
  /** Only route to Macs Apple attests through the operator's MDM (SIP on, serial matches). */
  requireDeviceAttestation?: boolean;
  /**
   * Service → the model workers must report for it (`repo@revision`); services not listed take any.
   * A pin with `#<sha256>` also routes the service only from workers whose latest valid attestation
   * names that checkpoint with that digest of its files (self-reported, like the attestation).
   */
  models?: Map<string, string>;
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

/** What a worker attests for a service, as one string: its log line changes only when this does. */
function attestedModelKey({ model, sha256, engine, witness }: AttestedModel): string {
  return [model, sha256, engine, witness?.path, witness?.engine, witness?.binary, witness?.text].join('#');
}

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

/** The request's workers are busy and another is free: handed back unsent, for the buyer to encrypt for another. */
export class WorkerReassignError extends Error {
  constructor(workers: string) {
    super(`Worker ${workers} is busy and another worker is free; encrypt the request for another`);
    this.name = 'WorkerReassignError';
  }
}

/** The request would not fit in one pool-to-worker frame, so no worker could receive it. */
export class RequestTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`Request is ${bytes} bytes once framed for the worker; a worker takes at most ${limit}`);
    this.name = 'RequestTooLargeError';
  }
}

/** Bytes of the `request` frame that carries `req` (the body goes base64, so 4/3 of its size). */
export function requestFrameBytes(req: DispatchRequest): number {
  const envelope = JSON.stringify({ t: 'request', id: '00000000-0000-0000-0000-000000000000', method: req.method, path: req.path, headers: req.headers, body: '' });
  return Buffer.byteLength(envelope) + Math.ceil(req.body.byteLength / 3) * 4;
}

export class WorkerBusyError extends Error {
  constructor(workers: string) {
    super(`Worker ${workers} is busy; retry shortly`);
    this.name = 'WorkerBusyError';
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
  /** The HTTP status the worker answered with, once it started. */
  status: number | null;
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
  /** Latest attestation that verified, and whether it reports a hardened Mac (a label, not a gate). */
  attestation: WorkerAttestation | null;
  hardened: boolean;
  /** Service → the model (`repo@revision`) the worker says it runs for it. */
  models: Record<string, string>;
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
  /**
   * Starts the renewal before the key certificate expires (the worker drains,
   * then reconnects and certifies again), then bounds how long it drains.
   */
  renewTimer: NodeJS.Timeout | null;
  /** Renewing: no new requests; the pool closes the connection once its requests finish. */
  renewing: boolean;
  /** The pool closed the connection to renew (not the worker leaving): what it still had is not its failure. */
  closedToRenew: boolean;
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
  /** The worker's latest attestation reports a hardened Mac (self-reported; shown, not enforced). */
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
  private opts: ColonyPoolOptions;
  private readonly catalog: Set<string>;
  private readonly workers = new Map<string, ConnectedWorker>();
  /** Every worker's rank, kept across reconnects (and in the ledger across restarts). */
  private readonly ranks = new Map<string, WorkerRank>();
  private readonly changeListeners: Array<() => void> = [];
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  /** Requests waiting for a worker's slot, in the order they came. */
  private readonly waiting = new Set<{ retry: () => void; stop: () => void }>();
  /** Workers the pool closed to renew their certificate → until when (ms) requests wait for them to reconnect. */
  private readonly reconnecting = new Map<string, number>();
  private waking = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastServices = '';
  /** Recent counts of workers with a valid attestation, for noteAttested. */
  private attestedCounts: Array<{ at: number; count: number }> = [];
  private attestedDropWarnedAt = 0;

  /** The share workers are told when they join, when it changes on-chain (see share.ts). */
  setWorkerShareBps(bps: number): void {
    this.opts = { ...this.opts, workerShareBps: bps };
  }

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
    for (const waiter of [...this.waiting]) waiter.stop();
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
      for (const service of worker.verified) if (!this.unattestedModel(worker, service)) services.add(service);
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
    const workers = this.assignable(service).slice(0, Math.max(1, Math.min(MAX_WORKER_RECIPIENTS, Math.floor(count))));
    if (workers.length === 0) throw new NoWorkerAvailableError(service);
    // The pool sends each of the buyer's requests to whichever of them has a free slot,
    // so each may take the buyer's load: the next buyer is assigned other workers first.
    const now = Date.now();
    for (const worker of workers) worker.assignedAt.push(now);
    return workers.map((worker) => ({
      ...worker.certificate,
      ...(worker.attestation ? { attestation: worker.attestation } : {}),
      ...(worker.deviceAttestation && this.appleVerified(worker) ? { deviceAttestation: worker.deviceAttestation } : {}),
    }));
  }

  /**
   * Send a buyer's sealed request to one of the workers it is encrypted for:
   * the best-ranked that has a free slot now, whichever its place in the set
   * (rank counts load). A worker that fails before the response starts (it
   * never picks the request up, refuses it, disconnects, or is benched) is
   * replaced by the next recipient: never a worker outside the set, and never
   * two at once. The response arrives through `handlers`; `onAttempt` names
   * each worker tried and its dispatch ID (unique even when buyers reuse
   * request IDs). Throws WorkerUnavailableError when no recipient can take
   * it, or reports it through `onError` once every one has failed, so the
   * buyer reassigns. While recipients are only busy (or reconnecting to renew
   * their certificate), the request waits for a slot, first come first served,
   * up to `busyWaitMs` (then WorkerBusyError). With `reassign` (the buyer can
   * encrypt it for another worker), a request no worker has received yet is
   * handed back instead of waiting whenever another worker has a free slot
   * (WorkerReassignError): it is never sent to a second worker, so a request
   * readable by one Mac stays read by one. Throws RequestTooLargeError,
   * before any worker sees it, for a request over the worker's frame limit.
   */
  dispatch(recipients: readonly string[], service: string, req: DispatchRequest, handlers: DispatchHandlers, signal?: AbortSignal, options: { reassign?: boolean } = {}): void {
    const bytes = requestFrameBytes(req);
    if (bytes > MAX_FRAME_BYTES) throw new RequestTooLargeError(bytes, MAX_FRAME_BYTES);
    const set = [...new Set(recipients.map((address) => address.toLowerCase()))].slice(0, MAX_WORKER_RECIPIENTS);
    const tried = new Set<string>();
    const failures: string[] = [];
    let first = true;
    let waitUntil = 0;
    const next = (): void => {
      const worker = this.nextRecipient(set, service, tried, failures);
      if (!worker && this.anyBusy(set, service, tried)) {
        if (options.reassign && tried.size === 0 && this.freeElsewhere(set, service)) {
          const error = new WorkerReassignError(set.join(', '));
          if (first) throw error;
          handlers.onError(error);
          return;
        }
        first = false;
        waitUntil ||= Date.now() + (this.opts.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
        this.waitForSlot(waitUntil, next, () => handlers.onError(new WorkerBusyError(set.join(', '))), () => handlers.onError(new Error('Request aborted')), signal);
        return;
      }
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

  /** Whether a worker outside `set` could take a request for `service` now. */
  private freeElsewhere(set: readonly string[], service: string): boolean {
    const now = Date.now();
    for (const [address, worker] of this.workers) {
      if (!set.includes(address) && this.unavailableReason(worker, service, now) === null) return true;
    }
    return false;
  }

  /** Whether a recipient not tried yet is only busy: it serves `service`, with no free slot now (or is renewing). */
  private anyBusy(set: readonly string[], service: string, tried: ReadonlySet<string>): boolean {
    const now = Date.now();
    return set.some((address) => !tried.has(address) && onlyBusy(this.unavailableReason(this.workers.get(address), service, now, address)));
  }

  /** Call `retry` when a slot frees (or a worker changes), `busy` at `until` or when too many wait, `aborted` when the buyer leaves. */
  private waitForSlot(until: number, retry: () => void, busy: () => void, aborted: () => void, signal?: AbortSignal): void {
    if (signal?.aborted) return aborted();
    if (Date.now() >= until || this.waiting.size >= (this.opts.maxWaiting ?? DEFAULT_MAX_WAITING)) return busy();
    const waiter = { retry: () => end(retry), stop: () => end(busy) };
    const end = (then: () => void): void => {
      if (!this.waiting.delete(waiter)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      then();
    };
    const onAbort = (): void => end(aborted);
    const timer = setTimeout(() => end(busy), until - Date.now());
    signal?.addEventListener('abort', onAbort, { once: true });
    this.waiting.add(waiter);
  }

  /** Let the requests waiting for a slot try again, in the order they came; those still without one keep their place. */
  private wakeWaiting(): void {
    if (this.waiting.size === 0 || this.waking) return;
    this.waking = true;
    queueMicrotask(() => {
      this.waking = false;
      for (const waiter of [...this.waiting]) waiter.retry();
    });
  }

  /** The best-ranked recipient not tried yet that can take a request now; why each other one can't is added to `failures`. */
  private nextRecipient(set: readonly string[], service: string, tried: ReadonlySet<string>, failures: string[]): ConnectedWorker | null {
    const now = Date.now();
    const candidates: ConnectedWorker[] = [];
    for (const address of set) {
      if (tried.has(address)) continue;
      const worker = this.workers.get(address);
      const reason = this.unavailableReason(worker, service, now, address);
      if (reason) {
        if (!onlyBusy(reason) && !failures.some((f) => f.startsWith(`Worker ${address} `))) failures.push(`Worker ${address} ${reason}`);
        continue;
      }
      candidates.push(worker!);
    }
    return this.byScore(candidates, false)[0] ?? null;
  }

  /** Why `worker` can't take a request for `service` now, in order of precedence; null when it can. */
  private unavailableReason(worker: ConnectedWorker | undefined, service: string, now: number, address = worker?.address): string | null {
    if (!worker) {
      const until = address ? this.reconnecting.get(address) : undefined;
      if (until !== undefined && now < until) return RENEWING;
      return 'not connected';
    }
    if (!worker.verified.has(service) || !this.routable(worker)) return `not serving ${service}`;
    const unattested = this.unattestedModel(worker, service);
    if (unattested) return unattested;
    if (this.priority(worker.address) === 0) return 'the operator routes nothing to it';
    if (now < worker.rank.benchedUntil) return 'benched after failing to answer';
    if (worker.renewing) return RENEWING;
    if (worker.inflight.size >= worker.maxConcurrency) return AT_CAPACITY;
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
    const req: DispatchRequest = { requestId, method: 'POST', path, headers: { 'content-type': 'application/json' }, body: sealed.body };
    const bytes = requestFrameBytes(req);
    if (bytes > MAX_FRAME_BYTES) throw new RequestTooLargeError(bytes, MAX_FRAME_BYTES);
    return new Promise((resolve, reject) => {
      let status = 0;
      let headers: Record<string, string> = {};
      const chunks: Uint8Array[] = [];
      this.send(worker, req, {
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
    if (!worker || outputTokens < MIN_SPEED_TOKENS || streamMs < MIN_SPEED_STREAM_MS) return;
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

  /** The workers a buyer may be assigned: those with a free slot, or, when all are busy, the busy ones (requests wait for a slot). */
  private assignable(service: string): ConnectedWorker[] {
    const free = this.rankedWorkers(service, true);
    return free.length > 0 ? free : this.rankedWorkers(service, true, true);
  }

  /** Every worker that could take a request for `service` now (or, with `busyToo`, once it has a slot), best-ranked first. */
  private rankedWorkers(service: string, forAssignment: boolean, busyToo = false): ConnectedWorker[] {
    const now = Date.now();
    const candidates: ConnectedWorker[] = [];
    for (const worker of this.workers.values()) {
      const reason = this.unavailableReason(worker, service, now);
      if (reason !== null && !(busyToo && reason === AT_CAPACITY)) continue;
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

  /**
   * Rank a completed answer by its status. A server error or a 429 is the
   * worker's failure (benched like any other; its headers already reached the
   * buyer, so it is not failed over). Any other 4xx is the buyer's request at
   * fault and never counts against the worker.
   */
  private recordAnswer(worker: ConnectedWorker, entry: InFlight): void {
    const status = entry.status ?? 200;
    if (status < 400) this.recordDispatch(worker, entry, true);
    else if (status >= 500 || status === 429) this.recordDispatch(worker, entry, false, { reason: `http-${status}`, bench: true });
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
      this.failDispatch(worker, dispatchId, entry, error, failure);
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
      status: null,
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

  /** End a failed dispatch: clear it, count it against the worker when `failure` says so, and tell the caller. */
  private failDispatch(worker: ConnectedWorker, dispatchId: string, entry: InFlight, error: Error, failure?: { reason: string; bench: boolean }): void {
    this.finish(worker, dispatchId);
    if (failure) this.recordDispatch(worker, entry, false, failure);
    entry.handlers.onError(error);
  }

  private finish(worker: ConnectedWorker, dispatchId: string): void {
    const entry = worker.inflight.get(dispatchId);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.release();
    worker.inflight.delete(dispatchId);
    // Still connected (drop() fails what a gone worker had, and must not take that for a renewal).
    if (worker.renewing && worker.inflight.size === 0 && this.workers.get(worker.address) === worker) this.closeToRenew(worker);
    this.wakeWaiting();
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
        if (frame.t === 'stats-hello') {
          clearTimeout(helloTimer);
          const address = this.signer(ws, nonce, frame);
          if (!address) return;
          this.sendFrame(ws, { t: 'stats', id: 'stats', stats: this.opts.ledger.stats(address) });
          ws.close(1000, 'stats sent');
          return;
        }
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

  /** The allowed worker address that signed the challenge, or null once the connection is rejected. */
  private signer(ws: WebSocket, nonce: string, hello: { address: string; signature: string }): string | null {
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
    return address;
  }

  private authenticate(ws: WebSocket, nonce: string, hello: Extract<WorkerFrame, { t: 'hello' }>): ConnectedWorker | null {
    const address = this.signer(ws, nonce, hello);
    if (!address) return null;
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
    let attestation: WorkerAttestation | null = null;
    if (hello.attestation) {
      const check = verifyWorkerAttestation(hello.attestation, certificate, this.attestationPolicy(nonce));
      if (check.valid) {
        attestation = hello.attestation;
        hardened = check.hardened;
      } else if (this.opts.requireDeviceAttestation) {
        // Apple's attestation is looked up for the Mac the worker's attestation names.
        this.reject(ws, `attestation rejected: ${check.reason}`);
        return null;
      } else {
        this.log(`worker ${address}'s attestation did not verify (${check.reason}); admitting it unattested`);
      }
    }
    this.reconnecting.delete(address);
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
      attestation,
      hardened,
      models: hello.models ?? {},
      attestTimer: null,
      attestNonce: null,
      deviceAttestation: null,
      deviceValidUntil: 0,
      deviceTimer: null,
      deviceGeneration: 0,
      renewTimer: null,
      renewing: false,
      closedToRenew: false,
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
    // Requests waiting for this worker (its previous connection was renewing) can go to it now.
    this.wakeWaiting();
    // Every catalog price, not only the services offered now: a worker that joined paused offers none, and resumes on this welcome.
    // And the model each pinned service runs, so a worker without one can let its owner pick.
    const models = this.opts.models?.size ? { models: Object.fromEntries(this.opts.models) } : {};
    this.sendFrame(ws, { t: 'welcome', workerId: address, accepted, rejected, workerShareBps: this.opts.workerShareBps, prices: this.opts.prices ?? {}, ...models });
    this.log(`worker ${address} joined (${worker.agent}${hardened ? ', reports a hardened Mac' : ''}) offering ${accepted.join(', ') || 'nothing'}`);
    this.noteAttestedModels(worker, null);
    this.noteAttested();
    if (hello.attestation) this.scheduleAttestation(worker);
    if (this.opts.deviceAttestor) void this.attestDevice(worker);
    const renewInMs = (certificate.expires - CERTIFICATE_RENEW_MARGIN_S) * 1000 - Date.now();
    worker.renewTimer = setTimeout(() => this.renew(worker), Math.max(MIN_CERTIFICATE_LIFETIME_S * 500, renewInMs));
    worker.renewTimer.unref();
    return worker;
  }

  /**
   * Renew a worker's key certificate without cutting its requests: it takes
   * no new ones (they go to the buyer's other recipients, or wait for it to
   * come back), and once those it has finish, or after RENEW_DRAIN_MAX_MS,
   * the pool closes the connection with 4006 and the worker reconnects at
   * once with a fresh certificate for the same key. The close is the pool's
   * doing, so it never counts against the worker (see drop()).
   */
  private renew(worker: ConnectedWorker): void {
    if (this.workers.get(worker.address) !== worker || worker.renewing) return;
    worker.renewing = true;
    worker.renewTimer = null;
    if (worker.inflight.size === 0) {
      this.log(`worker ${worker.address}'s key certificate expires soon; reconnecting it to renew`);
      this.closeToRenew(worker);
      return;
    }
    const drainMs = Math.max(0, Math.min(RENEW_DRAIN_MAX_MS, worker.certificate.expires * 1000 - Date.now() - RENEW_DRAIN_SAFETY_MS));
    this.log(`worker ${worker.address}'s key certificate expires soon; reconnecting it to renew once its ${worker.inflight.size} request(s) finish (at most ${Math.round(drainMs / 1000)}s)`);
    worker.renewTimer = setTimeout(() => {
      this.log(`worker ${worker.address} still has ${worker.inflight.size} request(s) after ${Math.round(drainMs / 1000)}s; reconnecting it to renew anyway`);
      this.closeToRenew(worker);
    }, drainMs);
    worker.renewTimer.unref();
  }

  private closeToRenew(worker: ConnectedWorker): void {
    if (worker.renewTimer) clearTimeout(worker.renewTimer);
    worker.renewTimer = null;
    worker.closedToRenew = true;
    worker.ws.close(4006, 'renew key certificate');
  }

  /** With `requireDeviceAttestation`, only Macs Apple attests get buyers. */
  private routable(worker: ConnectedWorker): boolean {
    if (worker.certificate.expires <= Math.floor(Date.now() / 1000) + WORKER_CERTIFICATE_USABILITY_MARGIN_S) return false;
    return !this.opts.requireDeviceAttestation || this.appleVerified(worker);
  }

  /** Why a service pinned with a files digest can't route to `worker`: its latest valid attestation doesn't name that checkpoint. */
  private unattestedModel(worker: ConnectedWorker, service: string): string | null {
    const pin = this.opts.models?.get(service);
    const expected = pin === undefined ? undefined : splitModelPin(pin);
    if (!expected?.sha256) return null;
    const attested = worker.attestation?.models?.[service];
    if (attested?.model === expected.model && attested.sha256 === expected.sha256) return null;
    return `does not attest ${expected.model} with the pinned files for ${service}`;
  }

  /** Log the checkpoints a worker attests when they change, so an operator can pin their digests. */
  private noteAttestedModels(worker: ConnectedWorker, previous: WorkerAttestation | null): void {
    for (const [service, attested] of Object.entries(worker.attestation?.models ?? {})) {
      const before = previous?.models?.[service];
      if (before && attestedModelKey(before) === attestedModelKey(attested)) continue;
      const { witness } = attested;
      const engine = witness ? `${witness.path}, engine ${witness.engine}, binary ${witness.binary}, text ${witness.text}` : 'none';
      this.log(`worker ${worker.address} attests ${attested.model} for ${service}, files sha256 ${attested.sha256}, engine binary ${attested.engine ?? 'none'}, engine witness ${engine}`);
    }
    this.emitChangeIfNeeded();
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
    const boundTo = attestation?.udid ? this.opts.deviceBindings?.get(attestation.udid.toUpperCase()) : undefined;
    if (!attestation?.udid || !attestation.serial || !attestationKey) {
      reason = 'it reports no Mac to attest';
    } else if (boundTo?.toLowerCase() !== worker.address.toLowerCase()) {
      reason = `the Mac it reports (${attestation.udid}) is not bound to it in COLONY_POOL_MDM_DEVICES`;
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

  /**
   * Re-challenge a worker that attests. A missed or failed answer disconnects
   * it only when the pool requires Apple's attestation (which is looked up
   * for the Mac the worker's attestation names); otherwise the worker keeps
   * serving without its attestation label and is asked again next round, so
   * one systematic fault (clock skew, a bad release) can't empty the pool.
   */
  private scheduleAttestation(worker: ConnectedWorker): void {
    worker.attestTimer = setTimeout(() => {
      const nonce = randomBytes(32).toString('hex');
      worker.attestNonce = nonce;
      this.sendFrame(worker.ws, { t: 'attest', nonce });
      worker.attestTimer = setTimeout(() => this.attestationFailed(worker, 'did not re-attest in time'), ATTESTATION_REPLY_MS);
      worker.attestTimer.unref();
    }, this.opts.attestationIntervalMs ?? ATTESTATION_INTERVAL_MS);
    worker.attestTimer.unref();
  }

  private attestationFailed(worker: ConnectedWorker, reason: string): void {
    if (this.workers.get(worker.address) !== worker) return;
    worker.attestNonce = null;
    if (this.opts.requireDeviceAttestation) {
      this.log(`worker ${worker.address} ${reason}; disconnecting it`);
      worker.ws.close(4004, 'attestation failed');
      return;
    }
    this.log(`worker ${worker.address} ${reason}; it keeps serving without its attestation label`);
    worker.attestation = null;
    worker.hardened = false;
    this.noteAttested();
    this.emitChangeIfNeeded();
    this.scheduleAttestation(worker);
  }

  private reattested(worker: ConnectedWorker, attestation: WorkerAttestation): void {
    if (!worker.attestNonce || this.workers.get(worker.address) !== worker) return;
    if (worker.attestTimer) clearTimeout(worker.attestTimer);
    const check = verifyWorkerAttestation(attestation, worker.certificate, this.attestationPolicy(worker.attestNonce));
    if (!check.valid) {
      this.attestationFailed(worker, `failed re-attestation (${check.reason})`);
      return;
    }
    const deviceChanged = attestation.serial !== worker.attestation?.serial || attestation.udid !== worker.attestation?.udid;
    worker.attestNonce = null;
    const previous = worker.attestation;
    worker.attestation = attestation;
    this.noteAttestedModels(worker, previous);
    if (worker.hardened !== check.hardened) {
      this.log(`worker ${worker.address} ${check.hardened ? 'now reports' : 'no longer reports'} a hardened Mac`);
      worker.hardened = check.hardened;
      this.noteAttested();
    }
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
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const service of new Set(services)) {
      const pin = this.opts.models?.get(service);
      const expected = pin === undefined ? undefined : splitModelPin(pin).model;
      if (!this.catalog.has(service)) {
        rejected.push(service);
      } else if (expected !== undefined && worker.models[service] !== expected) {
        this.log(`worker ${worker.address} runs ${worker.models[service] ?? 'an unnamed model'} for ${service}, not ${expected}; not routing it`);
        rejected.push(service);
      } else {
        accepted.push(service);
      }
    }
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
    // A renewing worker is checked again when it reconnects.
    if (this.workers.get(worker.address) !== worker || !worker.offered.has(service) || worker.verified.has(service) || worker.renewing) return;
    const body = new TextEncoder().encode(JSON.stringify({
      model: service,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 16,
      stream: false,
    }));
    const passed = await this.sealedRoundTrip(worker, body, `canary-${randomUUID()}`, '/v1/chat/completions', CANARY_TIMEOUT_MS)
      .then((response) => response.status === 200 && saysReady(Buffer.from(response.body)))
      .catch(() => false);
    if (this.workers.get(worker.address) !== worker || !worker.offered.has(service)) return;
    if (passed) {
      worker.verified.add(service);
      this.emitChangeIfNeeded();
      this.wakeWaiting();
    } else {
      this.log(`worker ${worker.address} failed the check for ${service}; not routing it`);
    }
  }

  private handleFrame(worker: ConnectedWorker, frame: WorkerFrame): void {
    switch (frame.t) {
      case 'services':
        if (frame.models) worker.models = frame.models;
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
        entry.status = frame.status;
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
          this.failDispatch(worker, frame.id, entry, new Error(`Worker ${worker.address} sent more than ${entry.maxBytes} bytes`), { reason: 'oversize', bench: false });
          return;
        }
        entry.touch();
        entry.handlers.onChunk(data);
        return;
      }
      case 'response-end': {
        const entry = worker.inflight.get(frame.id);
        if (!entry?.started) return;
        this.finish(worker, frame.id);
        this.recordAnswer(worker, entry);
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
        // Workers refuse a request (its channel, its binding, their capacity) before
        // `accepted`, and fail one they took (the model threw or timed out) after it.
        // Only the second is the worker's fault: a refusal the buyer caused never
        // counts against it, or anyone could sink a Mac's rank with bad requests.
        const failure = entry.accepted ? { reason: 'worker-error', bench: !entry.started } : undefined;
        this.failDispatch(worker, frame.id, entry, new Error(`Worker ${worker.address}: ${frame.message}`), failure);
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
    if (this.workers.get(worker.address) === worker) {
      this.workers.delete(worker.address);
      if (worker.closedToRenew) {
        this.reconnecting.set(worker.address, Date.now() + RENEW_RECONNECT_GRACE_MS);
        // Requests waiting for it give up at their own deadline; this only bounds the map.
        setTimeout(() => {
          if ((this.reconnecting.get(worker.address) ?? Infinity) <= Date.now()) this.reconnecting.delete(worker.address);
        }, RENEW_RECONNECT_GRACE_MS).unref();
      }
    }
    this.opts.ledger.recordDisconnect(worker.connectionId);
    for (const [dispatchId, entry] of [...worker.inflight]) {
      if (worker.closedToRenew) {
        // The pool closed it to renew its certificate: not the worker's failure. One not started yet goes to the next recipient.
        this.failDispatch(worker, dispatchId, entry, new Error(`Worker ${worker.address} reconnected to renew its key certificate`));
        continue;
      }
      // Dropping a request before answering it benches the worker; mid-response it only counts against it.
      this.failDispatch(worker, dispatchId, entry, new Error(`Worker ${worker.address} disconnected`), { reason: 'disconnect', bench: !entry.started });
    }
    this.log(`worker ${worker.address} left`);
    this.noteAttested();
    this.emitChangeIfNeeded();
    this.wakeWaiting();
  }

  /**
   * Warn when the workers with a valid attestation fall by half or more within
   * one re-attestation round (from at least two): one systematic fault, such
   * as the pool's clock, a worker release or the operator's MDM, is the likely
   * cause, and with `requireDeviceAttestation` it takes them out of routing.
   */
  private noteAttested(): void {
    const now = Date.now();
    const count = [...this.workers.values()].filter((worker) => worker.attestation !== null).length;
    const windowMs = (this.opts.attestationIntervalMs ?? ATTESTATION_INTERVAL_MS) + ATTESTATION_REPLY_MS;
    this.attestedCounts = this.attestedCounts.filter((entry) => now - entry.at <= windowMs);
    const peak = Math.max(count, ...this.attestedCounts.map((entry) => entry.count));
    this.attestedCounts.push({ at: now, count });
    if (peak >= 2 && count * 2 <= peak && now - this.attestedDropWarnedAt > windowMs) {
      this.attestedDropWarnedAt = now;
      this.log(`WARNING: attested workers fell from ${peak} to ${count} within ${Math.round(windowMs / 1000)}s; check the pool's clock, the latest worker release${this.opts.deviceAttestor ? ' and the MDM' : ''}`);
    }
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

/** A recipient that can't take a request now only for a while (no free slot, or renewing): requests wait for it. */
function onlyBusy(reason: string | null): boolean {
  return reason === AT_CAPACITY || reason === RENEWING;
}

/** Whether a join check's completion answers "ready", give or take case, quotes, punctuation and a reasoning block. */
export function saysReady(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return false;
    const reply = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return /^[\s"'`*_.!:]*ready[\s"'`*_.!:]*$/i.test(reply);
  } catch {
    return false;
  }
}
