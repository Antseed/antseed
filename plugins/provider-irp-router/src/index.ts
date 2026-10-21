import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import {
  IRP_MODELS_PATH,
  IRP_PROBLEM_TYPES,
  IRP_RANK_PATH,
  IRP_SUGGEST_PROTOCOL,
  irpProblemBody,
  validateIrpRankRequest,
} from '@antseed/node';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Upper bound on an upstream answer; rankings and model lists are small JSON documents. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const csv = (raw: string | undefined): string[] =>
  [...new Set((raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean))];

export interface IrpRouterOptions {
  /** Upstream IRP router base URL; `/v1/routing/models` and `/v1/routing/rank` are appended. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function problem(requestId: string, statusCode: number, type: string, title: string, detail: string): SerializedHttpResponse {
  return { requestId, statusCode, headers: { 'content-type': 'application/problem+json' }, body: irpProblemBody(statusCode, type, title, detail) };
}

/**
 * Serves an upstream IRP suggest-only router on AntSeed. It forwards the two IRP endpoints
 * unchanged, so any router that implements the spec can be offered as an `irp-suggest`
 * routing service. Rank requests are validated before they leave the seller, so malformed
 * ones are answered locally and never billed.
 */
export class IrpRouterProxy {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IrpRouterOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('IRP_ROUTER_BASE_URL must be an http(s) URL');
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const path = request.path.split('?')[0];
    const isModels = request.method === 'GET' && path === IRP_MODELS_PATH;
    const isRank = request.method === 'POST' && path === IRP_RANK_PATH;
    if (!isModels && !isRank) {
      return problem(request.requestId, 404, IRP_PROBLEM_TYPES.invalidRequest, 'Not found', `${request.method} ${path} is not an IRP routing endpoint.`);
    }
    if (isRank) {
      try {
        validateIrpRankRequest(JSON.parse(new TextDecoder().decode(request.body)));
      } catch (error) {
        return problem(request.requestId, 400, IRP_PROBLEM_TYPES.invalidRequest, 'Invalid request', error instanceof Error ? error.message : String(error));
      }
    }
    const headers: Record<string, string> = { accept: 'application/json, application/problem+json' };
    if (isRank) headers['content-type'] = 'application/json';
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: request.method,
        headers,
        ...(isRank ? { body: request.body } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      return problem(request.requestId, 503, IRP_PROBLEM_TYPES.unavailable, 'Router unavailable', `Upstream router unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      return problem(request.requestId, 503, IRP_PROBLEM_TYPES.unavailable, 'Router unavailable', 'Upstream router response is too large.');
    }
    return {
      requestId: request.requestId,
      statusCode: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
      body,
    };
  }
}

/**
 * Offer an IRP router on AntSeed. One of possibly many routing provider plugins: it is the
 * one for routers that speak Inference Routing Protocol suggest-only mode.
 */
const plugin: AntseedProviderPlugin = {
  name: 'irp-router',
  displayName: 'IRP Router',
  version: '0.1.0',
  type: 'provider',
  description: 'Serve an Inference Routing Protocol (IRP) router as an irp-suggest routing service',
  configSchema: [
    { key: 'IRP_ROUTER_BASE_URL', label: 'Router URL', type: 'string', required: true, description: 'Base URL of the upstream IRP router' },
    { key: 'IRP_ROUTER_API_KEY', label: 'API Key', type: 'secret', required: false, description: 'Bearer token for the upstream router, if it needs one' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Routing Service', type: 'string[]', required: true, description: 'Routing service id (exactly one: IRP paths name no service)' },
    { key: 'IRP_ROUTER_PRICE_USD', label: 'Price per Ranking', type: 'number', required: false, default: 0, description: 'USD charged per ranking; 0 makes routing free' },
    { key: 'IRP_ROUTER_TIMEOUT_MS', label: 'Timeout', type: 'number', required: false, default: DEFAULT_TIMEOUT_MS, description: 'Upstream request timeout in milliseconds' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 50, description: 'Max concurrent routing requests' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const baseUrl = config['IRP_ROUTER_BASE_URL']?.trim();
    if (!baseUrl) throw new Error('IRP_ROUTER_BASE_URL is required');
    const services = csv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length !== 1) throw new Error('irp-router offers exactly one routing service: set ANTSEED_ALLOWED_SERVICES to one service id');
    const service = services[0]!;
    const priceUsd = Number(config['IRP_ROUTER_PRICE_USD'] ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error('IRP_ROUTER_PRICE_USD must be a non-negative number');
    const timeoutMs = Number(config['IRP_ROUTER_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('IRP_ROUTER_TIMEOUT_MS must be a positive number');
    const maxConcurrency = Number.parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '50', 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const apiKey = config['IRP_ROUTER_API_KEY']?.trim();

    const router = new IrpRouterProxy({ baseUrl, timeoutMs, ...(apiKey ? { apiKey } : {}) });
    let active = 0;

    return {
      name: 'irp-router',
      services: [service],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { [service]: [IRP_SUGGEST_PROTOCOL] },
      // One completed request per well-formed ranking; a $0 price takes the free-service path on both sides.
      serviceUnitBillingModels: {
        [service]: { [IRP_SUGGEST_PROTOCOL]: { version: 1, components: [{ unit: 'completed_requests', priceUsd }] } },
      },
      maxConcurrency,
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      async handleRequest(request) {
        active++;
        try {
          return await router.handleRequest(request);
        } finally {
          active--;
        }
      },
    };
  },
};

export default plugin;
