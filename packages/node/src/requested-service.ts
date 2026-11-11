import type { SerializedHttpRequest } from './types/http.js';
import { extractRequestBodyFields, multipartTextFieldName, parseJsonObject, readMultipartParts } from '@antseed/api-adapter';

/** A field some reader of a request may take its model from, in any letter case. */
const SERVICE_FIELD = /^(?:service|model|modelid)$/i;

/** The spellings of those fields that every reader reads alike. */
const PLAIN_SERVICE_FIELDS = new Set(['service', 'model', 'modelId']);

/** Each `name` parameter in a part's headers, however it is written. `filename` is not one. */
const NAME_PARAMETER = /(?:^|[;\s])(name\*?\s*=\s*(?:"[^"]*"|[^;\s]*))/gim;

/** A name parameter every reader reads alike: quoted, and with nothing a reader might decode. */
const PLAIN_NAME = /^name="((?:(?!=\?)[^"\\%])*)"$/;

/** What a name parameter that is not plain could turn out to name. */
const MAY_NAME_SERVICE = /service|model|[%\\]|=\?/i;

/** A part's header block with one header per CRLF-ended line, which every reader splits alike. */
const PLAIN_HEADERS = /^(?:\r\n[!-9;-~]+:[^\r\n]*)+$/;

type NamedFields = Array<[name: string, value: unknown]>;

/**
 * The service a JSON or multipart request body names (`service`, else `model`),
 * exactly as sellers read it to route, price and bill the request; null when
 * it names none, or when it could read as another. A provider and its upstream
 * read the request again by their own rules, and the seller pays for what they
 * read, so a request is served only when every reading gives the service billed.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  const named = serviceFields(request);
  if (!named) return null;
  const fields = new Map(named);
  const service = fields.get('service') ?? fields.get('model');
  if (typeof service !== 'string' || service.trim().length === 0) return null;
  const billed = service.trim();
  const agree = fields.size === named.length
    && !(fields.has('model') && fields.has('modelId'))
    && [...fields].every(([name, value]) => PLAIN_SERVICE_FIELDS.has(name) && (value === null || (typeof value === 'string' && value.trim() === billed)));
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

/** Every field of the body that names a service, or null when the body cannot be read unambiguously. */
function serviceFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): NamedFields | null {
  const contentTypes = Object.entries(request.headers).filter(([name]) => name.toLowerCase() === 'content-type');
  if (contentTypes.length > 1) return null;
  const contentType = contentTypes[0]?.[1] ?? '';
  if (/^multipart\/form-data/i.test(contentType.trim())) return multipartServiceFields(request.body, contentType);
  const body = parseJsonObject(request.body);
  if (!body) return null;
  // Only a multipart body may use `modelId`: the relay writes the model over it there, and not in JSON.
  const named = Object.entries(body).filter(([name]) => SERVICE_FIELD.test(name));
  return named.some(([name]) => name === 'modelId') ? null : named;
}

function multipartServiceFields(body: Uint8Array, contentType: string): NamedFields | null {
  const multipart = readMultipartParts(body, contentType);
  if (!multipart?.unambiguous) return null;
  const named: NamedFields = [];
  for (const part of multipart.parts) {
    const parameters = [...part.headers.matchAll(NAME_PARAMETER)].map((match) => match[1]!);
    const plain = parameters.length === 1 ? PLAIN_NAME.exec(parameters[0]!)?.[1] : undefined;
    if (plain === undefined) {
      if (parameters.some((parameter) => MAY_NAME_SERVICE.test(parameter))) return null;
    } else if (SERVICE_FIELD.test(plain)) {
      // Text billing reads under this very name; some readers take a part with any filename for a value.
      if (!PLAIN_HEADERS.test(part.headers) || multipartTextFieldName(part) !== plain || /filename/i.test(part.headers)) return null;
      named.push([plain, new TextDecoder().decode(part.content)]);
    }
  }
  return named;
}
