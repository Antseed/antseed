import { describe, it, expect } from 'vitest';
import { anthropicMessagesRelay, anthropicRejectedSamplingFields } from './anthropic-messages.js';

const SAMPLING = ['temperature', 'top_p', 'top_k'];

describe('anthropicRejectedSamplingFields', () => {
  it.each([
    'claude-opus-4-7',
    'claude-opus-4.8-fast',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-5-5-latest',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-haiku-5-5-20260901',
    'claude-haiku-5-5@20260901',
    'anthropic/claude-haiku-5-5',
    'anthropic.claude-opus-5-5',
    'Claude-Fable-5-2',
    'claude-fable-5',
    'claude-mythos-5-2',
  ])('names the sampling fields for %s', (model) => {
    expect(anthropicRejectedSamplingFields(model)).toEqual(SAMPLING);
  });

  it.each([
    'claude-opus-4-6',
    'claude-opus-4-20250514',
    'claude-opus-4-1-20250805',
    'claude-opus-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-3-7-sonnet-latest',
    'claude-3-haiku-20240307',
    'claude-mythos-preview',
    'gpt-5.6',
    'opus-4-7',
    'claude-opus-4-32k',
    '',
    undefined,
  ])('names nothing for %s', (model) => {
    expect(anthropicRejectedSamplingFields(model)).toEqual([]);
  });
});

describe('anthropicMessagesRelay', () => {
  it('applies the model rule to Messages requests only', () => {
    expect(anthropicMessagesRelay.omitJsonFields({ path: '/v1/messages', model: 'claude-haiku-5-5' })).toEqual(SAMPLING);
    expect(anthropicMessagesRelay.omitJsonFields({ path: '/v1/messages/count_tokens', model: 'claude-haiku-5-5' })).toEqual([]);
    expect(anthropicMessagesRelay.omitJsonFields({ path: '/v1/chat/completions', model: 'claude-haiku-5-5' })).toEqual([]);
  });

  it('defaults the API version', () => {
    expect(anthropicMessagesRelay.defaultHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
  });
});
