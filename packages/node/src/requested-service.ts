import type { SerializedHttpRequest } from './types/http.js';
import { extractRequestBodyFields, parseJsonObject, readPlainMultipartParts } from '@antseed/api-adapter';

/** A field some reader of a request may take its model from, however it is spelled. */
const SERVICE_FIELD = /^\s*(?:service|model|modelid)\s*(?:\[.*\])?\s*$/i;

/** The spellings of those fields that the seller reads. */
const PLAIN_SERVICE_FIELDS = new Set(['service', 'model', 'modelId']);

type NamedFields = Array<[name: string, value: unknown]>;

/**
 * The service a JSON or multipart request body names (`service`, else `model`),
 * exactly as sellers read it to route, price and bill the request; null when it
 * names none, or unless its `service`, `model` and `modelId` fields agree and
 * are written plainly. A provider and its upstream read the body again by their
 * own rules, and the seller pays for what they read.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  const named = serviceFields(request);
  if (!named) return null;
  const fields = new Map(named);
  if (fields.size !== named.length || (fields.has('model') && fields.has('modelId'))) return null;
  // A null `service` is a missing one, to the readers that follow too.
  if (fields.get('service') === null) fields.delete('service');
  const service = fields.get('service') ?? fields.get('model');
  if (typeof service !== 'string' || service.trim().length === 0) return null;
  const billed = service.trim();
  const agree = [...fields].every(([name, value]) => PLAIN_SERVICE_FIELDS.has(name) && typeof value === 'string' && value.trim() === billed);
  return agree ? billed : null;
}

/**
 * The fields of a JSON body, or the text fields of a multipart one, as sellers
 * read them to price and bill a request (multipart: the first of each name,
 * none over 4 KiB); null for any other body.
 */
export function requestBodyFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): Record<string, unknown> | null {
  return extractRequestBodyFields(request.headers, request.body);
}

/** Every field of the body that names a service, or null when the body cannot be read plainly. */
function serviceFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): NamedFields | null {
  const contentTypes = Object.entries(request.headers).filter(([name]) => name.toLowerCase() === 'content-type');
  if (contentTypes.length > 1) return null;
  const contentType = contentTypes[0]?.[1] ?? '';
  if (/^multipart\/form-data/i.test(contentType.trim())) {
    const parts = readPlainMultipartParts(request.body, contentType)?.filter((part) => SERVICE_FIELD.test(part.name));
    if (!parts || parts.some((part) => !part.billedText)) return null;
    return parts.map((part) => [part.name, new TextDecoder().decode(part.content)]);
  }
  const body = parseJsonObject(request.body);
  if (!body) return null;
  // Only a multipart body may use `modelId`: the relay writes the model over it there, and not in JSON.
  const named = Object.entries(body).filter(([name]) => SERVICE_FIELD.test(name));
  return named.some(([name]) => name === 'modelId') ? null : named;
}
