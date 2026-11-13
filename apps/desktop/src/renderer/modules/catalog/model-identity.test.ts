import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canonicalModelKey, displayModelLabel, sameCanonicalModel } from './model-identity.js';

test('canonicalModelKey collapses separator and vendor-prefix variants', () => {
  assert.equal(canonicalModelKey('gpt-5.6-luna'), 'gpt56luna');
  assert.equal(canonicalModelKey('GPT 5.6 Luna'), 'gpt56luna');
  assert.equal(canonicalModelKey('openai/gpt-5.6-luna'), 'gpt56luna');
  assert.equal(canonicalModelKey('openai-gpt-56-luna'), 'gpt56luna');
  assert.equal(canonicalModelKey('gpt_5.6_luna'), 'gpt56luna');
});

test('canonicalModelKey strips -latest and trailing date stamps', () => {
  assert.equal(canonicalModelKey('gpt-5.6-luna-latest'), 'gpt56luna');
  assert.equal(canonicalModelKey('gpt-5.6-luna-20260115'), 'gpt56luna');
  assert.equal(canonicalModelKey('claude-fable-5-2026-01-15'), 'fable5');
});

test('canonicalModelKey merges optional Claude family prefixes', () => {
  assert.equal(canonicalModelKey('claude-opus-5'), canonicalModelKey('Opus 5'));
  assert.equal(canonicalModelKey('Claude Sonnet 5'), canonicalModelKey('sonnet-5'));
  assert.equal(canonicalModelKey('anthropic/claude-haiku-5-latest'), canonicalModelKey('haiku 5'));
  assert.equal(canonicalModelKey('claude-fable-5'), canonicalModelKey('fable-5'));
  assert.equal(canonicalModelKey('fable-5-coding-only'), canonicalModelKey('fable-5'));
});

test('canonicalModelKey keeps genuinely different variants apart', () => {
  assert.notEqual(canonicalModelKey('gpt-5.6-luna'), canonicalModelKey('gpt-5.6-luna-pro'));
  assert.notEqual(canonicalModelKey('gpt-5.6-luna'), canonicalModelKey('gpt-5.6-sol'));
  assert.notEqual(canonicalModelKey('claude-novel-5'), canonicalModelKey('novel-5'));
});

test('canonicalModelKey merges live numeric-version variants', () => {
  assert.equal(canonicalModelKey('gpt-5.6-sol'), canonicalModelKey('gpt-56-sol'));
  assert.equal(canonicalModelKey('gemini-3-5-flash'), canonicalModelKey('gemini-3.5-flash'));
  assert.equal(canonicalModelKey('zai-org-glm-5-2'), canonicalModelKey('glm-5.2'));
  assert.equal(canonicalModelKey('qwen-3.5-35b-a3b'), canonicalModelKey('qwen35-35b-a3b'));
});

test('sameCanonicalModel never matches on empty keys', () => {
  assert.equal(sameCanonicalModel('', ''), false);
  assert.equal(sameCanonicalModel('---', '___'), false);
});

test('displayModelLabel prettifies slug ids', () => {
  assert.equal(displayModelLabel('claude-fable-5'), 'Claude Fable 5');
  assert.equal(displayModelLabel('gpt-5.6-luna'), 'GPT 5.6 Luna');
  assert.equal(displayModelLabel('deepseek-v4'), 'DeepSeek V4');
  assert.equal(displayModelLabel('kimi-k3'), 'Kimi K3');
  assert.equal(displayModelLabel('glm-5.2'), 'GLM 5.2');
});

test('displayModelLabel keeps human labels untouched', () => {
  assert.equal(displayModelLabel('gpt-5.6-luna', 'GPT-5.6 Luna'), 'GPT 5.6 Luna');
  assert.equal(displayModelLabel('', 'Select a model'), 'Select a model');
  assert.equal(displayModelLabel('s1', 'GPT Test'), 'GPT Test');
});

test('displayModelLabel prettifies slug-shaped labels', () => {
  assert.equal(displayModelLabel('svc-1', 'gpt-5.6-luna'), 'GPT 5.6 Luna');
});

test('displayModelLabel uses one GPT version convention across aliases', () => {
  assert.equal(displayModelLabel('gpt-5.6-luna'), 'GPT 5.6 Luna');
  assert.equal(displayModelLabel('gpt-5-6-luna'), 'GPT 5.6 Luna');
  assert.equal(displayModelLabel('gpt-56-luna'), 'GPT 5.6 Luna');
});

test('displayModelLabel prefixes unified Claude families', () => {
  assert.equal(displayModelLabel('opus-5'), 'Claude Opus 5');
  assert.equal(displayModelLabel('sonnet-5'), 'Claude Sonnet 5');
  assert.equal(displayModelLabel('fable-5-coding-only'), 'Claude Fable 5');
  assert.equal(displayModelLabel('claude-opus-4-8'), 'Claude Opus 4.8');
  assert.equal(displayModelLabel('sonnet-4.6'), 'Claude Sonnet 4.6');
  assert.equal(displayModelLabel('claude-3-haiku'), 'Claude 3 Haiku');
});

test('canonicalModelKey merges Claude coding-only aliases globally', () => {
  assert.equal(canonicalModelKey('opus-4.8-coding-only'), canonicalModelKey('claude-opus-4.8'));
  assert.equal(canonicalModelKey('sonnet-4.6-coding-only'), canonicalModelKey('claude-sonnet-4.6'));
  assert.equal(canonicalModelKey('haiku-4.5-coding-only'), canonicalModelKey('claude-haiku-4.5'));
});

test('displayModelLabel normalizes MiniMax decimal versions', () => {
  assert.equal(displayModelLabel('minimax-m2.5'), 'MiniMax M2.5');
  assert.equal(displayModelLabel('minimax-m2-5'), 'MiniMax M2.5');
  assert.equal(displayModelLabel('minimax-m25'), 'MiniMax M2.5');
  assert.equal(displayModelLabel('minimax-m2-7:web'), 'MiniMax M2.7 Web');
});
