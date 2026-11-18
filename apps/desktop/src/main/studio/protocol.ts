import { protocol } from 'electron';
import path from 'node:path';
import { mediaFileResponse } from '../chat/attachments/protocol.js';
import { STUDIO_SCHEME } from '../../shared/studio.js';
import { parseStudioUrl } from './protocol-url.js';
import { resolveStudioFile } from './store.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export function installStudioProtocol(): void {
  protocol.handle(STUDIO_SCHEME, async (request) => {
    const parsed = parseStudioUrl(request.url);
    if (!parsed) return new Response('Bad request', { status: 400 });
    const resolved = await resolveStudioFile(parsed.projectId, parsed.filePath);
    const contentType = resolved ? MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()] : undefined;
    if (!resolved || !contentType) return new Response('Not found', { status: 404 });
    return mediaFileResponse(resolved, contentType, request.headers.get('range'));
  });
}
