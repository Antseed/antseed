import type { KeyedRelayEvent, KeyedRelayRange } from '@antseed/keyed-relay';
import { parseResponseUsage, type ResponseUsage } from './utils/response-usage.js';

/** A response range the buyer revealed to the seller over the keyed relay: its offset in the raw HTTP response, and its bytes. */
export type RevealedRange = KeyedRelayRange;

/** A reveal as the sidecar reports it: the ranges, and the length of the whole raw response the seller counted from the records it relayed. */
export type KeyedRelayReveal = Pick<Extract<KeyedRelayEvent, { type: 'revealed' }>, 'length' | 'ranges'>;

/** What the seller learns from a reveal: the status code, the usage and the model that answered, each when shown. */
export interface KeyedRelayBilling {
  statusCode: number | null;
  usage: ResponseUsage | null;
  /** The `model` of the last stream event in the tail: the model the upstream ran. */
  model: string | null;
  /** Whether the tail is a stream (`data:` events) or a JSON body (`"usage":`); null when none was shown. */
  streamed: boolean | null;
}

/** The `model` field of the last stream event in `tail` that has one. */
function lastStreamModel(tail: string): string | null {
  let model: string | null = null;
  for (const line of tail.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data.startsWith('{')) continue;
    try {
      const value = (JSON.parse(data) as { model?: unknown }).model;
      if (typeof value === 'string' && value) model = value;
    } catch {
      // A line split by the reveal's start or not JSON.
    }
  }
  return model;
}

/** The end of a model id that names one snapshot of it: a date (`-2024-07-18`, `-20240718`, `-0718`) or `-latest`. */
const MODEL_SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4}|latest)$/;

/**
 * Whether the model an upstream reports is the one the service maps to,
 * allowing the forms upstreams answer with: a dated snapshot
 * (`gpt-4o-mini-2024-07-18`) or a vendor prefix (`openai/gpt-4o-mini`), and
 * the undated name when the service names the snapshot.
 */
export function keyedRelayModelMatches(reported: string, expected: string): boolean {
  const a = reported.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  const tail = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
  if (a === b || a.startsWith(`${b}-`) || tail(a) === tail(b) || tail(a).startsWith(`${tail(b)}-`)) return true;
  // The service itself names a snapshot (or `-latest`): the same name without that suffix is the same model.
  const undated = tail(b).replace(MODEL_SNAPSHOT_SUFFIX, '');
  return undated !== tail(b) && (tail(a) === undated || tail(a).startsWith(`${undated}-`));
}

/** Drops HTTP/1.1 chunked-transfer framing (size lines) from a response tail. */
function dechunk(text: string): string {
  return text
    .replace(/^[0-9a-fA-F]+\r\n/, '')
    .replace(/\r\n[0-9a-fA-F]+\r\n/g, '')
    .replace(/\r\n(0\r\n)?\r\n?$/, '');
}

/**
 * Reads the status line and the usage figure from what the buyer revealed.
 *
 * - The status line is the range at offset 0.
 * - The usage is in a range that runs to the end of the response and starts
 *   at a stream event (`data:`) or at the body's `"usage":` key. A raw
 *   `data:` line or `"usage":` key cannot come from model output, which the
 *   upstream escapes inside JSON strings, and running to the end means the
 *   last usage figure is always included.
 */
export function readKeyedRelayReveal(reveal: KeyedRelayReveal): KeyedRelayBilling {
  const decoder = new TextDecoder();
  let statusCode: number | null = null;
  let usage: ResponseUsage | null = null;
  let model: string | null = null;
  let streamed: boolean | null = null;
  for (const range of reveal.ranges) {
    const bytes = Uint8Array.from(Buffer.from(range.data, 'base64'));
    const text = decoder.decode(bytes);
    if (range.offset === 0) {
      const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(text);
      if (match) statusCode = Number(match[1]);
    }
    if (range.offset > 0 && range.offset + bytes.length === reveal.length) {
      const tail = dechunk(text);
      let candidate: ResponseUsage | null = null;
      if (tail.startsWith('data:')) {
        streamed = true;
        candidate = parseResponseUsage(new TextEncoder().encode(tail));
        model = lastStreamModel(tail);
      } else if (tail.startsWith('"usage":')) {
        streamed = false;
        candidate = parseResponseUsage(new TextEncoder().encode(`{${tail}`));
      }
      if (candidate && candidate.inputTokens + candidate.outputTokens > 0) usage = candidate;
    }
  }
  return { statusCode, usage, model, streamed };
}

/**
 * The usage a keyed-relay request is billed by when the buyer revealed none
 * for a delivered answer: an estimate from the bytes relayed each way, at
 * about four bytes a token, for a request no payment check admitted. The
 * buyer signs the charge only up to its tolerance over its own price for the
 * answer.
 */
export function keyedRelayEstimatedUsage(bytesUp: number, bytesDown: number): ResponseUsage {
  const inputTokens = Math.ceil(Math.max(0, bytesUp) / 4);
  const outputTokens = Math.ceil(Math.max(0, bytesDown) / 4);
  return { inputTokens, freshInputTokens: inputTokens, cachedInputTokens: 0, outputTokens };
}

/**
 * The usage an admitted request is billed by when the buyer revealed none for
 * a delivered answer. Both figures stay within the request the seller checked:
 * the input it estimated from the body's length, and the answer's plaintext
 * length (`responseLength`: status line, headers, body with its framing) at
 * about four bytes a token, never over the output limit the request ended
 * with. The bytes relayed would overstate it many times: they count TLS
 * record overhead and a stream's event framing. The buyer holds all three
 * figures and prices such an answer by this same function
 * (`recordRelayedCost`), so it signs what the seller charges.
 */
export function keyedRelayUnrevealedUsage(inputTokens: number, responseLength: number, maxOutputTokens: number | null): ResponseUsage {
  const answered = Math.ceil(Math.max(0, responseLength) / 4);
  const outputTokens = maxOutputTokens === null ? answered : Math.min(answered, maxOutputTokens);
  return { inputTokens, freshInputTokens: inputTokens, cachedInputTokens: 0, outputTokens };
}
