/**
 * Pure URL parsing helpers for the attachment protocol.
 *
 * Split out from `attachment-protocol.ts` (which imports from Electron) so
 * unit tests can verify the parsing rules under plain Node without
 * pulling in the Electron runtime.
 */

export const ATTACHMENT_SCHEME = 'antseed-attachment';

export type ParsedAttachmentUrl = {
  conversationId: string;
  attachmentId: string;
};

/**
 * Extract `(conversationId, attachmentId)` from a protocol URL.
 *
 * Only the first path segment is treated as the attachment id — extra
 * segments are ignored, so a buggy or hostile renderer can't tack on
 * `/../something` to escape the intended layout.
 */
export function parseAttachmentUrl(rawUrl: string): ParsedAttachmentUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${ATTACHMENT_SCHEME}:`) return null;

  const conversationId = decodeSafe(url.hostname);
  const firstSegment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  const attachmentId = decodeSafe(firstSegment);
  if (!conversationId || !attachmentId) return null;
  return { conversationId, attachmentId };
}

function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'invalid';
  return { start, end };
}
