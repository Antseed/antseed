import { FetchRequest, JsonRpcProvider, type JsonRpcPayload, type JsonRpcResult } from 'ethers';
import { TokenBucket } from './rate-limit.js';

export interface RpcTransportResponse {
  status: number;
  /** Parsed JSON body, or null when the body is not JSON. */
  body: unknown;
}
export type RpcTransport = (url: string, body: string) => Promise<RpcTransportResponse>;

const REQUEST_TIMEOUT_MS = 10_000;
const THROTTLE_COOLDOWN_MS = 20_000;
/** Pace calls before an endpoint throttles to limit bursts against public gateways. */
const PACED_CALLS_PER_SECOND = 8;
const RATE_LIMIT_CODE = -32005;
/** Deployed contract code does not change; Multicall3 is probed on every batched read. */
const CODE_CACHE_MS = 10 * 60_000;

interface Endpoint {
  url: string;
  coolingUntil: number;
  bucket: TokenBucket | null;
}

/**
 * JSON-RPC provider over several endpoints that sends each call to the first
 * endpoint not cooling down. An endpoint that answers 429 (or a JSON-RPC
 * rate-limit error) is put on a cooldown and paced afterwards, and the call
 * moves to the next one; the ethers failover provider instead fans a stalled
 * call out to every endpoint and waits for the slowest. When every endpoint
 * is cooling down the call fails fast rather than waiting out a cooldown.
 * Endpoints are tried in the order given, so pass them best first.
 */
export class RotatingJsonRpcProvider extends JsonRpcProvider {
  private readonly endpoints: Endpoint[];
  private readonly transport: RpcTransport;
  private readonly now: () => number;
  private readonly inflightReads = new Map<string, Promise<JsonRpcResult[]>>();
  private readonly codeCache = new Map<string, { result: string; at: number }>();

  constructor(urls: string[], evmChainId?: number, options: { transport?: RpcTransport; now?: () => number } = {}) {
    if (urls.length === 0) throw new Error('At least one RPC endpoint is required.');
    super(urls[0], evmChainId, { staticNetwork: !!evmChainId, batchMaxCount: 1 });
    this.endpoints = urls.map((url) => ({ url, coolingUntil: 0, bucket: new TokenBucket(PACED_CALLS_PER_SECOND, 4) }));
    this.transport = options.transport ?? fetchTransport;
    this.now = options.now ?? Date.now;
  }

  /** Endpoint the next call would go to (the first one once everything is cooling down). */
  get activeUrl(): string {
    return (this.pick() ?? this.endpoints[0]!).url;
  }

  get urls(): string[] {
    return this.endpoints.map((endpoint) => endpoint.url);
  }

  invalidateReads(): void {
    this.inflightReads.clear();
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    if (Array.isArray(payload) || !['eth_call', 'eth_getCode', 'eth_getBalance'].includes(payload.method)) {
      return this.sendPayload(payload);
    }
    const codeAddress = payload.method === 'eth_getCode' && Array.isArray(payload.params) && typeof payload.params[0] === 'string' ? payload.params[0].toLowerCase() : null;
    const cachedCode = codeAddress ? this.codeCache.get(codeAddress) : undefined;
    if (cachedCode && this.now() - cachedCode.at < CODE_CACHE_MS) return [{ id: payload.id, result: cachedCode.result }];
    const key = JSON.stringify([payload.method, payload.params]);
    let pending = this.inflightReads.get(key);
    if (!pending) {
      pending = this.sendPayload(payload);
      this.inflightReads.set(key, pending);
    }
    try {
      const results = (await pending).map(result => ({ ...result, id: payload.id }));
      const code = results[0] && 'result' in results[0] ? results[0].result : undefined;
      // Only deployed code is remembered: an account may still gain EIP-7702 delegation later.
      if (codeAddress && typeof code === 'string' && code !== '0x') this.codeCache.set(codeAddress, { result: code, at: this.now() });
      return results;
    } finally {
      if (this.inflightReads.get(key) === pending) this.inflightReads.delete(key);
    }
  }

  private async sendPayload(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const calls = Array.isArray(payload) ? payload.length : 1;
    const body = JSON.stringify(payload);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
      const endpoint = this.pick();
      if (!endpoint) break;
      if (endpoint.bucket) await endpoint.bucket.take(calls);
      if (endpoint.coolingUntil > this.now()) continue;
      let response: RpcTransportResponse;
      try {
        response = await this.transport(endpoint.url, body);
      } catch (error) {
        lastError = error as Error;
        this.cool(endpoint);
        continue;
      }
      if (response.status === 429 || isRateLimited(response.body)) {
        lastError = new Error(`${endpoint.url} is rate limiting requests`);
        this.cool(endpoint);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        if (response.status >= 500) {
          lastError = new Error(`${endpoint.url} responded with HTTP ${response.status}`);
          this.cool(endpoint);
          continue;
        }
        throw new Error(`${endpoint.url} responded with HTTP ${response.status}`);
      }
      return (Array.isArray(response.body) ? response.body : [response.body]) as JsonRpcResult[];
    }
    throw lastError ?? new Error('Every RPC endpoint is rate limiting requests; retry in a few seconds.');
  }

  private pick(): Endpoint | undefined {
    const now = this.now();
    return this.endpoints.find((endpoint) => endpoint.coolingUntil <= now);
  }

  private cool(endpoint: Endpoint): void {
    endpoint.coolingUntil = this.now() + THROTTLE_COOLDOWN_MS;
    endpoint.bucket ??= new TokenBucket(PACED_CALLS_PER_SECOND, PACED_CALLS_PER_SECOND);
  }
}

function isRateLimited(body: unknown): boolean {
  const entries = Array.isArray(body) ? body : [body];
  return entries.some((entry) => {
    const error = (entry as { error?: { code?: number; message?: string } } | null)?.error;
    return !!error && (error.code === RATE_LIMIT_CODE || /rate limit/i.test(String(error.message ?? '')));
  });
}

async function fetchTransport(url: string, body: string): Promise<RpcTransportResponse> {
  const request = new FetchRequest(url);
  request.timeout = REQUEST_TIMEOUT_MS;
  request.retryFunc = async () => false;
  request.setHeader('content-type', 'application/json');
  request.body = body;
  const response = await request.send();
  let parsed: unknown = null;
  try {
    parsed = response.bodyJson;
  } catch {
    parsed = null;
  }
  return { status: response.statusCode, body: parsed };
}
