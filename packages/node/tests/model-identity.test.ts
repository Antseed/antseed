import { describe, expect, it } from 'vitest';
import {
  canonicalModelKey,
  preferredModelDisplayName,
  sameCanonicalModel,
} from '../src/model-identity.js';

describe('model identity', () => {
  it('uses one preferred GPT display convention across version aliases', () => {
    expect(preferredModelDisplayName('gpt-5.6-sol')).toBe('GPT 5.6 Sol');
    expect(preferredModelDisplayName('gpt-5-6-sol')).toBe('GPT 5.6 Sol');
    expect(preferredModelDisplayName('gpt-56-sol')).toBe('GPT 5.6 Sol');
    expect(preferredModelDisplayName('openai/gpt-56-luna')).toBe('GPT 5.6 Luna');
  });

  it('uses canonical family names for Claude aliases', () => {
    expect(preferredModelDisplayName('claude-opus-5')).toBe('Claude Opus 5');
    expect(preferredModelDisplayName('sonnet-5')).toBe('Claude Sonnet 5');
    expect(preferredModelDisplayName('fable-5-coding-only')).toBe('Claude Fable 5');
    expect(preferredModelDisplayName('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(preferredModelDisplayName('sonnet-4.6')).toBe('Claude Sonnet 4.6');
    expect(preferredModelDisplayName('claude-3-haiku')).toBe('Claude 3 Haiku');
  });

  it('merges Claude coding-only aliases into the base model', () => {
    expect(canonicalModelKey('opus-4.8-coding-only')).toBe(canonicalModelKey('claude-opus-4.8'));
    expect(canonicalModelKey('sonnet-4.6-coding-only')).toBe(canonicalModelKey('claude-sonnet-4-6'));
    expect(canonicalModelKey('haiku-4.5-coding-only')).toBe(canonicalModelKey('claude-haiku-4.5'));
  });

  it('uses one MiniMax decimal convention across compact aliases', () => {
    expect(preferredModelDisplayName('minimax-m2.5')).toBe('MiniMax M2.5');
    expect(preferredModelDisplayName('minimax-m2-5')).toBe('MiniMax M2.5');
    expect(preferredModelDisplayName('minimax-m25')).toBe('MiniMax M2.5');
    expect(preferredModelDisplayName('minimax-m2-7:web')).toBe('MiniMax M2.7 Web');
    expect(preferredModelDisplayName('MiniMax-M2.7-highspeed')).toBe('MiniMax M2.7 Highspeed');
  });

  it('preserves human labels for unknown model families', () => {
    expect(preferredModelDisplayName('custom-model', 'Custom Research Model')).toBe('Custom Research Model');
  });

  it('names multi-segment endpoint ids from every segment after the vendor', () => {
    expect(preferredModelDisplayName('bytedance/seedance-2.5/text-to-video')).toBe('Seedance 2.5 Text To Video');
  });

  it('keeps display naming separate from routing identity', () => {
    expect(canonicalModelKey('gpt-56-sol')).toBe('gpt56sol');
    expect(sameCanonicalModel('gpt-56-sol', 'gpt-5.6-sol')).toBe(true);
  });
});
