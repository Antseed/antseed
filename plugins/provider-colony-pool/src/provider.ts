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
  envelopeRecipients,
  WORKER_ASSIGN_PATH,
  WORKER_E2E_CAPABILITY,
  WORKER_UNAVAILABLE_CODE,
  WORKER_UNAVAILABLE_STATUS,
  workerE2EProviderCapability,
} from '@antseed/node/worker-e2e';
import type { WorkerLedger } from './ledger.js';
import { NoWorkerAvailableError, WorkerUnavailableError, type ColonyPool } from './pool.js';

/** Request IDs the seller's model health checker uses for its probes. */
const HEALTH_PROBE_PREFIX = 'health-';

export interface ColonyPoolProviderOptions {
  pool: ColonyPool;
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
    body: new TextEncoder().encode(JSON.stringify({ error: { message, type: 'colony_pool_error', ...(code ? { code } : {}) } })),
  };
}

/** The model a request names, and how many workers an assignment asks for. */
function routeOf(req: SerializedHttpRequest): { model: string | null; recipients: number } {
  try {
    const body = JSON.parse(new TextDecoder().decode(req.body)) as { model?: unknown; recipients?: unknown };
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const recipients = typeof body.recipients === 'number' && Number.isInteger(body.recipients) ? body.recipients : 1;
    return { model, recipients };
  } catch {
    return { model: null, recipients: 1 };
  }
}

/**
 * Seller-side provider that serves every request from a pool worker. Its
 * announced `services` follow the connected workers, and each paid request
 * is credited to the worker that served it.
 */
export class ColonyPoolProvider implements Provider {
  readonly name = 'colony-pool';
  readonly services: string[] = [];
  readonly pricing: Provider['pricing'];
  readonly maxConcurrency: number;
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly serviceCapabilities?: Record<string, ServiceCapabilities>;
  /** Buyers encrypt to a worker only for the services of a provider named in a capability. */
  readonly peerCapabilities = [WORKER_E2E_CAPABILITY, workerE2EProviderCapability(this.name)];

  private readonly pool: ColonyPool;
  private readonly ledger: WorkerLedger;
  private readonly workerShareBps: bigint;
  private readonly protocolFeeBps: bigint;
  /**
   * The worker and dispatch that served each request, until it is charged.
   * Keyed by the request object, since buyers' request IDs can collide.
   */
  private readonly servedBy = new WeakMap<SerializedHttpRequest, { worker: string; dispatchId: string }>();
  private servicesChanged: (() => void) | null = null;

  constructor(opts: ColonyPoolProviderOptions) {
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

  /** Free route: assign the top-ranked workers the buyer asks for and hand it their key certificates. */
  async handleControlRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (req.method !== 'POST' || req.path.split('?')[0] !== WORKER_ASSIGN_PATH) {
      return errorResponse(req.requestId, 404, `Unknown colony pool route ${req.method} ${req.path}`);
    }
    const { model, recipients } = routeOf(req);
    if (!model) return errorResponse(req.requestId, 400, 'Request body must name a model');
    try {
      const workers = this.pool.assign(model, recipients);
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ workers })),
      };
    } catch (err) {
      if (err instanceof NoWorkerAvailableError) return errorResponse(req.requestId, 503, err.message);
      throw err;
    }
  }

  onRequestCharged(charge: ProviderRequestCharge): void {
    const served = charge.request ? this.servedBy.get(charge.request) : undefined;
    if (!served || !charge.request) return;
    this.servedBy.delete(charge.request);
    const { worker, dispatchId } = served;
    const timing = this.pool.takeTiming(worker, dispatchId);
    const streamMs = timing?.firstByteAt ? Math.max(1, timing.endedAt - timing.firstByteAt) : undefined;
    this.ledger.recordEarning({
      requestId: dispatchId,
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
    const { model: service } = routeOf(req);
    if (!service) return Promise.resolve(errorResponse(req.requestId, 400, 'Request body must name a model'));
    const recipients = envelopeRecipients(req.body);
    if (recipients.length === 0) {
      if (req.requestId.startsWith(HEALTH_PROBE_PREFIX)) return this.probe(req, service);
      return Promise.resolve(errorResponse(
        req.requestId,
        428,
        'This seller is a colony pool: requests must be encrypted to one of its workers. Update your Antseed buyer.',
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
        body: Buffer.concat(chunks),
      });

      // The worker the pool tried last: the one that answered, when the response ends.
      let worker = '';
      let dispatchId = '';
      try {
        this.pool.dispatch(recipients, service, req, {
          onAttempt: (address, id) => {
            worker = address;
            dispatchId = id;
          },
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
            this.servedBy.set(req, { worker, dispatchId });
            resolve(response());
          },
          onError: (error) => {
            // Nothing reached the buyer and every recipient failed: it takes other workers (the pool benches one that never answered).
            if (!start) resolve(errorResponse(req.requestId, WORKER_UNAVAILABLE_STATUS, error.message, WORKER_UNAVAILABLE_CODE));
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
}
