import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAttachmentUrl, ATTACHMENT_SCHEME } from './protocol-url.js';

test('parseAttachmentUrl accepts well-formed URLs', () => {
  const parsed = parseAttachmentUrl(`${ATTACHMENT_SCHEME}://conv1/att1`);
  assert.deepEqual(parsed, { conversationId: 'conv1', attachmentId: 'att1' });
});

test('parseAttachmentUrl ignores extra path segments beyond the attachment id', () => {
  // Only the first path segment is interpreted as the attachment id; the
  // rest is ignored so a buggy renderer can't tack on `/../something`.
  const parsed = parseAttachmentUrl(`${ATTACHMENT_SCHEME}://conv1/att1/extra/bits`);
  assert.deepEqual(parsed, { conversationId: 'conv1', attachmentId: 'att1' });
});

test('parseAttachmentUrl rejects other schemes', () => {
  assert.equal(parseAttachmentUrl('file:///etc/passwd'), null);
  assert.equal(parseAttachmentUrl('http://conv1/att1'), null);
});

test('parseAttachmentUrl rejects missing components', () => {
  assert.equal(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://`), null);
  assert.equal(parseAttachmentUrl(`${ATTACHMENT_SCHEME}:///att1`), null);
  assert.equal(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://conv1/`), null);
});

test('parseAttachmentUrl handles percent-encoded components', () => {
  const parsed = parseAttachmentUrl(`${ATTACHMENT_SCHEME}://conv%2D1/att%5F1`);
  assert.deepEqual(parsed, { conversationId: 'conv-1', attachmentId: 'att_1' });
});

test('parseAttachmentUrl returns null for malformed URLs', () => {
  assert.equal(parseAttachmentUrl('not a url'), null);
});
