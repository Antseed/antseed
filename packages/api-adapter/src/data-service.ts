/**
 * Data services: a seller's own HTTP API, reached under `/v1/data/<service>/`.
 *
 * `GET /v1/data/<service>/openapi.json` returns the seller's description of the service, an
 * OpenAPI document. It is free. Every other request under the service is one of its
 * operations, sent and answered unchanged, and billed per completed request.
 *
 * The service is named in the path, not in the body, so an operation's request carries
 * nothing of Antseed's.
 */

import type { DataServiceProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';

export const DATA_SERVICE_PATH_PREFIX = '/v1/data/';

/**
 * Set by the seller node on every answer a data provider gave (any value the provider sent under
 * this name is replaced). A data API controls its own bodies, so a buyer reads Antseed control
 * answers (a payment step, model_not_found) only from responses without it.
 */
export const DATA_PROVIDER_RESPONSE_HEADER = 'x-antseed-data-response';

/** Whether a response is a data provider's own answer, as the seller node marked it. */
export function isDataProviderResponse(response: { headers: Record<string, string> }): boolean {
  return Object.entries(response.headers).some(([name, value]) =>
    name.toLowerCase() === DATA_PROVIDER_RESPONSE_HEADER && value === 'provider');
}

/** `headers` marked as a data provider's own answer, replacing any value the provider sent. */
export function markDataProviderResponse(headers: Record<string, string>): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== DATA_PROVIDER_RESPONSE_HEADER));
  return { ...out, [DATA_PROVIDER_RESPONSE_HEADER]: 'provider' };
}

/** Where a data service's description lives, relative to the service. */
export const DATA_SERVICE_DOCUMENT_PATH = '/openapi.json';

export interface DataServiceRoute {
  protocol: DataServiceProtocol;
  service: string;
  /** `describe` reads the service's description (free); `call` runs one of its operations. */
  action: 'describe' | 'call';
  /** The operation's own path and query, as the seller's API expects them. Starts with `/`. */
  operationPath: string;
}

/** The data service a request addresses, or null when it is not a data request. */
export function dataServiceRoute(request: Pick<SerializedHttpRequest, 'path' | 'method'>): DataServiceRoute | null {
  if (!request.path.toLowerCase().startsWith(DATA_SERVICE_PATH_PREFIX)) return null;
  const rest = request.path.slice(DATA_SERVICE_PATH_PREFIX.length);
  const end = rest.search(/[/?]/);
  const segment = end === -1 ? rest : rest.slice(0, end);
  let service: string;
  try {
    service = decodeURIComponent(segment).trim();
  } catch {
    return null;
  }
  if (service.length === 0) return null;
  const remainder = end === -1 ? '' : rest.slice(end);
  const operationPath = remainder.startsWith('/') ? remainder : `/${remainder}`;
  const pathOnly = operationPath.split('?')[0]!;
  const describe = request.method.toUpperCase() === 'GET' && (pathOnly === '/' || pathOnly === DATA_SERVICE_DOCUMENT_PATH);
  return { protocol: 'openapi-data', service, action: describe ? 'describe' : 'call', operationPath };
}

/** The same request with another service named in its path; null when it is not a data request. */
export function withDataService<T extends Pick<SerializedHttpRequest, 'path' | 'method'>>(request: T, service: string): T | null {
  if (!dataServiceRoute(request)) return null;
  const rest = request.path.slice(DATA_SERVICE_PATH_PREFIX.length);
  const end = rest.search(/[/?]/);
  return { ...request, path: `${DATA_SERVICE_PATH_PREFIX}${encodeURIComponent(service)}${end === -1 ? '' : rest.slice(end)}` };
}

/**
 * Whether an operation's response delivered an answer, so its price may be charged: a 2xx
 * status with a body. A refusal, an error or an empty answer is free.
 */
export function dataServiceDelivered(response: Pick<SerializedHttpResponse, 'statusCode' | 'body'>): boolean {
  return response.statusCode >= 200 && response.statusCode < 300 && response.body.length > 0;
}
