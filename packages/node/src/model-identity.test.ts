import { describe, expect, it } from 'vitest';
import { canonicalModelKey, sameCanonicalModel } from './model-identity.js';

describe('canonicalModelKey', () => {
  it('merges cosmetic variants and conservative Claude family aliases', () => {
    expect(canonicalModelKey('anthropic/claude-opus-5-20260813')).toBe('opus5');
    expect(canonicalModelKey('Opus 5')).toBe('opus5');
    expect(sameCanonicalModel('Claude Sonnet 5', 'sonnet-5')).toBe(true);
    expect(sameCanonicalModel('Claude Fable 5', 'fable-5')).toBe(true);
    expect(sameCanonicalModel('fable-5-coding-only', 'fable-5')).toBe(true);
  });

  it('merges numeric-version punctuation used by established model families', () => {
    expect(sameCanonicalModel('gpt-5.6-sol', 'gpt-56-sol')).toBe(true);
    expect(sameCanonicalModel('gemini-3-5-flash', 'gemini-3.5-flash')).toBe(true);
    expect(sameCanonicalModel('glm-5-2', 'GLM5.2')).toBe(true);
    expect(sameCanonicalModel('qwen-3.5-35b-a3b', 'qwen35-35b-a3b')).toBe(true);
    expect(sameCanonicalModel('minimax-m2.7-fast', 'minimax-m27-fast')).toBe(true);
  });

  it('merges the stealth alias of ox-alpha, not other stealth names', () => {
    expect(sameCanonicalModel('stealth-ox-alpha', 'ox-alpha')).toBe(true);
    expect(sameCanonicalModel('stealth-model-x', 'model-x')).toBe(false);
  });

  it('merges conservative flattened vendor prefixes', () => {
    expect(sameCanonicalModel('openai-gpt-56-sol', 'gpt-5.6-sol')).toBe(true);
    expect(sameCanonicalModel('zai-org-glm-5-2', 'glm-5.2')).toBe(true);
    expect(sameCanonicalModel('z-ai-glm-5-turbo', 'glm-5-turbo')).toBe(true);
    expect(sameCanonicalModel('aion-labs-aion-3-0-mini', 'aion-3.0-mini')).toBe(true);
    expect(sameCanonicalModel('google-gemma-3-27b-it', 'gemma-3.27b-it')).toBe(true);
  });

  it('does not strip Claude from unknown family names', () => {
    expect(canonicalModelKey('claude-novel-5')).not.toBe(canonicalModelKey('novel-5'));
  });

  it('keeps materially different variants separate', () => {
    expect(sameCanonicalModel('gpt-5.6-sol', 'gpt-5.6-sol-pro')).toBe(false);
    expect(sameCanonicalModel('claude-opus-4.8', 'claude-opus-4.8-fast')).toBe(false);
    expect(sameCanonicalModel('deepseek-v4-pro', 'deepseek-v4-pro:web')).toBe(false);
    expect(sameCanonicalModel('google-palm-2', 'palm-2')).toBe(false);
  });

  it('keeps every path segment after the vendor', () => {
    expect(sameCanonicalModel('openai/gpt-5.6-sol', 'gpt-5.6-sol')).toBe(true);
    expect(sameCanonicalModel('accounts/fireworks/models/glm-5-2', 'glm-5.2')).toBe(true);
    expect(sameCanonicalModel('bytedance/seedance-2.5/text-to-video', 'xai/grok-imagine-video/v1.5/lite/text-to-video')).toBe(false);
    expect(sameCanonicalModel('fal-ai/veo3.1/fast', 'fal-ai/veo3.1')).toBe(false);
    expect(sameCanonicalModel('minimax/h3-max/text-to-video', 'minimax/h3/text-to-video')).toBe(false);
    expect(canonicalModelKey('bytedance/seedance-2.5/text-to-video')).toBe('seedance2.5texttovideo');
  });
});
