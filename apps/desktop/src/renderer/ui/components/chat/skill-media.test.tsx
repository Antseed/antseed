import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRunningVideoGenerationTool, toolMediaAttachmentBlock } from './ChatBubble';

test('show_media results become inline generated video blocks', () => {
  const block = toolMediaAttachmentBlock({
    type: 'tool_use',
    name: 'show_media',
    status: 'success',
    details: { mediaAttachment: { attachmentId: 'abc', fileName: 'Ant Surf Movie.mp4', mimeType: 'video/mp4', size: 42 } },
  });
  assert.deepEqual(block, {
    type: 'file', fileName: 'Ant Surf Movie.mp4', mimeType: 'video/mp4', size: 42,
    status: 'ready', attachmentId: 'abc', generated: true,
  });
});

test('failed or non-media tools render nothing extra', () => {
  assert.equal(toolMediaAttachmentBlock({ type: 'tool_use', name: 'show_media', status: 'error', is_error: true }), null);
  assert.equal(toolMediaAttachmentBlock({ type: 'tool_use', name: 'bash', status: 'success', details: { mediaAttachment: { attachmentId: 'x', mimeType: 'video/mp4' } } }), null);
  assert.equal(toolMediaAttachmentBlock({ type: 'tool_use', name: 'show_media', status: 'success', details: { mediaAttachment: { attachmentId: 'x', mimeType: 'text/html' } } }), null);
});

test('a running skill video job shows the generation placeholder', () => {
  const command = 'case "$protocol" in venice-video) url="$proxy_url/api/v1/video/retrieve" ;; fal-video) url="$proxy_url/fal/v1/video/retrieve" ;; esac';
  assert.equal(isRunningVideoGenerationTool({ type: 'tool_use', name: 'bash', status: 'running', input: { command } }), true);
  assert.equal(isRunningVideoGenerationTool({ type: 'tool_use', name: 'bash', status: 'success', input: { command } }), false);
  assert.equal(isRunningVideoGenerationTool({ type: 'tool_use', name: 'bash', status: 'running', input: { command: 'curl "$proxy_url/v1/models?type=videos"' } }), false);
});
