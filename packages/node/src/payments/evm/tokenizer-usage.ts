// Reads the input tokens a seller signed, from the response bytes its ResponseAuth covers. The verifier's
// tokenizer pre-check judges a seller on these counts, so the reader is strict: a byte scanner, not JSON.parse, that
// gives no count wherever two JSON readers could disagree on the bytes (repeated members, escaped member names,
// values that are not whole numbers).

/**
 * The prompt tokens a signed response body reports, read as the buyer reads
 * usage (`extractUsage`), inside the one top-level `usage` object: one `"prompt_tokens"` is the whole input; so is
 * one `"input_tokens"` when `input_tokens_details` has `cached_tokens` (a subset). Otherwise `input_tokens` is
 * fresh only, and the cache creation and the cached input are added: the larger of
 * `prompt_tokens_details.cached_tokens` and the cache reads (`cache_read_input_tokens`, else
 * `prompt_cache_hit_tokens`). Other nested breakdowns (e.g. Responses' per-item usage) and text are ignored.
 * Null when the body has no usage to read, or when JSON.parse could read it differently: a member the reader looks
 * for twice (whatever its values; JSON.parse keeps the last), a member name with an escape where usage is read, or
 * a usage value that is neither a whole number nor null (null is absent).
 */
export function promptTokensOfBody(body: Uint8Array): number | null {
  const usage: Usage = { seen: new Set(), numbers: new Map(), entered: false, ambiguous: false };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let watched = false;
  let hadEscape = false;
  let inUsage = false;
  let inDetails: DetailsKey | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === BACKSLASH) {
        escaped = true;
        hadEscape = true;
      } else if (c === QUOTE) {
        inString = false;
        // An escaped member name may decode to a key this reader looks for.
        if (watched && hadEscape && body[skipSpace(body, i + 1)] === COLON) usage.ambiguous = true;
      }
      continue;
    }
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth++;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      if (depth === 2) inUsage = false;
      if (depth === 3) inDetails = null;
      if (depth !== 0) depth--;
    } else if (c === QUOTE) {
      // Where to go on from when a member the reader looks for starts here; else 0.
      let next = 0;
      if (depth === 1) {
        next = enterObject(body, i, 'usage', usage);
        if (next !== 0) {
          depth = 2;
          inUsage = true;
          usage.entered = true;
        }
      } else if (depth === 2 && inUsage) {
        for (const details of DETAILS_KEYS) {
          next = enterObject(body, i, details, usage);
          if (next === 0) continue;
          inDetails = details;
          depth = 3;
          break;
        }
        if (next === 0) next = readUsageKey(body, i, usage);
      } else if (depth === 3 && inDetails !== null) {
        next = readNumber(body, i, 'cached_tokens', `${inDetails}.cached_tokens`, usage);
      }
      if (next !== 0) {
        i = next - 1;
      } else {
        inString = true;
        watched = depth === 1 || (depth === 2 && inUsage) || (depth === 3 && inDetails !== null);
        hadEscape = false;
      }
    }
  }
  if (!usage.entered || usage.ambiguous) return null;
  const prompt = usage.numbers.get('prompt_tokens');
  if (prompt !== undefined) return prompt;
  const input = usage.numbers.get('input_tokens');
  if (input === undefined) return null;
  // `extractUsage` only checks that `cached_tokens` is there, so null counts too.
  if (usage.seen.has('input_tokens_details.cached_tokens')) return input;
  const separate = usage.numbers.get('cache_read_input_tokens') ?? usage.numbers.get('prompt_cache_hit_tokens') ?? 0;
  const cached = Math.max(usage.numbers.get('prompt_tokens_details.cached_tokens') ?? 0, separate);
  return input + (usage.numbers.get('cache_creation_input_tokens') ?? 0) + cached;
}

/**
 * What one pass over a response found where usage is read. `seen` holds the members met, whatever their value: a
 * second one makes the usage ambiguous. `numbers` holds those whose value is a whole number.
 */
interface Usage {
  seen: Set<string>;
  numbers: Map<string, number>;
  /** Whether the top-level `usage` is an object. */
  entered: boolean;
  ambiguous: boolean;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const USAGE_KEYS = ['prompt_tokens', 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens'];
const DETAILS_KEYS = ['input_tokens_details', 'prompt_tokens_details'] as const;
type DetailsKey = (typeof DETAILS_KEYS)[number];
const MAX_TOKEN_DIGITS = 15;

/** Reads the token count starting at `offset` directly inside `usage`, if it is one; the offset after its name, else 0. */
function readUsageKey(body: Uint8Array, offset: number, usage: Usage): number {
  for (const name of USAGE_KEYS) {
    const end = readNumber(body, offset, name, name, usage);
    if (end !== 0) return end;
  }
  return 0;
}

/**
 * If the member `name` starts at `offset`: marks `slot` seen, keeps its value when it is a whole number (1 to 15
 * digits ending the member; a decimal or exponent is no token count) and makes the usage ambiguous when it is
 * anything else but null. Returns the offset after the name; 0 when `name` is not there.
 */
function readNumber(body: Uint8Array, offset: number, name: string, slot: string, usage: Usage): number {
  let at = colonAfterKey(body, offset, name);
  if (at === 0) return 0;
  markSeen(usage, slot);
  at = skipSpace(body, at);
  const isNull = body[at] === 0x6e && body[at + 1] === 0x75 && body[at + 2] === 0x6c && body[at + 3] === 0x6c;
  let value = 0;
  let digits = 0;
  if (isNull) {
    at += 4;
  } else {
    while (at < body.length && body[at]! >= 0x30 && body[at]! <= 0x39 && digits <= MAX_TOKEN_DIGITS) {
      value = value * 10 + (body[at]! - 0x30);
      digits++;
      at++;
    }
  }
  at = skipSpace(body, at);
  const endsMember = body[at] === COMMA || body[at] === CLOSE_BRACE;
  if (!endsMember || (!isNull && (digits === 0 || digits > MAX_TOKEN_DIGITS))) usage.ambiguous = true;
  else if (!isNull) usage.numbers.set(slot, value);
  return offset + name.length + 2;
}

/**
 * If the member `name` starts at `offset`: marks it seen and, when its value is an object, returns the offset
 * after that `{`. 0 when `name` is not there or its value is no object.
 */
function enterObject(body: Uint8Array, offset: number, name: string, usage: Usage): number {
  const afterColon = colonAfterKey(body, offset, name);
  if (afterColon === 0) return 0;
  markSeen(usage, name);
  const at = skipSpace(body, afterColon);
  return body[at] === OPEN_BRACE ? at + 1 : 0;
}

/** If `"name"` starts at `offset` followed by a colon, the offset after the colon; else 0. */
function colonAfterKey(body: Uint8Array, offset: number, name: string): number {
  const end = offset + name.length + 2;
  if (body[offset] !== QUOTE || end > body.length || body[end - 1] !== QUOTE) return 0;
  for (let j = 0; j < name.length; j++) if (body[offset + 1 + j] !== name.charCodeAt(j)) return 0;
  const at = skipSpace(body, end);
  return body[at] === COLON ? at + 1 : 0;
}

function markSeen(usage: Usage, slot: string): void {
  if (usage.seen.has(slot)) usage.ambiguous = true;
  usage.seen.add(slot);
}

/** JSON whitespace plus the vertical tab and form feed, as the contract skips them. */
function skipSpace(body: Uint8Array, offset: number): number {
  while (offset < body.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(body[offset]!)) offset++;
  return offset;
}
