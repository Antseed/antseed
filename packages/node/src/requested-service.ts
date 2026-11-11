import { UNIT_BILLING_MATCH_KEYS_V1 } from '@antseed/protocol/billing';
import type { SerializedHttpRequest } from './types/http.js';
import { MULTIPART_PRICED_FIELDS, extractRequestBodyFields, parseJsonObject, readPlainMultipartParts, type PlainMultipartPart } from '@antseed/api-adapter';

/** A field some reader of a request may take its model from, however it is spelled. */
const SERVICE_FIELD = /^\s*(?:service|model|modelid)\s*(?:\[.*\])?\s*$/i;

/**
 * Top-level fields with which a buyer selects an upstream model beside, or in place of, the singular
 * billed `model`. Best effort: this is the list of selectors known today, not a guarantee. A seller
 * cannot know every field every upstream reads, so a plugin for an upstream with others refuses or
 * removes them itself, and a selector found later is added here.
 * - `models`, `route`: the model list and routing mode of OpenRouter-style APIs.
 * - `fallbacks`, `default_fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`,
 *   `mock_testing_fallbacks`, `model_list`, `model_group`, `deployment_id`: the fallback and
 *   deployment selection of LiteLLM-style proxies.
 * Fields that keep the model and change how it is served (`service_tier`, `provider`) pass on purpose.
 */
const UPSTREAM_SELECTION_FIELD = /^\s*(?:models|route|(?:default_|context_window_|content_policy_|mock_testing_)?fallbacks|model_list|model_group|deployment_id)\s*(?:\[.*\])?\s*$/i;

/** The fields a buyer names its service in. A plugin may write `modelId` for its upstream, after this check. */
const BUYER_SERVICE_FIELDS = new Set(['service', 'model']);

/**
 * Form fields billing prices a request by, beside its service. Each needs one short plain text
 * value, so that billing and every form reader find the same one whatever they do with repeats,
 * files and long values.
 */
const PRICED_FORM_FIELDS = new Set<string>(MULTIPART_PRICED_FIELDS);

/**
 * Other billing inputs. Billing reads them from JSON bodies only, so in a form they need no
 * text value (a file part named `audio` is fine); they still appear once, under their plain name.
 */
const SINGLE_FORM_FIELDS = new Set<string>([
  ...UNIT_BILLING_MATCH_KEYS_V1,
  'duration', 'generate_audio', 'reference_video_urls', 'video_urls', 'prompt', 'input',
]);

type NamedFields = Array<[name: string, value: unknown]>;

/** Why a seller serves no service for a request body. `code` and `message` are what the buyer is answered. */
export interface ServiceRefusal {
  code:
    /** The body names no service: no `service` or `model` field, or not a JSON object or form. */
    | 'model_required'
    /** `service` and `model` disagree, or a service field is spelled or written a way readers read differently. */
    | 'ambiguous_service'
    /** A top-level field selects an upstream model beside the billed one. */
    | 'unsupported_model_selector'
    /** A top-level JSON key, a service field or a multipart billing field appears more than once. */
    | 'repeated_field'
    /** A multipart field billing prices by is not one short plain text value under its plain name. */
    | 'invalid_billing_field'
    /** A multipart body is not written the plain way form encoders write it. */
    | 'unsupported_multipart_body'
    /** The request has more than one Content-Type header. */
    | 'ambiguous_content_type';
  message: string;
}

/** The one service a request body names and the format it was read in, or why it names none. */
export type RequestBodyService =
  | { service: string; format: 'json' | 'multipart' }
  | { service: null; refusal: ServiceRefusal };

const refuse = (code: ServiceRefusal['code'], message: string): { service: null; refusal: ServiceRefusal } =>
  ({ service: null, refusal: { code, message } });

const quote = (name: string) => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name);

const NO_SERVICE = refuse(
  'model_required',
  'Request must name one service, in a single "service" or "model" field of a JSON or standard multipart body, matching a published service.',
);

/**
 * The service a JSON or multipart request body names (`service`, else `model`),
 * exactly as sellers read it to route, price and bill the request; null when it
 * names none, carries a known upstream model selector, or unless its `service`
 * and `model` fields are written plainly and say exactly the same. A provider
 * and its upstream read the body again by their own rules, and the seller pays
 * for what they read.
 */
export function requestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): string | null {
  return readRequestBodyService(request).service;
}

/**
 * `requestBodyService` with its reasons: the format the body was read in, which is
 * the format its provider must read it in too, or the refusal to answer the buyer.
 * A body is read as a form only when its content type says `multipart/form-data`,
 * and as JSON under any other content type or none.
 */
