import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import type {
  Provider,
  ProviderRequestCharge,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceApiProtocol,
  ServiceCapabilities,
} from '@antseed/node';
import {
  WORKER_ASSIGN_PATH,
  WORKER_E2E_CAPABILITY,
  WORKER_UNAVAILABLE_CODE,
  WORKER_UNAVAILABLE_STATUS,
} from '@antseed/node/worker-e2e';
import type { WorkerLedger } from './ledger.js';
import { NoWorkerAvailableError, WorkerUnavailableError, type WorkerPool } from './pool.js';

const MAX_TRACKED_REQUESTS = 10_000;
/** Request IDs the seller's model health checker uses for its probes. */
const HEALTH_PROBE_PREFIX = 'health-';

export interface WorkerPoolProviderOptions {
  pool: WorkerPool;
  ledger: WorkerLedger;
  pricing: Provider['pricing'];
  workerShareBps: number;
  /** Protocol fee AntseedChannels takes before the pool's split (basis points). */
  protocolFeeBps?: number;
  maxConcurrency: number;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceCapabilities?: Record<string, ServiceCapabilities>;
}

function errorResponse(requestId: string, statusCode: number, message: string, code?: string): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ error: { message, type: 'worker_pool_error', ...(code ? { code } : {}) } })),
  };
}

