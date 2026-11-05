import type { SerializedHttpRequest } from './types/http.js';
import { extractRequestBodyFields } from '@antseed/api-adapter';

/**
 * The service a JSON or multipart request body names (`service`, else
 * `model`), exactly as sellers read it to route, price and bill the request;
 * null when it names none. Providers that act on the service must read it the
 * same way, so they never serve a different service than the one billed.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  const body = requestBodyFields(request);
  const service = body?.['service'] ?? body?.['model'];
  if (typeof service !== 'string' || service.trim().length === 0) return null;
  return service.trim();
}

/**
 * The fields of a JSON body, or the text fields of a multipart one, as sellers
 * read them to price and bill a request (multipart: the first of each name,
 * none over 4 KiB); null for any other body.
 */
export function requestBodyFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): Record<string, unknown> | null {
  return extractRequestBodyFields(request.headers, request.body);
}
