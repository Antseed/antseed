import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createChatImagePathTool,
  createShowMediaTool,
  detectChatMedia,
  resolveBundledChatSkillPaths,
} from './media-tools.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-media-tools-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('detectChatMedia recognizes supported image and video signatures', () => {
  assert.equal(detectChatMedia(PNG)?.mimeType, 'image/png');
  assert.equal(detectChatMedia(MP4)?.mimeType, 'video/mp4');
  assert.equal(detectChatMedia(Buffer.from('not media')), null);
});

test('show_media copies a workspace MP4 into chat attachment storage', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'clip.mp4'), MP4);
    const persisted: Array<{ conversationId: string; attachmentId: string; fileName: string; size: number }> = [];
    const tool = createShowMediaTool('conversation-1', dir, async (conversationId, attachmentId, fileName, buffer) => {
      persisted.push({ conversationId, attachmentId, fileName, size: buffer.byteLength });
      return path.join(dir, fileName);
    });
    const result = await tool.execute('tool-1', { path: 'clip.mp4', title: 'Launch video' }, undefined, undefined, {} as never);
    const details = result.details as { mediaAttachment?: Record<string, unknown> };
    assert.equal(persisted[0]?.conversationId, 'conversation-1');
    assert.equal(persisted[0]?.fileName, 'Launch video.mp4');
    assert.equal(details.mediaAttachment?.mimeType, 'video/mp4');
    assert.equal(details.mediaAttachment?.size, MP4.byteLength);
  });
});

test('show_media rejects unsupported files', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'note.txt'), 'hello');
    const tool = createShowMediaTool('conversation-1', dir, async () => {
      throw new Error('should not persist');
    });
    const result = await tool.execute('tool-1', { path: 'note.txt' }, undefined, undefined, {} as never) as { isError?: boolean };
    assert.equal(result.isError, true);
  });
});

test('get_chat_image_path returns only image attachments from the current chat', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'frame.png');
    await writeFile(imagePath, PNG);
    const tool = createChatImagePathTool('conversation-1', async (conversationId, attachmentId) => (
      conversationId === 'conversation-1' && attachmentId === 'image-1' ? imagePath : null
    ));
    const result = await tool.execute('tool-1', { attachmentId: 'image-1' }, undefined, undefined, {} as never);
    assert.deepEqual(result.content, [{ type: 'text', text: imagePath }]);
  });
});

test('resolveBundledChatSkillPaths returns the bundled image and video skills', async () => {
  await withTempDir(async (dir) => {
    for (const name of ['antseed-images', 'antseed-videos']) {
      await mkdir(path.join(dir, name), { recursive: true });
      await writeFile(path.join(dir, name, 'SKILL.md'), '---\nname: test\ndescription: test\n---\n');
    }
    assert.deepEqual(resolveBundledChatSkillPaths([dir]), [
      path.join(dir, 'antseed-images'),
      path.join(dir, 'antseed-videos'),
    ]);
  });
});
