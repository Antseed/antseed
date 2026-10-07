import { describe, expect, it } from 'vitest';
import { isReasoningEffort, isReasoningEffortList } from './reasoning.js';
import { validateServiceCapabilityFields } from './peer-metadata.js';

describe('seller-defined reasoning capabilities', () => {
  it.each(['adaptive', 'deep-analysis', 'vendor.v2', '自動', 'x'.repeat(64)])('accepts opaque label %s', (effort) => {
    expect(isReasoningEffort(effort)).toBe(true);
    expect(validateServiceCapabilityFields({ reasoningEfforts: [effort] })).toEqual([]);
  });

  it.each([null, undefined, 1, {}, '', ' ', ' high', 'high ', 'hi\nthere', '\ud800', 'hi\u0085', 'a\u009fb', 'high\u202e', 'lo\u200bw', 'lo\u200dw', '\ufeffhigh', 'lo\u00adw', 'a\u2028b', 'a\u2029b', 'x'.repeat(65), '深'.repeat(22)])('rejects malformed label %j', (effort) => {
    expect(isReasoningEffort(effort)).toBe(false);
    expect(isReasoningEffortList([effort])).toBe(false);
  });

  it('bounds advertised choices without fixing their vocabulary', () => {
    const efforts = Array.from({ length: 32 }, (_, index) => `custom-${index}`);
    expect(isReasoningEffortList(efforts)).toBe(true);
    expect(isReasoningEffortList([...efforts, 'extra'])).toBe(false);
    expect(isReasoningEffortList(['adaptive', 'adaptive'])).toBe(false);
    expect(isReasoningEffortList(Array(1))).toBe(false);
    expect(isReasoningEffortList([])).toBe(true);
    expect(validateServiceCapabilityFields({ reasoning: false, reasoningEfforts: [] })).toEqual([]);
    expect(validateServiceCapabilityFields({ reasoning: false, reasoningEfforts: ['off'] })).not.toEqual([]);
  });
});
