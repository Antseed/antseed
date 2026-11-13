import type {
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
  ServiceApiProtocol,
} from '@antseed/node';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import { HttpRelay, type RelayConfig } from './http-relay.js';

export interface BaseProviderConfig {
  name: string;
  services: string[];
  pricing: Provider['pricing'];
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceUnitBillingModels?: Provider['serviceUnitBillingModels'];
  serviceCapabilities?: Provider['serviceCapabilities'];
  relay: RelayConfig;
}

/**
 * Convenience base class that wires HttpRelay to the Provider interface.
 * Pattern adapted from provider-anthropic's AnthropicProvider.
 */
export class BaseProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly serviceUnitBillingModels?: Provider['serviceUnitBillingModels'];
  readonly serviceCapabilities?: Provider['serviceCapabilities'];
  readonly maxConcurrency: number;

  private readonly _relay: HttpRelay;
  private _activeCount = 0;

  private readonly _pending = new Map<string, PendingRequestEntry>();

  constructor(config: BaseProviderConfig) {
    this.name = config.name;
    this.services = config.services;
    this.pricing = config.pricing;
    this.serviceApiProtocols = config.serviceApiProtocols;
    this.serviceUnitBillingModels = config.serviceUnitBillingModels;
    this.serviceCapabilities = config.serviceCapabilities;
    this.maxConcurrency = config.relay.maxConcurrency;

    this._relay = new HttpRelay(config.relay, {
      onResponse: (response: SerializedHttpResponse) => {
        this._resolvePending(response.requestId, response);
      },
      onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
        this._handlePendingChunk(chunk);
      },
    });
  }

  private _resolvePending(requestId: string, response: SerializedHttpResponse): void {
    const entry = this._pending.get(requestId);
    if (!entry) return;

    const isStreamingStart = response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] === '1';
    if (isStreamingStart) {
      entry.responseStart = response;
      this._invokeStreamCallback(requestId, 'response-start', () => {
        entry.streamCallbacks?.onResponseStart(response);
      });
      return;
    }

    this._pending.delete(requestId);
    entry.resolve(this._stripStreamingHeader(response));
  }

  private _handlePendingChunk(chunk: SerializedHttpResponseChunk): void {
    const entry = this._pending.get(chunk.requestId);
    if (!entry) return;

    this._invokeStreamCallback(chunk.requestId, chunk.done ? 'response-end' : 'response-chunk', () => {
      entry.streamCallbacks?.onResponseChunk(chunk);
    });

    if (chunk.data.length > 0) {
      entry.streamChunks.push(chunk.data);
    }

    if (!chunk.done) {
      return;
    }

    if (!entry.responseStart) {
      this._pending.delete(chunk.requestId);
      entry.reject(new Error(`Stream ${chunk.requestId} ended before response start`));
      return;
    }

    this._pending.delete(chunk.requestId);
    entry.resolve(this._stripStreamingHeader({
      ...entry.responseStart,
      body: concatChunks(entry.streamChunks),
    }));
  }

  private _stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
    if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== '1') {
      return response;
    }

    const headers = { ...response.headers };
    delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
    return {
      ...response,
      headers,
    };
  }

  private _invokeStreamCallback(requestId: string, phase: string, callback: () => void): void {
    try {
      callback();
    } catch (err) {
      // Stream callbacks usually send frames back to the buyer. If the buyer has
      // already disconnected, that send can throw (for example, "Cannot send in
      // state closed"). Do not let a downstream delivery failure bubble into the
      // upstream relay, where it would be misreported as a provider/Anthropic
      // error and can cause the seller connection handler to unwind.
      console.warn(
        `[BaseProvider] stream callback skipped phase=${phase} reqId=${requestId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async init(): Promise<void> {
    if (this._relay['_config'].tokenProvider) {
      await this._relay['_config'].tokenProvider.getToken();
    }
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._activeCount++;
    try {
      const responsePromise = new Promise<SerializedHttpResponse>((resolve, reject) => {
        this._pending.set(req.requestId, {
          resolve,
          reject,
          responseStart: null,
          streamChunks: [],
        });
      });

      await this._relay.handleRequest(req);

      return await responsePromise;
    } catch (err) {
      const entry = this._pending.get(req.requestId);
      if (entry) {
        this._pending.delete(req.requestId);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    } finally {
      this._activeCount--;
    }
  }

  async handleRequestStream(
    req: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    this._activeCount++;
    try {
      const responsePromise = new Promise<SerializedHttpResponse>((resolve, reject) => {
        this._pending.set(req.requestId, {
          resolve,
          reject,
          responseStart: null,
          streamChunks: [],
          streamCallbacks: callbacks,
        });
      });

      await this._relay.handleRequest(req);

      return await responsePromise;
    } catch (err) {
      const entry = this._pending.get(req.requestId);
      if (entry) {
        this._pending.delete(req.requestId);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    } finally {
      this._activeCount--;
    }
  }

  getCapacity(): { current: number; max: number } {
    return {
      current: this._activeCount,
      max: this.maxConcurrency,
    };
  }
}

interface PendingRequestEntry {
  resolve: (response: SerializedHttpResponse) => void;
  reject: (error: Error) => void;
  responseStart: SerializedHttpResponse | null;
  streamChunks: Uint8Array[];
  streamCallbacks?: ProviderStreamCallbacks;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
