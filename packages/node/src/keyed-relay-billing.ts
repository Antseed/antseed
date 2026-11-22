import { parseResponseUsage, type ResponseUsage } from './utils/response-usage.js';

/** A response range the buyer revealed to the seller over the keyed relay. */
export interface RevealedRange {
  /** Byte offset in the raw HTTP response (status line, headers, body with its framing). */
  offset: number;
  /** The bytes, base64. */
  data: string;
}

export interface KeyedRelayReveal {
  /** Length of the whole raw response, which the seller counted from the records it relayed. */
  length: number;
  ranges: RevealedRange[];
}

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

/**
 * Whether the model an upstream reports is the one the service maps to,
 * allowing the forms upstreams answer with: a dated snapshot
 * (`gpt-4o-mini-2024-07-18`) or a vendor prefix (`openai/gpt-4o-mini`).
 */
export function keyedRelayModelMatches(reported: string, expected: string): boolean {
  const a = reported.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  const tail = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
  return a === b || a.startsWith(`${b}-`) || tail(a) === tail(b) || tail(a).startsWith(`${tail(b)}-`);
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
 * about four bytes a token. The buyer signs the charge only up to its
 * tolerance over the usage it read itself.
 */
export function keyedRelayEstimatedUsage(bytesUp: number, bytesDown: number): ResponseUsage {
  const inputTokens = Math.ceil(Math.max(0, bytesUp) / 4);
  const outputTokens = Math.ceil(Math.max(0, bytesDown) / 4);
  return { inputTokens, freshInputTokens: inputTokens, cachedInputTokens: 0, outputTokens };
}