/** The model a request names, and the worker its envelope is encrypted for (if any). */
function routeOf(req: SerializedHttpRequest): { model: string | null; worker: string | null } {
  try {
    const body = JSON.parse(new TextDecoder().decode(req.body)) as { model?: unknown; antseed_e2e?: { worker?: unknown } };
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const worker = typeof body.antseed_e2e?.worker === 'string' ? body.antseed_e2e.worker : null;
    return { model, worker };
  } catch {
    return { model: null, worker: null };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Seller-side provider that serves every request from a pool worker. Its
 * announced `services` follow the connected workers, and each paid request
 * is credited to the worker that served it.
 */
export class WorkerPoolProvider implements Provider {
  readonly name = 'worker-pool';
  readonly services: string[] = [];
  readonly pricing: Provider['pricing'];
  readonly maxConcurrency: number;
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly serviceCapabilities?: Record<string, ServiceCapabilities>;
  readonly peerCapabilities = [WORKER_E2E_CAPABILITY];

  private readonly pool: WorkerPool;
  private readonly ledger: WorkerLedger;
  private readonly workerShareBps: bigint;
  private readonly protocolFeeBps: bigint;
  /** requestId → worker address, until the request is charged or ages out. */
  private readonly servedBy = new Map<string, string>();
  private servicesChanged: (() => void) | null = null;

  constructor(opts: WorkerPoolProviderOptions) {
    this.pool = opts.pool;
    this.ledger = opts.ledger;
    this.pricing = opts.pricing;
    this.maxConcurrency = opts.maxConcurrency;
    this.workerShareBps = BigInt(opts.workerShareBps);
    this.protocolFeeBps = BigInt(opts.protocolFeeBps ?? 200);
    if (opts.serviceApiProtocols) this.serviceApiProtocols = opts.serviceApiProtocols;
    if (opts.serviceCapabilities) this.serviceCapabilities = opts.serviceCapabilities;
    this.syncServices();
    this.pool.onChange(() => {
      this.syncServices();
      this.servicesChanged?.();
    });
  }

  setServicesChangedListener(listener: () => void): void {
    this.servicesChanged = listener;
  }

  getCapacity(): { current: number; max: number } {
    const { current, max } = this.pool.capacity();
    return { current, max: Math.min(max, this.maxConcurrency) };
  }

  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    return this.forward(req, null);
  }

  handleRequestStream(req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks): Promise<SerializedHttpResponse> {
    return this.forward(req, callbacks);
  }

  /** Free route: assign a worker and hand the buyer its key certificate. */
  async handleControlRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (req.method !== 'POST' || req.path.split('?')[0] !== WORKER_ASSIGN_PATH) {
      return errorResponse(req.requestId, 404, `Unknown worker pool route ${req.method} ${req.path}`);
    }
    const { model } = routeOf(req);
    if (!model) return errorResponse(req.requestId, 400, 'Request body must name a model');
    try {
      const certificate = this.pool.assign(model);
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(certificate)),
      };
    } catch (err) {
      if (err instanceof NoWorkerAvailableError) return errorResponse(req.requestId, 503, err.message);
      throw err;
    }
  }

  onRequestCharged(charge: ProviderRequestCharge): void {
    const worker = this.servedBy.get(charge.requestId);
    if (!worker) return;
    this.servedBy.delete(charge.requestId);
    const timing = this.pool.takeTiming(worker, charge.requestId);
    const streamMs = timing?.firstByteAt ? Math.max(1, timing.endedAt - timing.firstByteAt) : undefined;
    this.ledger.recordEarning({
      requestId: charge.requestId,
      worker,
      ...(charge.service ? { service: charge.service } : {}),
      grossUsdc: charge.costUsdc,
      // Mirrors the contract: protocol fee first, then the pool's split.
      workerUsdc: (((charge.costUsdc * (10_000n - this.protocolFeeBps)) / 10_000n) * this.workerShareBps) / 10_000n,
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      ...(streamMs ? { streamMs } : {}),
    });
    if (streamMs) this.pool.recordThroughput(worker, charge.outputTokens, streamMs);
  }

  private syncServices(): void {
    // Mutate in place: the node's announcer holds this array by reference.
    this.services.splice(0, this.services.length, ...this.pool.availableServices());
  }

  /** The seller's health probe: the pool seals it to a worker itself, as a check. */
  private async probe(req: SerializedHttpRequest, service: string): Promise<SerializedHttpResponse> {
    try {
      const response = await this.pool.probe(service, req.body, req.requestId, req.path.split('?')[0]);
      return { requestId: req.requestId, statusCode: response.status, headers: response.headers, body: response.body };
    } catch (err) {
      if (err instanceof NoWorkerAvailableError) return errorResponse(req.requestId, 503, err.message);
      return errorResponse(req.requestId, 502, err instanceof Error ? err.message : String(err));
    }
  }

  private forward(req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks | null): Promise<SerializedHttpResponse> {
    const { model: service, worker: target } = routeOf(req);
    if (!service) return Promise.resolve(errorResponse(req.requestId, 400, 'Request body must name a model'));
    if (!target) {
      if (req.requestId.startsWith(HEALTH_PROBE_PREFIX)) return this.probe(req, service);
      return Promise.resolve(errorResponse(
        req.requestId,
        428,
        'This seller is a worker pool: requests must be encrypted to one of its workers. Update your Antseed buyer.',
        'e2e_required',
      ));
    }

    return new Promise<SerializedHttpResponse>((resolve, reject) => {
      let start: { statusCode: number; headers: Record<string, string> } | null = null;
      let streaming = false;
      const chunks: Uint8Array[] = [];
      const response = (): SerializedHttpResponse => ({
        requestId: req.requestId,
        statusCode: start!.statusCode,
        headers: start!.headers,
        body: concat(chunks),
      });

      const worker = target.toLowerCase();
      try {
        this.pool.dispatchTo(worker, service, req, {
          onStart: (statusCode, headers) => {
            start = { statusCode, headers };
            streaming = callbacks !== null && (headers['content-type'] ?? '').includes('text/event-stream');
            if (streaming) {
              callbacks!.onResponseStart({ ...response(), headers: { ...headers, [ANTSEED_STREAMING_RESPONSE_HEADER]: '1' } });
            }
          },
          onChunk: (data) => {
            chunks.push(data);
            if (streaming) void callbacks!.onResponseChunk({ requestId: req.requestId, data, done: false });
          },
          onEnd: () => {
            if (streaming) void callbacks!.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
            this.track(req.requestId, worker);
            resolve(response());
          },
          onError: (error) => {
            if (!start) resolve(errorResponse(req.requestId, 502, error.message));
            else reject(error);
          },
        }, callbacks?.signal);
      } catch (err) {
        if (err instanceof WorkerUnavailableError) {
          resolve(errorResponse(req.requestId, WORKER_UNAVAILABLE_STATUS, err.message, WORKER_UNAVAILABLE_CODE));
          return;
        }
        reject(err);
      }
    });
  }

  private track(requestId: string, worker: string): void {
    if (this.servedBy.size >= MAX_TRACKED_REQUESTS) {
      const oldest = this.servedBy.keys().next().value;
      if (oldest !== undefined) this.servedBy.delete(oldest);
    }
    this.servedBy.set(requestId, worker);
  }
}
