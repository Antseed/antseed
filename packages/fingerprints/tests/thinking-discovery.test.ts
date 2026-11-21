import { describe, expect, it } from 'vitest';
import {
  THINKING_DISCOVERY_RULE,
  THINKING_FALLBACK_MAX_TOKENS,
  countDiscoveryAnswers,
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

  it('kbf-discovery-least-reasoning-v1: when nothing turns thinking off, the strategy that thought least is used, not bare', async () => {
    expect(THINKING_DISCOVERY_RULE).toBe('kbf-discovery-least-reasoning-v1');
    // GLM 5.3 on its maker's endpoint in November 2026: effort none refused, every other setting accepted but still thinking.
    const thinking: Record<string, number> = { 'reasoning-effort-minimal': 70, 'disable-thinking': 200, 'enable-thinking-false': 197, prefill: 93, bare: 295 };
    const glm: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-none'
      ? { ok: false, status: 400, failure: 'reasoning effort none is not supported' }
      : { ok: true, content: ANSWERS, reasoningTokens: thinking[strategy] ?? 0 };
    const logs: string[] = [];
    const result = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: glm, log: (line) => logs.push(line) });
    expect([result.strategy, result.leastReasoning, result.overrides]).toEqual(['reasoning-effort-minimal', true, { reasoning: { effort: 'minimal' } }]);
    expect(result.attempts.map((attempt) => attempt.strategy)).toEqual(['reasoning-effort-none', 'reasoning-effort-minimal', 'disable-thinking', 'enable-thinking-false', 'prefill', 'bare']);
    expect(logs.at(-1)).toMatch(/'reasoning-effort-minimal' thought least \(reasoning_tokens=70, against 295 with 'bare'\)/);
    // A strategy with no reasoning tokens still wins outright, as in the reference code.
    const off: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: strategy === 'disable-thinking' ? 0 : 50 });
    const offResult = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: off });
    expect([offResult.strategy, offResult.leastReasoning]).toEqual(['disable-thinking', undefined]);
  });

  it('kbf-discovery-least-reasoning-v1: bare stays when it thought least; on a tie the earlier strategy is used', async () => {
    const bareLeast: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: strategy === 'bare' ? 40 : 300 });
    const kept = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: bareLeast });
    expect([kept.strategy, kept.leastReasoning]).toEqual(['bare', undefined]);
    const tie: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: strategy === 'bare' ? 500 : strategy === 'prefill' || strategy === 'disable-thinking' ? 60 : 300 });
    const tied = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: tie });
    expect(tied.strategy).toBe('disable-thinking');
  });

  it('kbf-discovery-least-reasoning-v1: a strategy that answered while thinking a little beats bare with fifty times the tokens', async () => {
    // Bare stops at the token limit; minimal answered cleanly with some reasoning: bare-expanded is never asked.
    const probe: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'bare'
      ? { ok: true, content: ANSWERS, reasoningTokens: 700, truncated: true }
      : strategy === 'reasoning-effort-minimal'
        ? { ok: true, content: ANSWERS, reasoningTokens: 120 }
        : { ok: true, content: '', reasoningTokens: 800 };
    const result = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe });
    expect([result.strategy, result.leastReasoning]).toEqual(['reasoning-effort-minimal', true]);
    expect(result.attempts.map((attempt) => attempt.strategy)).not.toContain('bare-expanded');
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

  it('does not accept a strategy whose answers are only inside a <think> block', async () => {
    // The audit strips <think> before parsing, so these answers would all be lost there.
    const insideThink = `<think>${ANSWERS}</think>`;
    expect(countDiscoveryAnswers(insideThink)).toBe(0);
    expect(countDiscoveryAnswers(`<think>scratch</think>\n${ANSWERS}`)).toBe(10);
    const probe: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-minimal'
      ? { ok: true, content: ANSWERS, reasoningTokens: 0 }
      : { ok: true, content: insideThink, reasoningTokens: 0 };
    const result = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: false, probe });
    expect(result.strategy).toBe('reasoning-effort-minimal');
    expect(result.attempts[0]!.validAnswers).toBe(0);
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
