import test from 'node:test';
import assert from 'node:assert/strict';

import { convertPersistedAttachmentPromptToBlocks } from './message-projection.js';

test('uploaded image id tags are hidden from projected user text', () => {
  assert.equal(convertPersistedAttachmentPromptToBlocks('<uploaded-image id="att-2" name="a.png" mime="image/png">'), '');
  assert.equal(
    convertPersistedAttachmentPromptToBlocks('Use this as the start frame\n\n<uploaded-image id="att-2" name="a.png" mime="image/png">'),
    'Use this as the start frame',
  );
});

test('uploaded video id tags are hidden from projected user text', () => {
  assert.equal(
    convertPersistedAttachmentPromptToBlocks('Put me in this dance\n\n<uploaded-video id="att-3" name="dance.mp4" mime="video/mp4" size="1024">'),
    'Put me in this dance',
  );
});
