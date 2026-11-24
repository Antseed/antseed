import { describe, expect, it } from 'vitest';
import {
  THINKING_DISCOVERY_RULE,
  THINKING_DISCOVERY_RULES,
  THINKING_DISCOVERY_STRATEGIES,
  THINKING_FALLBACK_MAX_TOKENS,
  THINKING_REFERENCE_EQUIVALENTS,
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
    // GLM 5.3 on its maker's endpoint in November 2026: effort none refused, every other setting accepted but still thinking.
    const thinking: Record<string, number> = { 'reasoning-effort-minimal': 70, 'disable-thinking': 200, 'enable-thinking-false': 197, prefill: 93, bare: 295 };
    const glm: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-none'
      ? { ok: false, status: 400, failure: 'reasoning effort none is not supported' }
      : { ok: true, content: ANSWERS, reasoningTokens: thinking[strategy] ?? 0 };
    const logs: string[] = [];
    const result = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: glm, log: (line) => logs.push(line) });
    expect([result.strategy, result.overrides]).toEqual(['reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }]);
    // The result holds only what is stored: the strategy, its request and the attempts (which show why it was chosen).
    expect(Object.keys(result).sort()).toEqual(['attempts', 'overrides', 'strategy']);
    expect(result.attempts.map((attempt) => attempt.strategy)).toEqual(['reasoning-effort-none', 'reasoning-effort-minimal', 'disable-thinking', 'enable-thinking-false', 'prefill', 'bare']);
    expect(logs.at(-1)).toMatch(/'reasoning-effort-minimal' thought least \(reasoning_tokens=70, against 295 with 'bare'\)/);
    // A strategy with no reasoning tokens still wins outright, as in the reference code.
    const off: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: strategy === 'disable-thinking' ? 0 : 50 });
    const offResult = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: off });
    expect(offResult.strategy).toBe('disable-thinking');
  });

  it('kbf-discovery-least-reasoning-v1: bare stays when it thought least; on a tie the earlier strategy is used', async () => {
    const bareLeast: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: strategy === 'bare' ? 40 : 300 });
    const kept = await discoverThinkingSuppression({ model: 'm', label: 'endpoint', supportsPrefill: true, probe: bareLeast });
    expect(kept.strategy).toBe('bare');
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
    expect(result.strategy).toBe('reasoning-effort-minimal');
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

  describe('kbf-discovery-reference-first-v1: the reference\'s setting is tried first', () => {
    /** An endpoint that answers every setting from a table: reasoning tokens by strategy, or a refusal. */
    const endpoint = (table: Record<string, number | 'refused'>, otherwise: number | 'refused' = 0): ThinkingDiscoveryProbe => async ({ strategy }) => {
      const value = table[strategy] ?? otherwise;
      return value === 'refused' ? { ok: false, status: 400, failure: `${strategy} is not supported` } : { ok: true, content: ANSWERS, reasoningTokens: value };
    };
    const order = (result: { attempts: Array<{ strategy: string }> }) => result.attempts.map((attempt) => attempt.strategy);

    it('is the rule this build records, with the rule before it still known', () => {
      expect(THINKING_DISCOVERY_RULE).toBe('kbf-discovery-reference-first-v1');
      expect(THINKING_DISCOVERY_RULES).toEqual(['kbf-discovery-least-reasoning-v1', 'kbf-discovery-reference-first-v1']);
    });

    it('keeps the reference\'s setting when it answers with 0 reasoning tokens, though an earlier setting would too', async () => {
      // Sonnet 5.5: its reference route refuses effort none, so its bank recorded minimal; this seller takes both.
      const logs: string[] = [];
      const result = await discoverThinkingSuppression({
        model: 'claude-sonnet-5.5', label: 'seller', supportsPrefill: true, probe: endpoint({}), referenceStrategy: 'reasoning-effort-minimal', log: (line) => logs.push(line),
      });
      expect([result.strategy, result.overrides]).toEqual(['reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }]);
      expect(order(result)).toEqual(['reasoning-effort-minimal']);
      expect(logs.at(-1)).toMatch(/the reference's 'reasoning-effort-minimal' works on seller/);
      // Without it the order keeps effort none, as before.
      expect((await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({}) })).strategy).toBe('reasoning-effort-none');
    });

    it('goes on in the usual order when the seller refuses the reference\'s setting, without asking it again', async () => {
      const result = await discoverThinkingSuppression({
        model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'disable-thinking': 'refused', 'reasoning-effort-none': 'refused' }), referenceStrategy: 'disable-thinking',
      });
      expect(result.strategy).toBe('reasoning-effort-minimal');
      expect(order(result)).toEqual(['disable-thinking', 'reasoning-effort-none', 'reasoning-effort-minimal']);
    });

    it('goes on in the usual order when the seller still reasons with the reference\'s setting', async () => {
      const reasons = await discoverThinkingSuppression({
        model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'disable-thinking': 30 }), referenceStrategy: 'disable-thinking',
      });
      expect(reasons.strategy).toBe('reasoning-effort-none');
      expect(order(reasons)).toEqual(['disable-thinking', 'reasoning-effort-none']);
      // A reply that reasons in the open or stops at the limit is no answer with the reference's setting either.
      const cutOff: ThinkingDiscoveryProbe = async ({ strategy }) => ({ ok: true, content: ANSWERS, reasoningTokens: 0, truncated: strategy === 'reasoning-effort-minimal' });
      expect((await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: cutOff, referenceStrategy: 'reasoning-effort-minimal' })).strategy).toBe('reasoning-effort-none');
    });

    it('reads the reference\'s attempt in its own place, so the least-reasoning pick is the one the usual order gives', async () => {
      // GLM 5.3: nothing turns thinking off; minimal thinks least. Tried first or in its place, the same pick and the same
      // number of requests, minimal sent once.
      const glm = endpoint({ 'reasoning-effort-none': 'refused', 'reasoning-effort-minimal': 70, 'disable-thinking': 200, 'enable-thinking-false': 197, prefill: 93, bare: 295 });
      const before = await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: glm });
      const first = await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: glm, referenceStrategy: 'reasoning-effort-minimal' });
      expect(first.strategy).toBe(before.strategy);
      expect(first.attempts).toHaveLength(before.attempts.length);
      expect(order(first).filter((strategy) => strategy === 'reasoning-effort-minimal')).toHaveLength(1);
      // On a tie the earlier strategy in the order still wins, not the one asked first.
      const tie = endpoint({ 'reasoning-effort-none': 60, prefill: 60, bare: 500 }, 300);
      expect((await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: tie, referenceStrategy: 'prefill' })).strategy).toBe('reasoning-effort-none');
    });

    it('asks a seller that refuses the reference\'s "minimal" with "low" next, never "none" first, and keeps it at 0 reasoning', async () => {
      expect(THINKING_REFERENCE_EQUIVALENTS).toEqual({ 'reasoning-effort-minimal': 'reasoning-effort-low' });
      // A host that refuses "minimal" and takes "low" and "none": "low" is kept, "none" is never sent.
      const logs: string[] = [];
      const result = await discoverThinkingSuppression({
        model: 'claude-sonnet-5.5', label: 'seller', supportsPrefill: true, probe: endpoint({ 'reasoning-effort-minimal': 'refused' }), referenceStrategy: 'reasoning-effort-minimal', log: (line) => logs.push(line),
      });
      expect([result.strategy, result.overrides]).toEqual(['reasoning-effort-low', { reasoning: { effort: 'low' } }]);
      expect(order(result)).toEqual(['reasoning-effort-minimal', 'reasoning-effort-low']);
      expect(logs.at(-1)).toMatch(/nearest equivalent 'reasoning-effort-low' works/);
    });

    it('goes on in the usual order when "low" reasons or is refused too, and tries "low" only after a refusal of "minimal"', async () => {
      const lowReasons = await discoverThinkingSuppression({
        model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'reasoning-effort-minimal': 'refused', 'reasoning-effort-low': 25 }), referenceStrategy: 'reasoning-effort-minimal',
      });
      expect(lowReasons.strategy).toBe('reasoning-effort-none');
      expect(order(lowReasons)).toEqual(['reasoning-effort-minimal', 'reasoning-effort-low', 'reasoning-effort-none']);
      const bothRefused = await discoverThinkingSuppression({
        model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'reasoning-effort-minimal': 'refused', 'reasoning-effort-low': 'refused', 'reasoning-effort-none': 'refused' }), referenceStrategy: 'reasoning-effort-minimal',
      });
      expect(order(bothRefused)).toEqual(['reasoning-effort-minimal', 'reasoning-effort-low', 'reasoning-effort-none', 'disable-thinking']);
      // "low" never stands in the least-reasoning pick: nothing turns thinking off, and the pick is the usual order's.
      const glm = endpoint({ 'reasoning-effort-none': 'refused', 'reasoning-effort-minimal': 'refused', 'reasoning-effort-low': 5, 'disable-thinking': 200, 'enable-thinking-false': 197, prefill: 93, bare: 295 });
      expect((await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: glm, referenceStrategy: 'reasoning-effort-minimal' })).strategy).toBe('prefill');
      // "minimal" answered but reasoned: no refusal, so no "low"; a 429 is no refusal either.
      expect(order(await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'reasoning-effort-minimal': 30 }), referenceStrategy: 'reasoning-effort-minimal' })))
        .toEqual(['reasoning-effort-minimal', 'reasoning-effort-none']);
      const busy: ThinkingDiscoveryProbe = async ({ strategy }) => strategy === 'reasoning-effort-minimal' ? { ok: false, status: 429, failure: 'busy' } : { ok: true, content: ANSWERS, reasoningTokens: 0 };
      expect(order(await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: busy, referenceStrategy: 'reasoning-effort-minimal' })))
        .toEqual(['reasoning-effort-minimal', 'reasoning-effort-none']);
      // No other setting has an equivalent: a refused "disable-thinking" goes straight to the order.
      expect(order(await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({ 'disable-thinking': 'refused' }), referenceStrategy: 'disable-thinking' })))
        .toEqual(['disable-thinking', 'reasoning-effort-none']);
    });

    it('runs the usual order unchanged without a reference setting: none, bare, bare-expanded, an older name, or a prefill the route cannot send', async () => {
      const probe = endpoint({ 'reasoning-effort-none': 'refused' });
      const usual = await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: false, probe });
      expect(order(usual)).toEqual(['reasoning-effort-none', 'reasoning-effort-minimal']);
      for (const referenceStrategy of [null, undefined, 'bare', 'bare-expanded', 'reasoning-effort-minimum-supported', 'prefill'] as const) {
        const result = await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: false, probe, referenceStrategy: referenceStrategy as never });
        expect(order(result), String(referenceStrategy)).toEqual(order(usual));
      }
      // Every setting that sets something can be tried first.
      for (const strategy of THINKING_DISCOVERY_STRATEGIES.filter((name) => name !== 'bare')) {
        const result = await discoverThinkingSuppression({ model: 'm', label: 'seller', supportsPrefill: true, probe: endpoint({}), referenceStrategy: strategy });
        expect(order(result)).toEqual([strategy]);
      }
    });
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
