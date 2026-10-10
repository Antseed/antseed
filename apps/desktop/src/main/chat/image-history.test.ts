import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_CUTOFF_CUSTOM_TYPE,
  OMITTED_IMAGE_TEXT,
  latestImageCutoff,
  nextImageCutoff,
  omitImagesBefore,
} from './image-history.js';

type Message = Parameters<typeof omitImagesBefore>[0][number];

function userImage(timestamp: number, bytes: number): Message {
  return {
    role: 'user',
    timestamp,
    content: [
      { type: 'text', text: `turn ${timestamp}` },
      { type: 'image', data: 'a'.repeat(bytes), mimeType: 'image/png' },
    ],
  } as Message;
}

function assistant(timestamp: number): Message {
  return { role: 'assistant', timestamp, content: [{ type: 'text', text: 'ok' }] } as unknown as Message;
}

test('nextImageCutoff keeps the cutoff while images fit the budget', () => {
  const messages = [userImage(1, 40), assistant(2), userImage(3, 40)];
  assert.equal(nextImageCutoff(messages, undefined, 100), undefined);
});

test('nextImageCutoff drops the oldest images down to half the budget', () => {
  const messages = [userImage(1, 40), userImage(2, 40), userImage(3, 40)];
  assert.equal(nextImageCutoff(messages, undefined, 100), 2);
});

test('nextImageCutoff only counts images after the saved cutoff', () => {
  const messages = [userImage(1, 80), userImage(2, 40), userImage(3, 40)];
  assert.equal(nextImageCutoff(messages, 1, 100), undefined);
});

test('nextImageCutoff never removes the images of the latest message', () => {
  const messages = [assistant(1), userImage(2, 500)];
  assert.equal(nextImageCutoff(messages, undefined, 100), undefined);
});

test('omitImagesBefore replaces older images and leaves newer messages untouched', () => {
  const messages = [userImage(1, 10), assistant(2), userImage(3, 10)];
  const result = omitImagesBefore(messages, 2);

  assert.deepEqual((result[0] as { content: unknown }).content, [
    { type: 'text', text: 'turn 1' },
    { type: 'text', text: OMITTED_IMAGE_TEXT },
  ]);
  assert.equal(result[1], messages[1]);
  assert.equal(result[2], messages[2]);
});

test('latestImageCutoff reads the most recent saved cutoff', () => {
  const entries = [
    { type: 'custom', customType: IMAGE_CUTOFF_CUSTOM_TYPE, data: { timestamp: 5 } },
    { type: 'message' },
    { type: 'custom', customType: IMAGE_CUTOFF_CUSTOM_TYPE, data: { timestamp: 9 } },
    { type: 'custom', customType: 'antseed:peer', data: {} },
  ];
  assert.equal(latestImageCutoff(entries), 9);
  assert.equal(latestImageCutoff([]), undefined);
});