export function readRequestBodyService(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): RequestBodyService {
  const contentTypes = Object.entries(request.headers).filter(([name]) => name.toLowerCase() === 'content-type');
  if (contentTypes.length > 1) return refuse('ambiguous_content_type', 'Request must have one Content-Type header.');
  const contentType = (contentTypes[0]?.[1] ?? '').trim();
  if (!/^multipart\/form-data/i.test(contentType)) {
    const named = jsonServiceFields(request.body);
    return Array.isArray(named) ? oneService(named, 'json') : named;
  }
  const parts = readPlainMultipartParts(request.body, contentType);
  if (!parts) {
    return refuse(
      'unsupported_multipart_body',
      'Multipart body must be written the standard way form encoders write it: one boundary, each part with one plainly named Content-Disposition header, and nothing but white space before the first part or after the last.',
    );
  }
  const services = parts.filter((part) => selectsService(part.name));
  const unreadable = services.find((part) => !part.billedText);
  if (unreadable) return refuse('ambiguous_service', `Field ${quote(unreadable.name)} must be sent as one short plain text field.`);
  // A BOM stays in the text, for the padding check to see.
  const read = oneService(services.map((part) => [part.name, new TextDecoder('utf-8', { ignoreBOM: true }).decode(part.content)]), 'multipart');
  return read.service === null ? read : billingFieldRefusal(parts) ?? read;
}

/** The one service a body's service and selector fields name, or why they name none. */
function oneService(named: NamedFields, format: 'json' | 'multipart'): RequestBodyService {
  const selector = named.find(([name]) => UPSTREAM_SELECTION_FIELD.test(name));
  if (selector) {
    return refuse('unsupported_model_selector', `Field ${quote(selector[0])} selects an upstream model, which this seller does not accept: it serves the one service named in "model".`);
  }
  const fields = new Map(named);
  if (fields.size !== named.length) {
    const repeated = named.find(([name], index) => named.findIndex(([other]) => other === name) !== index)!;
    return refuse('repeated_field', `Field ${quote(repeated[0])} must appear once.`);
  }
  const other = named.find(([name]) => !BUYER_SERVICE_FIELDS.has(name));
  if (other) {
    return refuse('ambiguous_service', `Field ${quote(other[0])} is not accepted: name the service in "model" or "service", spelled exactly so.`);
  }
  // A null `service` is a missing one, to the readers that follow too.
  if (fields.get('service') === null) fields.delete('service');
  const service = fields.get('service') ?? fields.get('model');
  const differ = refuse('ambiguous_service', '"service" and "model" must say exactly the same.');
  if (typeof service !== 'string' || service.length === 0) return fields.size > 1 ? differ : NO_SERVICE;
  if (service !== service.trim()) return refuse('ambiguous_service', 'The service name must be written without surrounding white space.');
  return [...fields.values()].every((value) => value === service) ? { service, format } : differ;
}

/** Why a form's billing inputs cannot be read one way, if they cannot. */
function billingFieldRefusal(parts: PlainMultipartPart[]): { service: null; refusal: ServiceRefusal } | undefined {
  const seen = new Set<string>();
  for (const part of parts) {
    const name = part.name.trim().toLowerCase().replace(/\[.*$/, '').trim();
    const priced = PRICED_FORM_FIELDS.has(name);
    if (!priced && !SINGLE_FORM_FIELDS.has(name)) continue;
    if (seen.has(name)) return refuse('repeated_field', `Field ${quote(name)} must appear once.`);
    if (part.name !== name) return refuse('invalid_billing_field', `Field ${quote(part.name)} must be named exactly ${quote(name)}.`);
    if (priced && !part.billedText) return refuse('invalid_billing_field', `Field ${quote(name)} must be sent as one short plain text field.`);
    seen.add(name);
  }
  return undefined;
}

/**
 * The fields of a JSON body, or the text fields of a multipart one, as sellers
 * read them to price and bill a request (multipart: the first of each name,
 * none over 4 KiB); null for any other body.
 */
export function requestBodyFields(request: Pick<SerializedHttpRequest, 'headers' | 'body'>): Record<string, unknown> | null {
  return extractRequestBodyFields(request.headers, request.body);
}

/** Every top-level field of a JSON body that names a service or selects a model, or why the body is refused. */
function jsonServiceFields(bytes: Uint8Array): NamedFields | { service: null; refusal: ServiceRefusal } {
  const body = parseJsonObject(bytes);
  if (!body) return NO_SERVICE;
  // `JSON.parse` keeps the last of a repeated key and other parsers the first, for any field.
  const seen = new Set<string>();
  for (const key of topLevelKeys(bytes)) {
    if (seen.has(key)) return refuse('repeated_field', `Field ${quote(key)} must appear once.`);
    seen.add(key);
  }
  return [...seen].filter(selectsService).map((name) => [name, body[name]]);
}

function selectsService(name: string): boolean {
  return SERVICE_FIELD.test(name) || UPSTREAM_SELECTION_FIELD.test(name);
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
