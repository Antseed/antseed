import { describe, expect, it } from 'vitest';
import {
  FreeTierConversationTracker,
  MESSAGE_OWNER_TTL_MS,
  MOVED_MIN_MESSAGES,
  fingerprintConversation,
} from '../src/payments/free-tier-conversations.js';

const BUYER = '0x' + '11'.repeat(20);
const OTHER_BUYER = '0x' + '22'.repeat(20);

/** A conversation whose tracked turns each carry about 7,000 tokens. */
function conversation(turns: number, seed = 'a'): { messages: Array<{ role: string; content: string }> } {
  const messages = [
    { role: 'system', content: 'You are helpful. '.repeat(200) },
    ...Array.from({ length: 3 + turns }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${seed}${index}:${'x'.repeat(28_000)}`,
    })),
  ];
  return { messages };
}

describe('fingerprintConversation', () => {
  it('tracks long messages after the opening of the conversation and ignores system prompts', () => {
    const fingerprint = fingerprintConversation(conversation(2));
    expect(fingerprint?.messages).toHaveLength(2);
    expect(fingerprintConversation({ messages: [{ role: 'user', content: 'short' }] })).toBeNull();
    expect(fingerprintConversation({ input: conversation(1).messages })?.messages).toHaveLength(1);
    expect(fingerprintConversation(null)).toBeNull();
    expect(fingerprintConversation({ prompt: 'x' })).toBeNull();
  });
});

describe('FreeTierConversationTracker', () => {
  it('finds a long conversation carried on from another buyer address', () => {
    const tracker = new FreeTierConversationTracker();
    const history = fingerprintConversation(conversation(MOVED_MIN_MESSAGES))!;
    tracker.record(BUYER, history, 1_000);

    expect(tracker.findMovedConversation(BUYER, history, 2_000)).toBeNull();
    expect(tracker.findMovedConversation(OTHER_BUYER, history, 2_000))
      .toMatchObject({ owner: BUYER, messages: MOVED_MIN_MESSAGES });
  });

  it('ignores a few shared messages and a conversation past its time to live', () => {
    const tracker = new FreeTierConversationTracker();
    const short = fingerprintConversation(conversation(MOVED_MIN_MESSAGES - 1))!;
    tracker.record(BUYER, short, 1_000);
    expect(tracker.findMovedConversation(OTHER_BUYER, short, 2_000)).toBeNull();

    const long = fingerprintConversation(conversation(MOVED_MIN_MESSAGES, 'b'))!;
    tracker.record(BUYER, long, 1_000);
    expect(tracker.findMovedConversation(OTHER_BUYER, long, 1_000 + MESSAGE_OWNER_TTL_MS + 1)).toBeNull();
  });

  it('keeps the first sender as owner and forgets the oldest messages past its size', () => {
    const tracker = new FreeTierConversationTracker(MOVED_MIN_MESSAGES);
    const history = fingerprintConversation(conversation(MOVED_MIN_MESSAGES))!;
    tracker.record(BUYER, history, 1_000);
    tracker.record(OTHER_BUYER, history, 2_000);
    expect(tracker.findMovedConversation(OTHER_BUYER, history, 3_000)).toMatchObject({ owner: BUYER });

    tracker.record(OTHER_BUYER, fingerprintConversation(conversation(1, 'c'))!, 4_000);
    expect(tracker.size).toBe(MOVED_MIN_MESSAGES);
    expect(tracker.findMovedConversation(OTHER_BUYER, history, 5_000)).toBeNull();
  });
});
