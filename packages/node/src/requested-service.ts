import { randomBytes } from 'node:crypto';
import { UNIT_BILLING_MATCH_KEYS_V1 } from '@antseed/protocol/billing';
import { extractRequestBodyFields, parseJsonObject } from '@antseed/api-adapter';
import type { SerializedHttpRequest } from './types/http.js';

/*
 * A seller prices a request by the fields it reads from the body, and then the provider, its relay
 * and the upstream read the body again, each by its own rules. So the seller does not forward the
 * buyer's bytes: it writes the body again from what it read (`billedRequestBody`) and hands the
 * provider that. A field, part or value the seller did not read never reaches a later reader, and
 * every reader of a body the seller wrote finds the fields billing found.
 *
 * What remains is what a rewrite cannot settle: `service` and `model` must agree, a billing input
 * must be spelled exactly (a reader that ignores letter case would take `Size` for `size`), a known
 * upstream model selector is refused, in the body or the path, and a priced image value must be one
 * billing reads. Video and speech billing refuse the values they cannot read themselves.
 */

/** Why a seller serves no service for a request body. `code` and `message` are what the buyer is answered. */
export interface ServiceRefusal {
  code:
    /** The body names no service, or is not a JSON object or a form. */
    | 'model_required'
    /** `service` and `model` disagree, or a service field is spelled another way, `modelId`, or not a short text field. */
    | 'ambiguous_service'
    /** A top-level field selects an upstream model beside the billed one. */
    | 'unsupported_model_selector'
    /** A service field or billing input appears more than once in a form. */
    | 'repeated_field'
    /** A billing input is spelled another way, or a priced value is not one billing reads. */
    | 'invalid_billing_field'
    /** A multipart body is not a form the seller can read. */
    | 'unsupported_multipart_body';
  message: string;
}

/** The one service a request body names and the body the seller wrote for it, or why it names none. */
export type BilledRequestBody =
  | { service: string; contentType: string; body: Uint8Array }
  | { service: null; refusal: ServiceRefusal };

type Refused = Extract<BilledRequestBody, { service: null }>;

const refuse = (code: ServiceRefusal['code'], message: string): Refused => ({ service: null, refusal: { code, message } });
const quote = (name: string) => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name);
const NO_SERVICE = refuse('model_required', 'Request must name one service, in a "service" or "model" field of a JSON or multipart body.');

/** The fields a buyer names its service in. */
const SERVICE_FIELDS = new Set(['service', 'model']);

/** Every billing input, by its exact name: each appears once and is spelled exactly so. */
const BILLING_FIELDS = new Set<string>([
  ...SERVICE_FIELDS, ...UNIT_BILLING_MATCH_KEYS_V1, 'n',
  'duration', 'generate_audio', 'reference_video_urls', 'video_urls', 'prompt', 'input',
]);

/** Text values an image is priced by: when present, one short plain string. */
const PRICED_TEXT_FIELDS = ['size', 'quality', 'resolution'];

/** Form fields billing reads: each must be one short text part. */
const FORM_BILLED_FIELDS = new Set(['service', 'model', 'n', 'size', 'quality', 'resolution']);

/** Billing reads a form text field only up to this size. */
const MAX_FORM_TEXT_BYTES = 4096;

const SELECTOR_FIELDS = ['models', 'route', 'fallbacks', 'default_fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks',
  'mock_testing_fallbacks', 'model_list', 'model_group', 'deployment_id'];

/**
 * Top-level fields refused outright. The selectors pick an upstream model beside, or in place of,
 * the billed `model`: `models` and `route` in OpenRouter-style APIs, the fallback and deployment
 * fields in LiteLLM-style proxies. Best effort: a seller cannot know every field every upstream
 * reads, so a plugin whose upstream reads others refuses or removes them itself. `modelId` is
 * written only by plugins, and `_charset_` changes how some form readers decode every other field.
 */
const REFUSED_FIELDS = new Map<string, ServiceRefusal['code']>([
  ...SELECTOR_FIELDS.map((name): [string, ServiceRefusal['code']] => [name, 'unsupported_model_selector']),
  ['modelid', 'ambiguous_service'],
  ['_charset_', 'unsupported_multipart_body'],
]);

