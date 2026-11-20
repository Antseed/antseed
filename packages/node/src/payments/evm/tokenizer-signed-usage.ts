import { decodeHttpResponse } from '@antseed/protocol/request-codec';
import { promptTokensOfBody } from './tokenizer-usage.js';

/** What the verifier's tokenizer pre-check reads from one response a seller signed. */
export interface SignedInputUsage {
  /**
   * The input tokens the seller signed; null when the response is not a 200, cannot be decoded, has a body that
   * is not one JSON object, or reports no usage `promptTokensOfBody` can read. A count of zero is no count:
   * gateways report zero usage for replies that were cut off before the upstream sent any.
   */
  inputTokens: number | null;
  /**
   * True when the usage reports cached input (a cache read or a cache write above zero), whether or not it has a
   * count. Upstream prompt caches move with every request, and gateways differ in whether a count includes them,
   * so such a count says nothing reliable about the text it was signed for.
   */
  cachedInput: boolean;
  /**
   * The cache members the usage reports above zero, by their path in `usage` (`prompt_tokens_details.cached_tokens`,
   * `cache_read_input_tokens`); empty when it reports none. Two answers whose members are equal report the same
   * cached amount: the cache then cancels out of their difference, whether a gateway counts it in or leaves it out.
   */
  cache: Readonly<Record<string, number>>;
}

/** Reads a seller's signed input usage from the response preimage its ResponseAuth covers (binary HTTP codec). */
export function signedResponseInputUsage(responsePreimage: Uint8Array): SignedInputUsage {
  let response: ReturnType<typeof decodeHttpResponse>;
  try {
    response = decodeHttpResponse(responsePreimage);
  } catch {
    return NO_USAGE;
  }
  return response.statusCode === 200 ? responseBodyInputUsage(response.body) : NO_USAGE;
}

const NO_USAGE: SignedInputUsage = Object.freeze({ inputTokens: null, cachedInput: false, cache: Object.freeze({}) });

/**
 * The input usage a response body reports: the same reading for a seller's signed response and for the answer of
 * the reference endpoint it is compared with. The body must be one JSON object and nothing else: a truncated
 * body, an event-stream line, a byte-order mark or text after the object has no count, though the byte scanner
 * (`promptTokensOfBody`) alone would find one in it. An error sent with status 200 (a top-level `error` and no
 * first choice, as gateways send once the status is out) has no count either, whatever usage it carries.
 */
export function responseBodyInputUsage(body: Uint8Array): SignedInputUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    return NO_USAGE;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_USAGE;
  const envelope = parsed as { error?: unknown; choices?: unknown };
  const first: unknown = Array.isArray(envelope.choices) ? envelope.choices[0] : undefined;
  const answered = typeof first === 'object' && first !== null;
  if (envelope.error !== undefined && envelope.error !== null && !answered) return NO_USAGE;
  const tokens = promptTokensOfBody(body);
  const cache = cacheMembers((parsed as { usage?: unknown }).usage);
  return { inputTokens: tokens !== null && tokens > 0 ? tokens : null, cachedInput: Object.keys(cache).length > 0, cache };
}

/** The cache members above zero of the top-level `usage` and of its detail objects, by path. */
function cacheMembers(usage: unknown): Readonly<Record<string, number>> {
  const found: Record<string, number> = {};
  const walk = (value: unknown, depth: number, prefix: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, member] of Object.entries(value)) {
      if (/cache/i.test(key)) {
        if (typeof member === 'number' && member > 0) found[`${prefix}${key}`] = member;
      } else if (depth < 1) {
        walk(member, depth + 1, `${prefix}${key}.`);
      }
    }
  };
  walk(usage, 0, '');
  return Object.freeze(found);
}
