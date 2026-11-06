import { expect, it } from 'vitest';
import { describeChatError } from './chat-errors';

const label = (id: string) => (id === 'known' ? 'Known Model' : undefined);

it('names the model when no provider fits the policy', () => {
  expect(describeChatError('502 No policy-allowed peer currently serves model "known".', label))
    .toBe('No provider for Known Model fits your policy right now.');
  expect(describeChatError('No policy-allowed peer currently serves model "other"', label))
    .toBe('No provider for other fits your policy right now.');
});

it('drops the HTTP status and keeps every other message', () => {
  expect(describeChatError('503 Gateway is starting', label)).toBe('Gateway is starting');
  expect(describeChatError('Failed to open conversation', label)).toBe('Failed to open conversation');
});
