import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { verifyMessage } from 'ethers';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  deviceAttestationNonce,
  sealRequest,
  verifyDeviceAttestation,
  verifyWorkerAttestation,
  type DeviceAttestation,
  verifyWorkerKeyCertificate,
  type WorkerAssignment,
  type WorkerAttestation,
  type WorkerKeyCertificate,
} from '@antseed/node/worker-e2e';
import type { WorkerLedger } from './ledger.js';
import type { DeviceAttestor } from './mdm.js';
import {
  WORKER_POOL_PROTOCOL_VERSION,
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
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_CONCURRENCY = 64;
/** A certificate must outlive the connection's first minute to be accepted. */
const MIN_CERTIFICATE_LIFETIME_S = 60;
/** Assignments count toward a worker's load for this long, so new buyers spread out. */
const ASSIGNMENT_WEIGHT_MS = 10 * 60_000;
/** Attested workers re-attest this often, and have this long to answer. */
const ATTESTATION_INTERVAL_MS = 5 * 60_000;
const ATTESTATION_REPLY_MS = 30_000;
/** An attestation answering a challenge must be this fresh. */
const ATTESTATION_MAX_AGE_S = 120;
/** How often the operator's MDM re-fetches Apple's attestation of a Mac. */
const DEVICE_ATTESTATION_INTERVAL_MS = 24 * 60 * 60_000;

export interface WorkerPoolOptions {
  poolId: string;
  /** Address buyers pay (the AntseedWorkerPool contract, or the seller node's address). */
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
  /** How long a worker has to start answering a request. */
  firstByteTimeoutMs?: number;
  /** Only admit workers whose attestation reports a hardened Mac (signed app, SIP on, app-bound key). */
  requireAttestation?: boolean;
  /** If set, only apps signed by these Apple Developer teams count as hardened. */
  attestedTeams?: Set<string>;
  attestationIntervalMs?: number;
  /** The operator's MDM, for Apple-signed attestations of enrolled Macs (optional). */
  deviceAttestor?: DeviceAttestor;
  /** Only route to Macs Apple attests through the operator's MDM (SIP on, serial matches). */
  requireDeviceAttestation?: boolean;
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
}

export interface DispatchRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
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

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface InFlight {
  handlers: DispatchHandlers;
  started: boolean;
  timer: NodeJS.Timeout | null;
  startedAt: number;
  firstByteAt: number | null;
}

export interface RequestTiming {
  startedAt: number;
  firstByteAt: number | null;
  endedAt: number;
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
  deviceTimer: NodeJS.Timeout | null;
  connectionId: number;
  maxConcurrency: number;
  /** Services the worker offers that the pool sells. */
  offered: Set<string>;
  /** Offered services that passed the join check (all of them when verification is off). */
  verified: Set<string>;
  inflight: Map<string, InFlight>;
  /** Timing of recently finished requests, kept until the charge hook reads it. */
  finished: Map<string, RequestTiming>;
  /** Smoothed decode speed in output tokens per second, 0 until measured. */
  tokensPerSecond: number;
  /** When buyers were recently assigned to this worker. */
  assignedAt: number[];
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
}

/**
 * Accepts worker connections, verifies them, and routes requests to the
 * least-loaded worker that serves the requested service.
 */
export class WorkerPool {
  private readonly opts: WorkerPoolOptions;
  private readonly catalog: Set<string>;
  private readonly workers = new Map<string, ConnectedWorker>();
  private readonly changeListeners: Array<() => void> = [];
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastServices = '';

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
    this.catalog = new Set(opts.catalog);
  }

  async start(): Promise<number> {
    const server = this.opts.tls ? createHttpsServer(this.opts.tls) : createHttpServer();
    server.on('request', (_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('Antseed worker pool: connect with a WebSocket.\n');
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
    wss.on('connection', (ws) => this.accept(ws));
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
      for (const worker of this.workers.values()) worker.ws.ping();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
    const address = server.address();
    return typeof address === 'object' && address ? address.port : this.opts.port;
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    await this.opts.deviceAttestor?.stop?.();
    for (const worker of [...this.workers.values()]) worker.ws.close(1001, 'pool stopping');
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /** Services at least one connected worker can serve right now. */
  availableServices(): string[] {
    const services = new Set<string>();
    for (const worker of this.workers.values()) {
      if (!this.routable(worker)) continue;
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
    return [...this.workers.values()].map((worker) => ({
      address: worker.address,
      agent: worker.agent,
      services: [...worker.verified],
      inflight: worker.inflight.size,
      maxConcurrency: worker.maxConcurrency,
      tokensPerSecond: worker.tokensPerSecond,
      attested: worker.hardened,
      appleVerified: worker.deviceAttestation !== null,
    }));
  }

  /** Pick a worker for a buyer and return its key certificate and attestation. Throws NoWorkerAvailableError. */
  assign(service: string): WorkerAssignment {
    const worker = this.pickWorker(service, true);
    if (!worker) throw new NoWorkerAvailableError(service);
    worker.assignedAt.push(Date.now());
    return {
      ...worker.certificate,
      ...(worker.attestation ? { attestation: worker.attestation } : {}),
      ...(worker.deviceAttestation ? { deviceAttestation: worker.deviceAttestation } : {}),
    };
  }

  /**
   * Send a buyer's sealed request to the worker it is encrypted for. The
   * response arrives through `handlers`. Throws WorkerUnavailableError when
   * that worker cannot take it, so the buyer reassigns.
   */
  dispatchTo(address: string, service: string, req: DispatchRequest, handlers: DispatchHandlers, signal?: AbortSignal): void {
    const worker = this.workers.get(address.toLowerCase());
    if (!worker) throw new WorkerUnavailableError(address, 'not connected');
    if (!worker.verified.has(service) || !this.routable(worker)) throw new WorkerUnavailableError(address, `not serving ${service}`);
    if (worker.inflight.size >= worker.maxConcurrency) throw new WorkerUnavailableError(address, 'at capacity');
    this.send(worker, worker.inflight, req, handlers, signal);
  }

  /**
   * Run a request of the pool's own (a health probe or join check) on a
   * worker for `service`: the pool seals it like a buyer would, without a
   * buyer binding, so workers cap it as a check.
   */
  async probe(service: string, body: Uint8Array, requestId: string, path = '/v1/chat/completions', worker = this.pickWorker(service)): Promise<PlainResponse> {
    if (!worker) throw new NoWorkerAvailableError(service);
    return this.sealedRoundTrip(worker, body, requestId, path, this.opts.firstByteTimeoutMs ?? 120_000);
  }

  private async sealedRoundTrip(worker: ConnectedWorker, body: Uint8Array, requestId: string, path: string, timeoutMs: number): Promise<PlainResponse> {
    const sealed = await sealRequest({ body, worker: worker.address, workerKey: worker.certificate.key });
    return new Promise((resolve, reject) => {
      let status = 0;
      let headers: Record<string, string> = {};
      const chunks: Uint8Array[] = [];
      this.send(worker, worker.inflight, {
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
      }, undefined, timeoutMs);
    });
  }

  /** Fold one finished request's decode speed into the worker's average. */
  recordThroughput(address: string, outputTokens: number, streamMs: number): void {
    const worker = this.workers.get(address.toLowerCase());
    if (!worker || outputTokens <= 0 || streamMs <= 0) return;
    const sample = outputTokens / (streamMs / 1000);
    worker.tokensPerSecond = worker.tokensPerSecond === 0 ? sample : worker.tokensPerSecond * 0.8 + sample * 0.2;
  }

  /** Timing of a finished request, read once by the provider when the request is charged. */
  takeTiming(address: string, requestId: string): RequestTiming | null {
    const worker = this.workers.get(address.toLowerCase());
    const timing = worker?.finished.get(requestId) ?? null;
    worker?.finished.delete(requestId);
    return timing;
  }

  /** Least-loaded worker for `service`; for assignments, recent assignments count as load too. */
  private pickWorker(service: string, forAssignment = false): ConnectedWorker | null {
    const now = Date.now();
    let best: ConnectedWorker | null = null;
    let bestLoad = Infinity;
    for (const worker of this.workers.values()) {
      if (!worker.verified.has(service) || !this.routable(worker) || worker.inflight.size >= worker.maxConcurrency) continue;
      worker.assignedAt = worker.assignedAt.filter((at) => now - at < ASSIGNMENT_WEIGHT_MS);
      const load = (worker.inflight.size + (forAssignment ? worker.assignedAt.length : 0)) / worker.maxConcurrency;
      if (load < bestLoad || (load === bestLoad && best && worker.tokensPerSecond > best.tokensPerSecond)) {
        best = worker;
        bestLoad = load;
      }
    }
    return best;
  }

  private send(
    worker: ConnectedWorker,
    table: Map<string, InFlight>,
    req: DispatchRequest,
    handlers: DispatchHandlers,
    signal?: AbortSignal,
    firstByteTimeoutMs = this.opts.firstByteTimeoutMs ?? 120_000,
  ): void {
    const entry: InFlight = { handlers, started: false, timer: null, startedAt: Date.now(), firstByteAt: null };
    const fail = (error: Error): void => {
      if (table.get(req.requestId) !== entry) return;
      this.finish(table, req.requestId);
      handlers.onError(error);
    };
    entry.timer = setTimeout(() => {
      this.sendFrame(worker.ws, { t: 'cancel', id: req.requestId });
      fail(new Error(`Worker ${worker.address} did not answer within ${firstByteTimeoutMs}ms`));
    }, firstByteTimeoutMs);
    table.set(req.requestId, entry);
    signal?.addEventListener('abort', () => {
      this.sendFrame(worker.ws, { t: 'cancel', id: req.requestId });
      fail(new Error('Request aborted'));
    }, { once: true });
    this.sendFrame(worker.ws, {
      t: 'request',
      id: req.requestId,
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: encodeBody(req.body),
    });
  }

  private finish(table: Map<string, InFlight>, requestId: string): void {
    const entry = table.get(requestId);
    if (entry?.timer) clearTimeout(entry.timer);
    table.delete(requestId);
  }

  private accept(ws: WebSocket): void {
    const nonce = randomBytes(32).toString('hex');
    const helloTimer = setTimeout(() => {
      this.log('a connection sent no valid hello in time; closing it');
      ws.close(4001, 'no hello');
    }, HELLO_TIMEOUT_MS);
    this.sendFrame(ws, { t: 'challenge', version: WORKER_POOL_PROTOCOL_VERSION, pool: this.opts.poolId, nonce, seller: this.opts.seller });
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
      deviceTimer: null,
      connectionId: this.opts.ledger.recordConnect(address, hello.agent),
      maxConcurrency: Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, Math.floor(hello.maxConcurrency))),
      offered: new Set(),
      verified: new Set(),
      inflight: new Map(),
      finished: new Map(),
      tokensPerSecond: 0,
      assignedAt: [],
    };
    this.workers.set(address, worker);
    const { accepted, rejected } = this.setOffered(worker, hello.services);
    this.sendFrame(ws, { t: 'welcome', workerId: address, accepted, rejected, workerShareBps: this.opts.workerShareBps });
    this.log(`worker ${address} joined (${worker.agent}${hardened ? ', attested' : ''}) offering ${accepted.join(', ') || 'nothing'}`);
    if (worker.attestation) this.scheduleAttestation(worker);
    if (this.opts.deviceAttestor) void this.attestDevice(worker);
    return worker;
  }

  /** With `requireDeviceAttestation`, only Macs Apple attests get buyers. */
  private routable(worker: ConnectedWorker): boolean {
    return !this.opts.requireDeviceAttestation || worker.deviceAttestation !== null;
  }

  /**
   * Ask the operator's MDM for Apple's attestation of the Mac this worker
   * says it runs on, bound to the worker and its attestation key, and repeat
   * it daily. A pool that requires it disconnects workers that fail.
   */
  private async attestDevice(worker: ConnectedWorker): Promise<void> {
    const attestation = worker.attestation;
    const attestationKey = worker.certificate.attestationKey;
    let reason: string | undefined;
    if (!attestation?.udid || !attestation.serial || !attestationKey) {
      reason = 'it reports no Mac to attest';
    } else {
      const challenge = randomBytes(16).toString('hex');
      try {
        const chain = await this.opts.deviceAttestor!.attest(attestation.udid, deviceAttestationNonce(worker.address, attestationKey, challenge));
        const check = verifyDeviceAttestation({ chain, challenge }, {
          worker: worker.address, attestationKey, serialNumber: attestation.serial, maxAgeS: ATTESTATION_MAX_AGE_S * 5,
          ...(this.opts.deviceAttestationRoots ? { roots: this.opts.deviceAttestationRoots } : {}),
        });
        if (check.valid) {
          if (this.workers.get(worker.address) !== worker) return;
          worker.deviceAttestation = { chain, challenge };
          this.log(`Apple attests worker ${worker.address}'s Mac ${attestation.serial} (SIP on, ${check.report?.osVersion ?? 'macOS'})`);
          this.emitChangeIfNeeded();
        } else {
          reason = check.reason;
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    if (this.workers.get(worker.address) !== worker) return;
    if (reason) {
      worker.deviceAttestation = null;
      this.log(`no Apple attestation for worker ${worker.address}: ${reason}`);
      this.emitChangeIfNeeded();
      if (this.opts.requireDeviceAttestation) {
        worker.ws.close(4005, 'this pool only admits Macs Apple attests through its MDM');
        return;
      }
    }
    worker.deviceTimer = setTimeout(() => void this.attestDevice(worker), this.opts.deviceAttestationIntervalMs ?? DEVICE_ATTESTATION_INTERVAL_MS);
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
    if (!worker.attestNonce) return;
    const check = verifyWorkerAttestation(attestation, worker.certificate, this.attestationPolicy(worker.attestNonce));
    if (!check.valid || (worker.hardened && !check.hardened)) {
      this.log(`worker ${worker.address} failed re-attestation (${check.reason ?? 'no longer hardened'}); disconnecting it`);
      worker.ws.close(4004, 'attestation failed');
      return;
    }
    if (worker.attestTimer) clearTimeout(worker.attestTimer);
    if (worker.deviceTimer) clearTimeout(worker.deviceTimer);
    worker.attestNonce = null;
    worker.attestation = attestation;
    this.scheduleAttestation(worker);
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
      if (this.opts.verifyOnJoin) void this.verify(worker, service);
      else worker.verified.add(service);
    }
    this.emitChangeIfNeeded();
    return { accepted, rejected };
  }

  /** A short completion the worker must answer correctly before buyers reach it. */
  private async verify(worker: ConnectedWorker, service: string): Promise<void> {
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
      case 'response-start': {
        const entry = worker.inflight.get(frame.id);
        if (!entry || entry.started) return;
        entry.started = true;
        entry.firstByteAt = Date.now();
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.handlers.onStart(frame.status, frame.headers);
        return;
      }
      case 'response-chunk': {
        const entry = worker.inflight.get(frame.id);
        if (!entry?.started) return;
        entry.handlers.onChunk(decodeBody(frame.data));
        return;
      }
      case 'response-end': {
        const entry = worker.inflight.get(frame.id);
        if (!entry?.started) return;
        this.finish(worker.inflight, frame.id);
        // Paid requests are charged right after they end; free ones never read this.
        worker.finished.set(frame.id, { startedAt: entry.startedAt, firstByteAt: entry.firstByteAt, endedAt: Date.now() });
        setTimeout(() => worker.finished.delete(frame.id), 60_000).unref();
        entry.handlers.onEnd();
        return;
      }
      case 'response-error': {
        const entry = worker.inflight.get(frame.id);
        if (!entry) return;
        this.finish(worker.inflight, frame.id);
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
    if (this.workers.get(worker.address) === worker) this.workers.delete(worker.address);
    this.opts.ledger.recordDisconnect(worker.connectionId);
    for (const [requestId, entry] of [...worker.inflight]) {
      this.finish(worker.inflight, requestId);
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
    this.opts.log?.(`[worker-pool] ${line}`);
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