/**
 * The service a JSON or multipart request body names (`service`, else `model`), exactly as sellers
 * read it to route, price and bill the request; null when it names none or the seller refuses it.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  return billedRequestBody(request).service;
}

/**
 * The fields of a JSON body, or the text fields of a multipart one, as sellers read them to price
 * and bill a request (multipart: the first of each name, none over 4 KiB); null for any other body.
 */
export function requestBodyFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): Record<string, unknown> | null {
  return extractRequestBodyFields(request.headers, request.body);
}

/**
 * The service a request body names and the body the seller hands its provider in place of the
 * buyer's: the same fields, written by the seller. A body is read as a form when its content type
 * says `multipart/form-data`, and as JSON otherwise.
 */
export function billedRequestBody(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): BilledRequestBody {
  const contentType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.trim() ?? '';
  return /^multipart\/form-data/i.test(contentType) ? billedForm(request.body, contentType) : billedJson(request.body);
}

/**
 * Why a request path is refused, if it is: some upstreams and proxies take the model from a path
 * segment (`/openai/deployments/<model>/...`, `/engines/<model>/...`, `/models/<model>:generate...`,
 * `/model/<model>/invoke`)
 * or a query parameter ahead of the body, and the relay forwards the path as it came. Best effort,
 * like the selector fields.
 */
export function requestPathRefusal(path: string): ServiceRefusal | undefined {
  const [pathname = '', query = ''] = path.split('?', 2);
  // A server that decodes `%64eployments` or `%2F`, or splits at `;`, would read segments this check does not.
  if (!/^\/[A-Za-z0-9._~:/-]*$/.test(pathname) || query.includes(';')) {
    return { code: 'unsupported_model_selector', message: 'Request path must be written plainly: letters, digits and . _ ~ : / - only, and no ";" in the query.' };
  }
  const segments = pathname.toLowerCase().split('/');
  const selector = segments.findIndex((segment, index) => ['deployments', 'engines', 'models', 'model'].includes(segment) && index < segments.length - 1);
  if (selector !== -1) return { code: 'unsupported_model_selector', message: `Path segment ${quote(segments[selector]!)} selects an upstream model, which this seller does not accept: it serves the one service named in "model".` };
  for (const name of new URLSearchParams(query).keys()) {
    const base = baseName(name);
    if (REFUSED_FIELDS.has(base) || BILLING_FIELDS.has(base)) {
      return { code: 'unsupported_model_selector', message: `Query parameter ${quote(name)} is not accepted: name the service and billing inputs in the body.` };
    }
  }
  return undefined;
}

function billedJson(bytes: Uint8Array): BilledRequestBody {
  const body = parseJsonObject(bytes);
  if (!body) return NO_SERVICE;
  // A repeated key is gone after parsing: the body written below has only the value billing read.
  const seen = new Set<string>();
  for (const name of Object.keys(body)) {
    const refusal = nameRefusal(name, seen);
    if (refusal) return refusal;
  }
  const service = oneService(body['service'], body['model']);
  if (typeof service !== 'string') return service;
  const priced = pricedValueRefusal(body);
  if (priced) return priced;
  return { service, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)) };
}

function billedForm(bytes: Uint8Array, contentType: string): BilledRequestBody {
  const parts = readFormParts(bytes, contentType);
  if (typeof parts === 'string') return refuse('unsupported_multipart_body', `Multipart request is not a standard form: ${parts}.`);
  const seen = new Set<string>();
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const refusal = nameRefusal(part.name, seen);
    if (refusal) return refusal;
    if (!FORM_BILLED_FIELDS.has(part.name)) continue;
    const text = part.filename === undefined && part.content.length <= MAX_FORM_TEXT_BYTES ? utf8(part.content) : undefined;
    if (text === undefined) {
      return refuse(SERVICE_FIELDS.has(part.name) ? 'ambiguous_service' : 'invalid_billing_field', `Field ${quote(part.name)} must be sent as one short UTF-8 text field.`);
    }
    fields[part.name] = text;
  }
  const service = oneService(fields['service'], fields['model']);
  if (typeof service !== 'string') return service;
  const priced = pricedValueRefusal(fields);
  if (priced) return priced;
  const boundary = `----FormBoundary${randomBytes(16).toString('hex')}`;
  return { service, contentType: `multipart/form-data; boundary=${boundary}`, body: writeForm(parts, boundary) };
}

