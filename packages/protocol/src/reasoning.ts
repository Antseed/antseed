/** A seller's own reasoning effort label, such as "low" or "adaptive". No protocol-wide enum. */
export type ReasoningEffort = string;

export const MAX_REASONING_EFFORTS = 32;

/** A label: 1 to 64 visible ASCII characters (`!` to `~`), so no spaces and no other scripts. */
export const REASONING_EFFORT_PATTERN = /^[\x21-\x7e]{1,64}$/;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_PATTERN.test(value);
}

export function isReasoningEffortList(value: unknown): value is ReasoningEffort[] {
  return Array.isArray(value) && value.length <= MAX_REASONING_EFFORTS
    && Array.from(value).every(isReasoningEffort) && new Set(value).size === value.length;
}
