import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type Static, Type } from 'typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { resolveAttachmentPath, saveAttachment } from './attachments/store.js';
import { WORKSPACE_APPS_DIR } from '../paths.js';

export const SHOW_MEDIA_TOOL_NAME = 'show_media';
export const GET_CHAT_IMAGE_PATH_TOOL_NAME = 'get_chat_image_path';
export const BUNDLED_CHAT_SKILL_NAMES = ['antseed-images', 'antseed-videos'] as const;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

export type ChatMediaKind = { mimeType: string; extension: string; video: boolean };

export function detectChatMedia(header: Uint8Array): ChatMediaKind | null {
  const bytes = Buffer.from(header);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png', video: false };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg', video: false };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp', video: false };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    return brand === 'qt  '
      ? { mimeType: 'video/quicktime', extension: 'mov', video: true }
      : { mimeType: 'video/mp4', extension: 'mp4', video: true };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mimeType: 'video/webm', extension: 'webm', video: true };
  }
  return null;
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function errorResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { ...details, error: text },
    isError: true,
  };
}

const ShowMediaParams = Type.Object({
  path: Type.String({
    description: 'Path to a local MP4, MOV, WebM, PNG, JPEG, or WebP file. Relative paths use the chat workspace.',
  }),
  title: Type.Optional(Type.String({ description: 'Optional short label for the media.' })),
});

export function createShowMediaTool(
  conversationId: string,
  workspaceDir: string,
  persist: typeof saveAttachment = saveAttachment,
): ToolDefinition {
  return {
    name: SHOW_MEDIA_TOOL_NAME,
    label: 'Show Media',
    description:
      'Show a generated or local video or image inline in this chat. Use after saving a generated video, ' +
      'a generated start frame, or a generated end frame.',
    parameters: ShowMediaParams,
    async execute(_toolCallId, params) {
      const { path: rawPath, title } = params as Static<typeof ShowMediaParams>;
      const sourcePath = path.resolve(workspaceDir, rawPath);
      let size: number;
      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) return errorResult(`Not a file: ${sourcePath}`);
        size = info.size;
      } catch {
        return errorResult(`File not found: ${sourcePath}`);
      }
      const media = detectChatMedia(await readHeader(sourcePath));
      if (!media) return errorResult('Unsupported media. Use MP4, MOV, WebM, PNG, JPEG, or WebP.');
      const maxBytes = media.video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (size <= 0 || size > maxBytes) return errorResult(`Media must be between 1 byte and ${String(maxBytes)} bytes.`);

      const attachmentId = randomUUID();
      const baseName = title?.trim() || path.parse(sourcePath).name || (media.video ? 'video' : 'image');
      const safeBaseName = baseName.replace(/[^A-Za-z0-9._ -]+/g, '-').slice(0, 80) || 'media';
      const fileName = `${safeBaseName}.${media.extension}`;
      await persist(conversationId, attachmentId, fileName, await readFile(sourcePath));
      return {
        content: [{ type: 'text', text: `Showing ${fileName} in the chat.` }],
        details: {
          mediaAttachment: {
            attachmentId,
            fileName,
            mimeType: media.mimeType,
            size,
          },
          sourcePath,
        },
      };
    },
  };
}

const ChatImagePathParams = Type.Object({
  attachmentId: Type.String({
    description: 'Attachment id from an uploaded image file tag or a generated-image marker in this chat.',
  }),
});

export function createChatImagePathTool(
  conversationId: string,
  resolvePath: typeof resolveAttachmentPath = resolveAttachmentPath,
): ToolDefinition {
  return {
    name: GET_CHAT_IMAGE_PATH_TOOL_NAME,
    label: 'Chat Image Path',
    description:
      'Get the local file path for an image uploaded to or generated in this chat, for example to use it ' +
      'as a video first frame or last frame.',
    parameters: ChatImagePathParams,
    async execute(_toolCallId, params) {
      const { attachmentId } = params as Static<typeof ChatImagePathParams>;
      const filePath = await resolvePath(conversationId, attachmentId.trim());
      if (!filePath) return errorResult(`Image attachment not found: ${attachmentId}`);
      const media = detectChatMedia(await readHeader(filePath));
      if (!media || media.video) return errorResult('Attachment is not a PNG, JPEG, or WebP image.');
      return {
        content: [{ type: 'text', text: filePath }],
        details: { attachmentId, path: filePath, mimeType: media.mimeType },
      };
    },
  };
}

export function resolveBundledChatSkillPaths(
  roots: Array<string | undefined> = [
    process.resourcesPath ? path.join(process.resourcesPath, 'skills') : undefined,
    path.resolve(WORKSPACE_APPS_DIR, '..', 'skills'),
  ],
): string[] {
  for (const root of roots) {
    if (!root) continue;
    const paths = BUNDLED_CHAT_SKILL_NAMES
      .map((name) => path.join(root, name))
      .filter((skillPath) => existsSync(path.join(skillPath, 'SKILL.md')));
    if (paths.length > 0) return paths;
  }
  return [];
}
