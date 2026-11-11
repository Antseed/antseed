import type { SerializedHttpRequest } from './types/http.js';
import { extractRequestBodyFields, isPlainJsonContentType, parseJsonObject, readPlainMultipartParts } from '@antseed/api-adapter';

/** A field some reader of a request may take its model from, however it is spelled. */
const SERVICE_FIELD = /^\s*(?:service|model|modelid)\s*(?:\[.*\])?\s*$/i;

/** The fields a buyer names its service in. A plugin may write `modelId` for its upstream, after this check. */
const BUYER_SERVICE_FIELDS = new Set(['service', 'model']);

type NamedFields = Array<[name: string, value: unknown]>;

/**
 * The service a JSON or multipart request body names (`service`, else `model`),
 * exactly as sellers read it to route, price and bill the request; null when it
 * names none, or unless its `service` and `model` fields are written plainly
 * and say exactly the same. A provider and its upstream read the body again by
 * their own rules, and the seller pays for what they read.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  const named = serviceFields(request);
  if (!named) return null;
  const fields = new Map(named);
  if (fields.size !== named.length) return null;
  // A null `service` is a missing one, to the readers that follow too.
  if (fields.get('service') === null) fields.delete('service');
  const service = fields.get('service') ?? fields.get('model');
  if (typeof service !== 'string' || service.length === 0 || service !== service.trim()) return null;
  return [...fields].every(([name, value]) => BUYER_SERVICE_FIELDS.has(name) && value === service) ? service : null;
}

/**
 * The fields of a JSON body, or the text fields of a multipart one, as sellers
 * read them to price and bill a request (multipart: the first of each name,
 * none over 4 KiB); null for any other body.
 */
export function requestBodyFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): Record<string, unknown> | null {
  return extractRequestBodyFields(request.headers, request.body);
}

/** Every field of the body that names a service, repeats included, or null when the body cannot be read plainly. */
function serviceFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): NamedFields | null {
  const contentTypes = Object.entries(request.headers).filter(([name]) => name.toLowerCase() === 'content-type');
  if (contentTypes.length > 1) return null;
  const contentType = (contentTypes[0]?.[1] ?? '').trim();
  if (/^multipart\/form-data/i.test(contentType)) {
    const parts = readPlainMultipartParts(request.body, contentType)?.filter((part) => SERVICE_FIELD.test(part.name));
    if (!parts || parts.some((part) => !part.billedText)) return null;
    // A BOM stays in the text, for the padding check to see.
    return parts.map((part) => [part.name, new TextDecoder('utf-8', { ignoreBOM: true }).decode(part.content)]);
  }
  // A form reader would take other fields from the same bytes, so JSON has to say it is JSON, or say nothing.
  if (contentType && !isPlainJsonContentType(contentType)) return null;
  const body = parseJsonObject(request.body);
  if (!body) return null;
  return topLevelKeys(request.body).filter((name) => SERVICE_FIELD.test(name)).map((name) => [name, body[name]]);
}

const QUOTE = 0x22;
const COLON = 0x3a;
const BACKSLASH = 0x5c;

/** The top-level keys of a valid JSON object, repeats included, which `JSON.parse` drops. */
function topLevelKeys(body: Uint8Array): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index]!;
    if (byte === 0x7b || byte === 0x5b) depth += 1;
    else if (byte === 0x7d || byte === 0x5d) depth -= 1;
    else if (byte === QUOTE) {
      const start = index;
      for (index += 1; body[index] !== QUOTE; index += 1) {
        if (body[index] === BACKSLASH) index += 1;
      }
      let next = index + 1;
      while (body[next] === 0x20 || body[next] === 0x09 || body[next] === 0x0a || body[next] === 0x0d) next += 1;
      if (depth === 1 && body[next] === COLON) {
        keys.push(JSON.parse(new TextDecoder().decode(body.subarray(start, index + 1))) as string);
      }
    }
  }
  return keys;
}
