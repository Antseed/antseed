// ── Telegram media classification ──
// Pure helpers shared by the bridge: extracting image file blocks from
// assistant payloads (outgoing) and classifying inbound media messages.
// Kept free of electron imports so node:test can exercise them directly.

export type TgPhotoSizeLike = {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
};

export type ImageFileBlock = {
  fileName: string;
  mimeType: string;
  attachmentId: string;
};

/** Image file blocks (generated images, image attachments) whose bytes live in the attachment store. */
export function extractImageFileBlocks(content: unknown): ImageFileBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ImageFileBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; fileName?: unknown; mimeType?: unknown; attachmentId?: unknown };
    if (block.type !== 'file') continue;
    if (typeof block.attachmentId !== 'string' || block.attachmentId.length === 0) continue;
    if (typeof block.mimeType !== 'string' || !block.mimeType.startsWith('image/')) continue;
    blocks.push({
      fileName: typeof block.fileName === 'string' && block.fileName.length > 0 ? block.fileName : 'image',
      mimeType: block.mimeType,
      attachmentId: block.attachmentId,
    });
  }
  return blocks;
}

export function extractImageFileBlocksFromUiMessage(payload: unknown): ImageFileBlock[] {
  const message = (payload as { message?: { content?: unknown } } | null)?.message;
  return extractImageFileBlocks(message?.content);
}

/** Telegram photo messages carry a size ladder; the largest entry has the full resolution. */
export function pickLargestPhoto(photo: unknown): TgPhotoSizeLike | null {
  if (!Array.isArray(photo)) return null;
  let best: TgPhotoSizeLike | null = null;
  for (const raw of photo) {
    if (!raw || typeof raw !== 'object') continue;
    const size = raw as Partial<TgPhotoSizeLike>;
    if (typeof size.file_id !== 'string' || size.file_id.length === 0) continue;
    if (!best || (size.file_size ?? -1) > (best.file_size ?? -1)) best = size as TgPhotoSizeLike;
  }
  return best;
}

/** A media message the bridge can download and attach to a conversation. */
export type DownloadableTgMedia = {
  kind: 'photo' | 'document';
  fileId: string;
  fileName: string;
  mimeType: string;
  /** Best-known byte size from the update payload; used to pre-reject oversized files. */
  approxBytes?: number;
};

/** Media the bot recognises but cannot process yet. */
export type UnsupportedTgMedia = {
  kind: 'unsupported';
  /** Human-readable media name for the "not supported" notice. */
  label: string;
};

export type IncomingTgMedia = DownloadableTgMedia | UnsupportedTgMedia;

const DOCUMENT_FALLBACK_EXTENSION_MIME = new Map([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
]);

function mimeForDocument(fileName: string, mimeType?: string): string {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalized) return normalized;
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return DOCUMENT_FALLBACK_EXTENSION_MIME.get(ext) ?? 'application/octet-stream';
}

/**
 * Maps an inbound message to what the bridge can do with it:
 * a downloadable attachment (photo/document), an explicitly unsupported
 * medium worth a helpful notice about, or null when the message carries no
 * media at all (plain text — or something so exotic the generic
 * "text only" fallback covers it).
 */
export function classifyIncomingMedia(message: {
  date?: number;
  text?: string;
  caption?: string;
  photo?: unknown;
  document?: { file_id?: unknown; file_name?: unknown; mime_type?: unknown; file_size?: unknown } | null;
  voice?: unknown;
  video_note?: unknown;
  video?: unknown;
  audio?: unknown;
}): IncomingTgMedia | null {
  if (message.voice) return { kind: 'unsupported', label: 'Voice messages' };
  if (message.video_note) return { kind: 'unsupported', label: 'Video messages' };
  if (message.audio) return { kind: 'unsupported', label: 'Audio files' };
  if (message.video) return { kind: 'unsupported', label: 'Videos' };

  const photo = pickLargestPhoto(message.photo);
  if (photo) {
    return {
      kind: 'photo',
      fileId: photo.file_id,
      // Telegram photos are always JPEG regardless of how they were uploaded.
      fileName: `photo-${message.date ?? 0}.jpg`,
      mimeType: 'image/jpeg',
      ...(photo.file_size != null ? { approxBytes: photo.file_size } : {}),
    };
  }

  const doc = message.document;
  if (doc && typeof doc === 'object' && typeof doc.file_id === 'string' && doc.file_id.length > 0) {
    const fileName = typeof doc.file_name === 'string' && doc.file_name.trim().length > 0
      ? doc.file_name.trim()
      : 'document';
    const fileSize = typeof doc.file_size === 'number' ? doc.file_size : undefined;
    return {
      kind: 'document',
      fileId: doc.file_id,
      fileName,
      mimeType: mimeForDocument(fileName, typeof doc.mime_type === 'string' ? doc.mime_type : undefined),
      ...(fileSize != null ? { approxBytes: fileSize } : {}),
    };
  }

  return null;
}
