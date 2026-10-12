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
