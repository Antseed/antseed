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

it('shows what a seller said instead of its raw response', () => {
  const raw = 'Oops, peer could not complete the request.\nAntseed is a peer-to-peer network. Try another peer or use Auto routing.\n\nOriginal Response: {"message":"The image is 32x32 pixels; images must be at least 64x64 pixels.: messages.3.content.1.image_url.url: Supplied image did not pass","status":400}';
  expect(describeChatError(raw, () => undefined)).toBe('The provider could not complete this request: The image is 32x32 pixels; images must be at least 64x64 pixels. You can try another model.');
});

it('keeps a seller response it cannot read', () => {
  const raw = 'Oops, peer could not complete the request. Original Response: {not json}';
  expect(describeChatError(raw, () => undefined)).toBe(raw);
});
