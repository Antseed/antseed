import assert from 'node:assert/strict';
import test from 'node:test';
import { asErrorMessage } from './error-message.js';

test('uses the message, the text, or the fallback', () => {
  assert.equal(asErrorMessage(new Error('boom')), 'boom');
  assert.equal(asErrorMessage({ message: 'from ipc' }), 'from ipc');
  assert.equal(asErrorMessage('plain'), 'plain');
  assert.equal(asErrorMessage(null), 'Unexpected error');
  assert.equal(asErrorMessage({}, 'Request failed'), 'Request failed');
  assert.equal(asErrorMessage(new Error('  '), 'Request failed'), 'Request failed');
  assert.equal(asErrorMessage('', 'Request failed'), 'Request failed');
});