/**
 * Why a field name is refused, if it is. A name is compared as the loosest reader reads it: in any
 * letter case (with Unicode folds such as the long s), padded, or with a `[...]` suffix. `seen`
 * holds the billing inputs already read.
 */
function nameRefusal(name: string, seen: Set<string>): Refused | undefined {
  const base = baseName(name);
  const refused = REFUSED_FIELDS.get(base);
  if (refused) return refuse(refused, `Field ${quote(name)} is not accepted: this seller serves the one service named in "model".`);
  if (!BILLING_FIELDS.has(base)) return undefined;
  if (name !== base) {
    return refuse(SERVICE_FIELDS.has(base) ? 'ambiguous_service' : 'invalid_billing_field', `Field ${quote(name)} must be named exactly ${quote(base)}.`);
  }
  if (seen.has(base)) return refuse('repeated_field', `Field ${quote(base)} must appear once.`);
  seen.add(base);
  return undefined;
}

/** A name as the loosest reader reads it. Linear time: no regex runs over buyer-controlled lengths. */
function baseName(name: string): string {
  const folded = name.toUpperCase().toLowerCase();
  const bracket = folded.indexOf('[');
  return (bracket === -1 ? folded : folded.slice(0, bracket)).trim();
}

/** The one service `service` and `model` name, or why they name none. A null `service` is a missing one. */
function oneService(service: unknown, model: unknown): string | Refused {
  const named = service ?? model;
  if (service !== undefined && service !== null && model !== undefined && service !== model) {
    return refuse('ambiguous_service', '"service" and "model" must say exactly the same.');
  }
  if (typeof named !== 'string' || named.length === 0) return NO_SERVICE;
  if (named !== named.trim()) return refuse('ambiguous_service', 'The service name must be written without surrounding white space.');
  return named;
}

/**
 * Why a priced value is refused, if it is. Billing reads only plain values and skips any other, so
 * a value it skips would be billed at its default while a looser upstream reads it.
 */
function pricedValueRefusal(fields: Record<string, unknown>): Refused | undefined {
  const n = fields['n'];
  if (n !== undefined && n !== null) {
    const plain = typeof n === 'number' ? Number.isSafeInteger(n) && n > 0 : typeof n === 'string' && /^[1-9][0-9]{0,5}$/.test(n);
    if (!plain) return refuse('invalid_billing_field', 'Field "n" must be a positive whole number.');
  }
  for (const name of PRICED_TEXT_FIELDS) {
    const value = fields[name];
    if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[!-~]{1,64}$/.test(value))) {
      return refuse('invalid_billing_field', `Field ${quote(name)} must be one short plain text value.`);
    }
  }
  return undefined;
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

interface FormPart {
  name: string;
  filename?: string;
  type?: string;
  content: Uint8Array;
}

const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * The parts of a form, or why it is not one. Only what this returns is forwarded: a preamble, an
 * epilogue, and every part header beside the disposition and a file's type are dropped.
 */
function readFormParts(bytes: Uint8Array, contentType: string): FormPart[] | string {
  const match = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return 'the content type names no boundary';
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1');
  // The first delimiter starts the body or a line.
  let at: number;
  if (body.subarray(0, delimiter.length - 2).equals(delimiter.subarray(2))) {
    at = delimiter.length - 2;
  } else {
    const first = body.indexOf(delimiter);
    if (first === -1) return 'it has no delimiter';
    at = first + delimiter.length;
  }
  const parts: FormPart[] = [];
  for (;;) {
    if (body[at] === 0x2d && body[at + 1] === 0x2d) return parts;
    if (body[at] !== 0x0d || body[at + 1] !== 0x0a) return 'a delimiter is not followed by a line break';
    const headerEnd = body.indexOf(HEADER_END, at);
    if (headerEnd === -1) return 'a part has no header block';
    const next = body.indexOf(delimiter, headerEnd + 2);
    if (next === -1) return 'it has no closing delimiter';
    const part = readPartHeaders(body.toString('latin1', at + 2, headerEnd));
    if (typeof part === 'string') return part;
    parts.push({ ...part, content: body.subarray(headerEnd + 4, Math.max(headerEnd + 4, next)) });
    at = next + delimiter.length;
  }
}

