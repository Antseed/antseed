import { protocol } from 'electron';
import { mediaFileResponse } from '../chat/attachments/protocol.js';
import { STUDIO_SCHEME, studioMediaMimeType } from '../../shared/studio.js';
import { parseStudioUrl } from './protocol-url.js';
import { resolveStudioFile } from './store.js';

export function installStudioProtocol(): void {
  protocol.handle(STUDIO_SCHEME, async (request) => {
    const parsed = parseStudioUrl(request.url);
    if (!parsed) return new Response('Bad request', { status: 400 });
    const resolved = await resolveStudioFile(parsed.projectId, parsed.filePath);
    const contentType = resolved ? studioMediaMimeType(resolved) : undefined;
    if (!resolved || !contentType) return new Response('Not found', { status: 404 });
    return mediaFileResponse(resolved, contentType, request.headers.get('range'));
  });
}
