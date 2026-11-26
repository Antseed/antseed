// The probe guard of the verifier's tokenizer pre-check: which text a seller's token count may be compared on.
// Honest inference engines serving one model (llama.cpp, Hugging Face tokenizers, harmony, tekken) count
// control-token text, unnormalized Unicode, non-ASCII capitals and recently assigned code points differently, so
// the compared text is limited to what they all count alike. An allowlist that fails closed.

/**
 * Code points above ASCII a probe's B may use: sorted, disjoint, inclusive. A few Latin-1 symbols and lowercase
 * letters; Greek, Cyrillic and Armenian lowercase; Hebrew and Arabic letters without marks; Georgian; Ethiopic
 * syllables; common typographic punctuation and the euro sign; CJK punctuation, kana, CJK ideographs and Hangul
 * syllables; emoji without skin tones. No combining marks, non-ASCII capitals, nothing NFC changes, nothing
 * assigned after Unicode 8.
 */
export const PROBE_GUARD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xa3, 0xa3], [0xa5, 0xa5], [0xa7, 0xa7], [0xa9, 0xa9], [0xb0, 0xb1], [0xd7, 0xd7], [0xdf, 0xff],
  [0x3b1, 0x3c9], [0x430, 0x44f], [0x451, 0x451], [0x561, 0x586], [0x5d0, 0x5ea], [0x621, 0x63a], [0x641, 0x64a],
  [0x10d0, 0x10fa], [0x1200, 0x1248],
  [0x2013, 0x2014], [0x2018, 0x2019], [0x201c, 0x201d], [0x2022, 0x2022], [0x2026, 0x2026], [0x20ac, 0x20ac],
  [0x3001, 0x3002], [0x300c, 0x300d], [0x3041, 0x3096], [0x30a1, 0x30fa], [0x30fc, 0x30fc],
  [0x4e00, 0x9fa5], [0xac00, 0xd7a3],
  [0x1f300, 0x1f3fa], [0x1f400, 0x1f64f], [0x1f680, 0x1f6c5],
];

/**
 * Whether a probe may measure `b` (UTF-8 bytes, or text): every honest engine of the audited model families counts
 * it alike. It starts with exactly one space, is valid shortest-form UTF-8, every code point is printable ASCII or
 * in `PROBE_GUARD_RANGES`, and no ASCII sequence can open a control token (`<` before `|`, `/`, `_`, `!` or a
 * letter; `[` before `/` or a letter; `'` before a letter; none of the three at the end).
 */
export function isSafeProbe(b: Uint8Array | string): boolean {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  if (bytes.length < 2 || bytes[0] !== SPACE || bytes[1] === SPACE) return false;
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i]!;
    if (c < 0x80) {
      if (c < 0x20 || c === 0x7f || opensControlToken(c, bytes[i + 1] ?? 0)) return false;
      i++;
      continue;
    }
    const decoded = decode(bytes, i);
    if (!decoded || !inRanges(decoded.codePoint)) return false;
    i += decoded.size;
  }
  return true;
}

const SPACE = 0x20;

function opensControlToken(c: number, next: number): boolean {
  const letter = (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
  if (c === 0x3c) return next === 0 || letter || next === 0x7c || next === 0x2f || next === 0x5f || next === 0x21; // <
  if (c === 0x5b) return next === 0 || letter || next === 0x2f; // [
  if (c === 0x27) return next === 0 || letter; // '
  return false;
}

function decode(bytes: Uint8Array, i: number): { codePoint: number; size: number } | null {
  const lead = bytes[i]!;
  let size: number;
  let codePoint: number;
  let min: number;
  if ((lead & 0xe0) === 0xc0) [size, codePoint, min] = [2, lead & 0x1f, 0x80];
  else if ((lead & 0xf0) === 0xe0) [size, codePoint, min] = [3, lead & 0x0f, 0x800];
  else if ((lead & 0xf8) === 0xf0) [size, codePoint, min] = [4, lead & 0x07, 0x10000];
  else return null;
  if (i + size > bytes.length) return null;
  for (let k = 1; k < size; k++) {
    const next = bytes[i + k]!;
    if ((next & 0xc0) !== 0x80) return null;
    codePoint = codePoint * 64 + (next & 0x3f);
  }
  return codePoint >= min ? { codePoint, size } : null;
}

function inRanges(codePoint: number): boolean {
  let low = 0;
  let high = PROBE_GUARD_RANGES.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const [start, end] = PROBE_GUARD_RANGES[mid]!;
    if (codePoint < start) high = mid;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}
