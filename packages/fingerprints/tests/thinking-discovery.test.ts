import { describe, expect, it } from 'vitest';
import {
  THINKING_FALLBACK_MAX_TOKENS,
  discoverThinkingSuppression,
  isKbfTokenLimitFinishReason,
  kbfResponseFinishReason,
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

  it('skips a strategy whose reply reasons in the open, as GLM-5.3 on DeepInfra does with effort none', async () => {
    // effort "none" turns the thinking channel off (0 reasoning tokens, all ten answers parse),
    // but the model reasons in its reply; effort "minimal" keeps the reasoning hidden.
    const reasoned = ANSWERS.split('\n')
      .map((line) => `${line.slice(0, line.indexOf(' '))} Let me recall this value from memory: it is ${line.slice(line.indexOf(' ') + 1)}.`)
      .join('\n');
    const probe: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-none'
      ? { ok: true, content: `Let me work through each of these.\n\n${reasoned}`, reasoningTokens: 0 }
      : { ok: true, content: ANSWERS, reasoningTokens: 0 };
    const logs: string[] = [];
    const result = await discoverThinkingSuppression({ model: 'glm-5.3', label: 'seller', supportsPrefill: true, probe, log: (line) => logs.push(line) });
    expect(result.strategy).toBe('reasoning-effort-minimal');
    expect(result.attempts[0]).toMatchObject({ strategy: 'reasoning-effort-none', validAnswers: 10, reasoningTokens: 0, answersOnly: false });
    expect(logs.join('\n')).toContain('reasoned in its reply');
  });

  it('skips a strategy whose reply stops at the token limit, and a cut-off bare-expanded fails', async () => {
    const cutOff: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-none'
      ? { ok: true, content: ANSWERS, reasoningTokens: 0, truncated: true }
      : { ok: true, content: ANSWERS, reasoningTokens: 0 };
    expect((await discoverThinkingSuppression({ model: 'm', label: 'e', supportsPrefill: false, probe: cutOff })).strategy)
      .toBe('reasoning-effort-minimal');
    const alwaysCutOff: ThinkingDiscoveryProbe = async () => ({ ok: true, content: ANSWERS, reasoningTokens: 0, truncated: true });
    await expect(discoverThinkingSuppression({ model: 'm', label: 'e', supportsPrefill: false, probe: alwaysCutOff }))
      .rejects.toThrow(/hit token limit/);
  });

  it('recognises token-limit finish reasons across APIs', () => {
    expect(isKbfTokenLimitFinishReason('length')).toBe(true);
    expect(isKbfTokenLimitFinishReason('max_tokens')).toBe(true);
    expect(isKbfTokenLimitFinishReason('incomplete')).toBe(true);
    expect(isKbfTokenLimitFinishReason('stop')).toBe(false);
    expect(isKbfTokenLimitFinishReason(null)).toBe(false);
    expect(kbfResponseFinishReason(JSON.stringify({ choices: [{ finish_reason: 'length' }] }))).toBe('length');
    expect(kbfResponseFinishReason(JSON.stringify({ stop_reason: 'max_tokens' }))).toBe('max_tokens');
    expect(kbfResponseFinishReason('not json')).toBeNull();
  });
});
