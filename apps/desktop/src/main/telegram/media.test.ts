import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyIncomingMedia,
  extractImageFileBlocks,
  extractImageFileBlocksFromUiMessage,
  pickLargestPhoto,
} from './media.js';

test('pickLargestPhoto returns the largest sized variant and ignores junk', () => {
  assert.equal(pickLargestPhoto(undefined), null);
  assert.equal(pickLargestPhoto([]), null);
  assert.equal(pickLargestPhoto(['nope']), null);
  const best = pickLargestPhoto([
    { file_id: 'small', file_size: 1_000, width: 90, height: 90 },
    { file_id: 'large', file_size: 200_000, width: 1280, height: 720 },
    { file_id: 'mid', file_size: 100_000, width: 320, height: 320 },
  ]);
  assert.equal(best?.file_id, 'large');
  // Missing file_size entries lose against known sizes.
  const fallback = pickLargestPhoto([
    { file_id: 'unknown' },
    { file_id: 'known', file_size: 5 },
  ]);
  assert.equal(fallback?.file_id, 'known');
});

test('extractImageFileBlocks collects only ready image blocks with attachment ids', () => {
  const content = [
    { type: 'text', text: 'here you go' },
    { type: 'file', fileName: 'generated-abc.png', mimeType: 'image/png', attachmentId: 'att-1' },
    { type: 'file', fileName: 'notes.pdf', mimeType: 'application/pdf', attachmentId: 'att-2' },
    { type: 'file', fileName: 'no-id.png', mimeType: 'image/png' },
    { type: 'image', source: { type: 'base64', data: '...' } },
    null,
  ];
  assert.deepEqual(extractImageFileBlocks(content), [
    { fileName: 'generated-abc.png', mimeType: 'image/png', attachmentId: 'att-1' },
  ]);
  assert.deepEqual(extractImageFileBlocks('plain text'), []);
  assert.deepEqual(
    extractImageFileBlocksFromUiMessage({ message: { content } }),
    [{ fileName: 'generated-abc.png', mimeType: 'image/png', attachmentId: 'att-1' }],
  );
  assert.deepEqual(extractImageFileBlocksFromUiMessage(null), []);
});

test('classifyIncomingMedia picks the largest photo and defaults name/mime', () => {
  const media = classifyIncomingMedia({
    date: 1_755_000_000,
    photo: [
      { file_id: 'small', file_size: 900 },
      { file_id: 'big', file_size: 250_000 },
    ],
    caption: 'what breed is this?',
  });
  assert.equal(media?.kind, 'photo');
  if (media?.kind !== 'photo') return;
  assert.equal(media.fileId, 'big');
  assert.equal(media.mimeType, 'image/jpeg');
  assert.match(media.fileName, /^photo-\d+\.jpg$/);
  assert.equal(media.approxBytes, 250_000);
});

test('classifyIncomingMedia maps documents with name and mime fallbacks', () => {
  const withMeta = classifyIncomingMedia({
    document: { file_id: 'f1', file_name: ' report.PDF ', mime_type: 'application/pdf;charset=bogus', file_size: 10 },
  });
  assert.deepEqual(withMeta, {
    kind: 'document',
    fileId: 'f1',
    fileName: 'report.PDF',
    mimeType: 'application/pdf',
    approxBytes: 10,
  });

  const unnamed = classifyIncomingMedia({ document: { file_id: 'f2' } });
  assert.equal(unnamed?.kind, 'document');
  if (unnamed?.kind !== 'document') return;
  assert.equal(unnamed.fileName, 'document');
  assert.equal(unnamed.mimeType, 'application/octet-stream');

  const extFallback = classifyIncomingMedia({ document: { file_id: 'f3', file_name: 'notes.txt' } });
  assert.equal(extFallback?.kind, 'document');
  if (extFallback?.kind !== 'document') return;
  assert.equal(extFallback.mimeType, 'text/plain');
});

test('classifyIncomingMedia flags recognised-but-unsupported media', () => {
  assert.deepEqual(classifyIncomingMedia({ voice: { file_id: 'v', duration: 3 } }), {
    kind: 'unsupported',
    label: 'Voice messages',
  });
  assert.deepEqual(classifyIncomingMedia({ video_note: { file_id: 'vn', duration: 3 } }), {
    kind: 'unsupported',
    label: 'Video messages',
  });
  assert.deepEqual(classifyIncomingMedia({ audio: { file_id: 'a', duration: 3 } }), {
    kind: 'unsupported',
    label: 'Audio files',
  });
  assert.deepEqual(classifyIncomingMedia({ video: { file_id: 'v2', duration: 3 } }), {
    kind: 'unsupported',
    label: 'Videos',
  });
});

test('classifyIncomingMedia returns null for plain text or unknown payloads', () => {
  assert.equal(classifyIncomingMedia({ text: 'hello' }), null);
  assert.equal(classifyIncomingMedia({}), null);
  // Documents without a usable file_id are not actionable media.
  assert.equal(classifyIncomingMedia({ document: { file_name: 'x.pdf' } }), null);
});
