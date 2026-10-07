export type ReasoningEffort = string;

export const MAX_REASONING_EFFORTS = 32;
export const MAX_REASONING_EFFORT_BYTES = 64;

// Rejects invisible or display-altering code points so labels can be shown
// verbatim: controls (C0/C1), format characters (bidi overrides, zero-width
// characters, BOM, soft hyphen), lone surrogates, and line/paragraph separators.
const DISALLOWED_REASONING_EFFORT_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && !DISALLOWED_REASONING_EFFORT_CHARS.test(value)
    && new TextEncoder().encode(value).length <= MAX_REASONING_EFFORT_BYTES;
}

export function isReasoningEffortList(value: unknown): value is ReasoningEffort[] {
  return Array.isArray(value) && value.length <= MAX_REASONING_EFFORTS
    && Array.from(value).every(isReasoningEffort) && new Set(value).size === value.length;
}
