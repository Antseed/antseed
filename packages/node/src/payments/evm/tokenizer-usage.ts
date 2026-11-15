// The usage reader the tokenizer audit contract runs on-chain (`promptTokensOf` in
// `packages/contracts/verification/AntseedTokenizerUsageReader.sol`), byte for byte, so a proof is checked off-chain
// exactly as the contract will check it. A byte scanner, not JSON.parse: duplicate keys and whole-integer reads
// mirror the Solidity. Change both sides together.

/**
 * The prompt tokens a signed response body reports, read exactly as the contract does and as the buyer reads
 * usage (`extractUsage`), inside the one top-level `usage` object: one `"prompt_tokens"` is the whole input; so is
 * one `"input_tokens"` when `input_tokens_details` has `cached_tokens` (a subset). Otherwise `input_tokens` is
 * fresh only, and the cache creation and the cached input are added: the larger of
 * `prompt_tokens_details.cached_tokens` and the cache reads (`cache_read_input_tokens`, else
 * `prompt_cache_hit_tokens`). Other nested breakdowns (e.g. Responses' per-item usage) and text are ignored.
 * Null when the body has no single usage field, or when JSON.parse could read it differently: a member name with
 * an escape where usage is read, or a usage value that is neither a whole number nor null (null is absent).
 */
export function promptTokensOfBody(body: Uint8Array): number | null {
  const counts = new Map<string, number[]>();
  const record = (name: string, value: number) => {
    const values = counts.get(name);
    if (values) values.push(value);
    else counts.set(name, [value]);
  };
  let objects = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let watched = false;
  let hadEscape = false;
  let ambiguous = false;
  let inUsage = false;
  let inDetails: DetailsKey | null = null;
  const detailsSeen = new Map<DetailsKey, number>();
  let inputCached = 0;
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
        if (watched && hadEscape && body[skipSpace(body, i + 1)] === COLON) ambiguous = true;
      }
      continue;
    }
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth++;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      if (depth === 2 && inUsage) inUsage = false;
      if (depth === 3) inDetails = null;
      if (depth !== 0) depth--;
    } else if (c === QUOTE) {
      const usageObject = depth === 1 ? objectAfter(body, i, 'usage') : 0;
      if (usageObject !== 0) {
        objects++;
        inUsage = true;
        depth = 2;
        i = usageObject;
        continue;
      }
      let next = 0;
      if (depth === 2 && inUsage) {
        const details = DETAILS_KEYS.find((name) => objectAfter(body, i, name) !== 0);
        if (details) {
          detailsSeen.set(details, (detailsSeen.get(details) ?? 0) + 1);
          inDetails = details;
          depth = 3;
          i = objectAfter(body, i, details);
          continue;
        }
        const key = keyValueAt(body, i, USAGE_KEYS);
        if (key) {
          if (key.kind === 'number') record(key.name, key.value);
          if (key.kind === 'bad') ambiguous = true;
          next = key.end;
        }
      } else if (depth === 3 && inDetails === 'input_tokens_details') {
        // `extractUsage` only checks that `cached_tokens` is there, whatever its value.
        if (colonAfterKey(body, i, 'cached_tokens') !== 0) {
          inputCached++;
          next = quotedKeyEnd(body, i, 'cached_tokens');
        }
      } else if (depth === 3 && inDetails === 'prompt_tokens_details') {
        const key = keyValueAt(body, i, ['cached_tokens']);
        if (key) {
          if (key.kind === 'number') record('prompt_tokens_details.cached_tokens', key.value);
          if (key.kind === 'bad') ambiguous = true;
          next = key.end;
        }
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
  if (objects !== 1 || ambiguous) return null;
  const values = (name: string) => counts.get(name) ?? [];
  const prompt = values('prompt_tokens');
  if (prompt.length === 1) return prompt[0]!;
  const input = values('input_tokens');
  const read = values('cache_read_input_tokens');
  const creation = values('cache_creation_input_tokens');
  const hit = values('prompt_cache_hit_tokens');
  const promptCached = values('prompt_tokens_details.cached_tokens');
  if (
    prompt.length > 1 || input.length !== 1 || read.length > 1 || creation.length > 1 || hit.length > 1
    || [...detailsSeen.values()].some((n) => n > 1) || inputCached > 1 || promptCached.length > 1
  ) return null;
  if (inputCached === 1) return input[0]!;
  const separate = read[0] ?? hit[0] ?? 0;
  return input[0]! + (creation[0] ?? 0) + Math.max(promptCached[0] ?? 0, separate);
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

/** If `"name"` starts at `offset` followed by a colon, the offset after the colon; else 0. */
function colonAfterKey(body: Uint8Array, offset: number, name: string): number {
  const end = quotedKeyEnd(body, offset, name);
  if (end === 0) return 0;
  const at = skipSpace(body, end);
  return body[at] === COLON ? at + 1 : 0;
}

/** If `"name"` starts at `offset` and its value is an object, the offset of that `{`; else 0. */
function objectAfter(body: Uint8Array, offset: number, name: string): number {
  const afterColon = colonAfterKey(body, offset, name);
  if (afterColon === 0) return 0;
  const at = skipSpace(body, afterColon);
  return body[at] === OPEN_BRACE ? at : 0;
}

/**
 * One of `names` starting at `offset` as a member name, and its value: a whole number (1 to 15 digits ending the
 * member; a decimal or exponent is no token count), null, or anything else ('bad').
 */
function keyValueAt(
  body: Uint8Array,
  offset: number,
  names: readonly string[],
): { name: string; kind: 'number' | 'null' | 'bad'; value: number; end: number } | null {
  for (const name of names) {
    const afterColon = colonAfterKey(body, offset, name);
    if (afterColon === 0) continue;
    const end = quotedKeyEnd(body, offset, name);
    let at = skipSpace(body, afterColon);
    let kind: 'number' | 'null' = 'number';
    let value = 0;
    if (body[at] === 0x6e && body[at + 1] === 0x75 && body[at + 2] === 0x6c && body[at + 3] === 0x6c) {
      kind = 'null';
      at += 4;
    } else {
      let digits = 0;
      while (at < body.length && body[at]! >= 0x30 && body[at]! <= 0x39) {
        if (++digits > MAX_TOKEN_DIGITS) return { name, kind: 'bad', value: 0, end };
        value = value * 10 + (body[at]! - 0x30);
        at++;
      }
      if (digits === 0) return { name, kind: 'bad', value: 0, end };
    }
    at = skipSpace(body, at);
    if (body[at] !== COMMA && body[at] !== CLOSE_BRACE) return { name, kind: 'bad', value: 0, end };
    return { name, kind, value, end };
  }
  return null;
}

/** The offset after `"name"` when it starts at `offset`; else 0. */
function quotedKeyEnd(body: Uint8Array, offset: number, name: string): number {
  if (body[offset] !== QUOTE || offset + name.length + 2 > body.length) return 0;
  for (let j = 0; j < name.length; j++) if (body[offset + 1 + j] !== name.charCodeAt(j)) return 0;
  return body[offset + 1 + name.length] === QUOTE ? offset + name.length + 2 : 0;
}

/** JSON whitespace plus the vertical tab and form feed, as the contract skips them. */
function skipSpace(body: Uint8Array, offset: number): number {
  while (offset < body.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(body[offset]!)) offset++;
  return offset;
}
