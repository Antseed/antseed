import { KEYED_REQUEST_HEADERS, keyedRequestTailFields, type KeyedRequestTerms } from '@antseed/protocol/blind-relay';
import type { KeyedRelayReveal } from './keyed-relay-billing.js';

/** What the seller learns from a keyed request it admits. */
export interface AdmissibleKeyedRequest {
  ok: true;
  /** Bytes of the body, from the request's length (the seller counted it from the records it holds). */
  bodyLength: number;
  /** The output-token limit the body ends with, or null for none. */
  maxTokens: number | null;
  stream: boolean;
}

export type KeyedRequestCheck = AdmissibleKeyedRequest | { ok: false; reason: string };

const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*?)[ \t]*$/;

const refuse = (reason: string): KeyedRequestCheck => ({ ok: false, reason });

/**
 * Checks the parts of a keyed request the buyer revealed before the seller
 * forwards it. The seller wrote the request line, `Host`, its credential and
 * `Connection: close`; the buyer's bytes follow them. They must show:
 *
 * - the buyer's whole header block (range at offset 0): only the headers in
 *   `KEYED_REQUEST_HEADERS`, each once, a JSON content type and a
 *   `Content-Length` equal to the body's real length, so nothing the upstream
 *   charges for hides in a header and no second request follows the body;
 * - the body's end (a range running to the end of the request): exactly the
 *   fields `keyedRequestTailFields` writes, with the service's model, a token
 *   limit within the seller's cap, `"n":1`, usage in a stream, and the fields
 *   the seller pins.
 *
 * Everything else in the body (the messages, tools, other parameters) stays hidden.
 */
export function checkKeyedRequest(reveal: KeyedRelayReveal, model: string, terms: KeyedRequestTerms): KeyedRequestCheck {
  const pieces = reveal.ranges.map((range) => ({ offset: range.offset, bytes: Buffer.from(range.data, 'base64') }));
  const first = pieces.find((piece) => piece.offset === 0);
  if (!first) return refuse('the request headers were not revealed');
  // latin1 keeps one character per byte, so offsets stay byte offsets.
  const head = first.bytes.toString('latin1');
  let headerLength: number;
  let lines: string[];
  if (head.startsWith('\r\n')) {
    headerLength = 2;
    lines = [];
  } else {
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return refuse('the request headers were not revealed in full');
    headerLength = end + 4;
    lines = head.slice(0, end).split('\r\n');
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    if (!match) return refuse('the request has a malformed header line');
    const name = match[1]!.toLowerCase();
    if (!KEYED_REQUEST_HEADERS.includes(name)) return refuse(`the request carries header "${name}", which the seller does not relay`);
    if (headers.has(name)) return refuse(`the request repeats header "${name}"`);
    headers.set(name, match[2]!);
  }
  if (!/^application\/json\s*(;\s*charset="?utf-8"?)?$/i.test(headers.get('content-type') ?? '')) {
    return refuse('the request body is not declared as JSON');
  }
  const bodyLength = reveal.length - headerLength;
  const declared = headers.get('content-length') ?? '';
  if (bodyLength <= 0 || !/^\d{1,10}$/.test(declared) || Number(declared) !== bodyLength) {
    return refuse('the request\'s Content-Length is not its body\'s length');
  }

  const last = pieces.find((piece) => piece.offset + piece.bytes.length === reveal.length && piece.offset + piece.bytes.length > headerLength);
  if (!last) return refuse('the end of the request body was not revealed');
  const from = Math.max(last.offset, headerLength);
  let tail: string;
  try {
    tail = new TextDecoder('utf-8', { fatal: true }).decode(last.bytes.subarray(from - last.offset));
  } catch {
    return refuse('the end of the request body is not UTF-8');
  }
  const opener = from === headerLength ? '{' : ',';
  if (!tail.startsWith(opener) || !tail.endsWith('}') || tail.length < 2) return refuse('the request body does not end with the fields the seller checks');
  const fields = tail.slice(1, -1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(`{${fields}}`) as Record<string, unknown>;
  } catch {
    return refuse('the request body does not end with the fields the seller checks');
  }
  const limit = parsed[terms.maxTokensField];
  const maxTokens = limit === undefined ? null : limit;
  if (typeof parsed['model'] !== 'string' || typeof parsed['stream'] !== 'boolean'
    || (maxTokens !== null && !(typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0))) {
    return refuse('the request body does not end with the fields the seller checks');
  }
  const expected = keyedRequestTailFields(terms, { model: parsed['model'], maxTokens: maxTokens as number | null, stream: parsed['stream'] });
  // Byte for byte: no repeated, extra, reordered or escaped keys.
  if (fields !== expected) return refuse('the request body does not end with the fields the seller checks');
  if (parsed['model'] !== model) return refuse(`the request names model "${parsed['model']}", not "${model}"`);
  if (terms.maxTokens !== undefined && (maxTokens === null || (maxTokens as number) > terms.maxTokens)) {
    return refuse(`the request must ask for at most ${terms.maxTokens} output tokens`);
  }
  return { ok: true, bodyLength, maxTokens: maxTokens as number | null, stream: parsed['stream'] };
}

/** The prompt tokens a keyed request body may hold, for checks before it goes upstream: about four bytes a token. */
export function keyedRequestInputTokens(bodyLength: number): number {
  return Math.ceil(Math.max(0, bodyLength) / 4);
}
