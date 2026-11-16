import { describe, expect, it } from 'vitest';
import { staleStreamEvent } from './send-events';

describe('staleStreamEvent', () => {
  it('ignores a stopped send\'s late event once a follow-up owns the chat', () => {
    expect(staleStreamEvent(2, 1)).toBe(true);
  });

  it('takes the event of the send that owns the chat, or of a stopped one with no follow-up', () => {
    expect(staleStreamEvent(2, 2)).toBe(false);
    expect(staleStreamEvent(undefined, 1)).toBe(false);
  });

  it('takes untagged events, as an older main process sends them', () => {
    expect(staleStreamEvent(2, undefined)).toBe(false);
  });
});