/** A field name the seller writes back as it read it, and every reader reads alike. */
const FIELD_NAME = /^[A-Za-z0-9_.[\]-]{1,200}$/;
/** A file's media type, written back without parameters; a nested form or message is not one. */
const FILE_TYPE = /^(?!multipart\/|message\/)[A-Za-z0-9.+-]{1,64}\/[A-Za-z0-9.+-]{1,64}$/i;

function readPartHeaders(block: string): Omit<FormPart, 'content'> | string {
  let disposition: string | undefined;
  let type: string | undefined;
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1 || !/^[A-Za-z0-9-]+$/.test(line.slice(0, colon))) return 'a part header is not one "Name: value" line';
    const field = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'content-disposition') {
      if (disposition !== undefined) return 'a part has two Content-Disposition headers';
      disposition = value;
    } else if (field === 'content-type') {
      type ??= value;
    } else if (field === 'content-transfer-encoding' && !/^(?:7bit|8bit|binary)$/i.test(value)) {
      return 'a part is transfer-encoded';
    }
  }
  if (disposition === undefined) return 'a part has no Content-Disposition';
  const params = readDisposition(disposition);
  if (!params) return 'a Content-Disposition is not a plain form-data disposition';
  const name = params.get('name');
  if (name === undefined || !FIELD_NAME.test(name)) return 'a field name is missing or has a character outside A-Z, a-z, 0-9 and _ . - [ ]';
  const filename = params.get('filename') ?? extendedFilename(params.get('filename*'));
  // A text field is written with no Content-Type, so no reader decodes it another way.
  if (filename === undefined) return { name };
  const mediaType = type?.split(';', 1)[0]!.trim();
  return {
    name,
    // Bytes that end or escape a quoted string for some reader never reach the filename the seller writes.
    filename: Buffer.from(filename, 'latin1').toString('utf8').replace(/[\u0000-\u001f\u007f-\u009f"\\]/g, '_'),
    ...(mediaType === undefined ? {} : { type: FILE_TYPE.test(mediaType) ? mediaType : 'application/octet-stream' }),
  };
}

/**
 * The parameters of a `form-data` disposition, keys in lower case; undefined unless every byte is
 * read and no key repeats. Written by hand so that no regex runs over buyer-controlled lengths.
 */
function readDisposition(value: string): Map<string, string> | undefined {
  if (!/^form-data(?:[ \t;]|$)/i.test(value)) return undefined;
  const params = new Map<string, string>();
  let i = 'form-data'.length;
  const skipBlanks = () => { while (value[i] === ' ' || value[i] === '\t') i += 1; };
  for (;;) {
    skipBlanks();
    if (i >= value.length) return params;
    if (value[i] !== ';') return undefined;
    i += 1;
    skipBlanks();
    if (i >= value.length) return params;
    const start = i;
    while (i < value.length && /[A-Za-z0-9*_-]/.test(value[i]!)) i += 1;
    const key = value.slice(start, i).toLowerCase();
    if (key === '' || value[i] !== '=' || params.has(key)) return undefined;
    i += 1;
    let text = '';
    if (value[i] === '"') {
      for (i += 1; ; i += 1) {
        if (i >= value.length) return undefined;
        if (value[i] === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) i += 1;
        else if (value[i] === '"') break;
        text += value[i];
      }
      i += 1;
    } else {
      const from = i;
      while (i < value.length && value[i] !== ';' && value[i] !== ' ' && value[i] !== '\t') i += 1;
      text = value.slice(from, i);
      if (text === '' || /["\\]/.test(text)) return undefined;
    }
    params.set(key, text);
  }
}

/** The filename in an RFC 5987 `filename*=charset''value`, as latin1 like the rest of the header. */
function extendedFilename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const quotes = value.indexOf("''");
    return Buffer.from(decodeURIComponent(quotes === -1 ? value : value.slice(quotes + 2)), 'utf8').toString('latin1');
  } catch {
    return 'file';
  }
}

/** A form written the one way every reader reads alike: the seller's boundary, one disposition per part, quoted plain names. */
function writeForm(parts: FormPart[], boundary: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const file = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    const type = part.type === undefined ? '' : `\r\nContent-Type: ${part.type}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file}${type}\r\n\r\n`, 'utf8'), part.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
