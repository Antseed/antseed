import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BuyerConversationSummary } from '../../types/bridge.js';
import {
  conversationPinnedPeerId,
  conversationPinnedServiceId,
  conversationRoutedPeerId,
  conversationRoutedServiceId,
} from './conversations.js';

function conversation(overrides: Partial<BuyerConversationSummary>): BuyerConversationSummary {
  return {
    id: 'opencode:session',
    tool: 'opencode',
    sessionKey: 'session',
    label: null,
    snippet: null,
    pinnedModel: null,
    peerSource: 'auto',
    lastModel: null,
    lastActiveAt: 0,
    spentUsdc: '0',
    ...overrides,
  } as BuyerConversationSummary;
}

test('model-only automatic routes expose a service without a pinned peer', () => {
  const record = conversation({ pinnedModel: 'gpt-5.6-sol' });
  assert.equal(conversationPinnedServiceId(record), 'gpt-5.6-sol');
  assert.equal(conversationPinnedPeerId(record), null);
  assert.equal(conversationRoutedPeerId(record), null);
});

test('explicit seller routes expose both peer and service', () => {
  const peerId = 'a'.repeat(40);
  const record = conversation({
    pinnedModel: `${peerId}@openai-gpt-56-sol`,
    peerSource: 'user',
    lastModel: `${peerId}@openai-gpt-56-sol`,
  });
  assert.equal(conversationPinnedServiceId(record), 'openai-gpt-56-sol');
  assert.equal(conversationPinnedPeerId(record), peerId);
  assert.equal(conversationRoutedPeerId(record), peerId);
});

test('conversationRoutedServiceId prefers the in-flight route over the pin', () => {
  assert.equal(conversationRoutedServiceId(conversation({
    pinnedModel: `${'a'.repeat(40)}@gpt-5`,
    lastModel: `${'b'.repeat(40)}@opus-5.5`,
  })), 'opus-5.5');
  assert.equal(conversationRoutedServiceId(conversation({ pinnedModel: `${'a'.repeat(40)}@gpt-5`, lastModel: null })), 'gpt-5');
  assert.equal(conversationRoutedServiceId(conversation({ pinnedModel: null, lastModel: null })), null);
});
