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

test('parseByteRange supports video seeking ranges', async () => {
  const { parseByteRange } = await import('./protocol-url.js');
  assert.equal(parseByteRange(null, 100), null);
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(parseByteRange('bytes=95-500', 100), { start: 95, end: 99 });
  assert.equal(parseByteRange('bytes=100-', 100), 'invalid');
  assert.equal(parseByteRange('items=1-2', 100), 'invalid');
});
