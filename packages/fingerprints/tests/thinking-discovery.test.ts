import { describe, expect, it } from 'vitest';
import {
  THINKING_FALLBACK_MAX_TOKENS,
  discoverThinkingSuppression,
  reportedReasoningTokens,
  stripKbfThinkBlocks,
  type ThinkingDiscoveryProbe,
} from '../src/index.js';

const ANSWERS = '(1) 78.37\n(2) 79\n(3) 299792458\n(4) 1538\n(5) 206\n(6) 12\n(7) 100\n(8) 9.81\n(9) 8\n(10) 0';

describe('thinking discovery helpers', () => {
  it('reads usage.completion_tokens_details.reasoning_tokens, 0 when absent or unreadable', () => {
    expect(reportedReasoningTokens(JSON.stringify({ usage: { completion_tokens_details: { reasoning_tokens: 1600 } } }))).toBe(1600);
    expect(reportedReasoningTokens(JSON.stringify({ usage: { completion_tokens: 20 } }))).toBe(0);
    expect(reportedReasoningTokens('not json')).toBe(0);
  });

  it('strips closed <think> blocks like the reference code, keeping the answer after them', () => {
    expect(stripKbfThinkBlocks('<think>(1) 5\n(2) 6</think>\n(1) 1\n(2) 2')).toBe('(1) 1\n(2) 2');
    expect(stripKbfThinkBlocks('(1) 1')).toBe('(1) 1');
  });

  it('falls back to bare with 50x the budget when every strategy is accepted but ignored', async () => {
    const probe: ThinkingDiscoveryProbe = async ({ maxTokens }) => maxTokens < THINKING_FALLBACK_MAX_TOKENS
      ? { ok: true, content: '', reasoningTokens: maxTokens }
      : { ok: true, content: ANSWERS, reasoningTokens: 3000 };
    const result = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: false, probe });
    expect(result.strategy).toBe('bare-expanded');
    expect(result.maxTokens).toBe(THINKING_FALLBACK_MAX_TOKENS);
    expect(result.attempts.map((attempt) => attempt.strategy)).not.toContain('prefill');
  });
});
