import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import type { ImageContent } from '@mariozechner/pi-ai';

export interface RawChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
}

export interface PreparedChatAttachment {
  id: string;
  /**
   * Stable server-generated identifier under which the raw bytes were
   * persisted on disk (via the storage callback passed to
   * `prepareChatAttachments`). The renderer uses this to build
   * `antseed-attachment://<conversationId>/<attachmentId>` URLs for the
   * in-chat preview. Absent when no storage callback was supplied.
   */
  attachmentId?: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'archive' | 'error';
  status: 'ready' | 'error';
  text?: string;
  image?: ImageContent;
  error?: string;
  truncated?: boolean;
  native?: { provider?: string; payload?: unknown };
}

/**
 * Callback invoked for every non-error attachment. It receives the decoded
 * bytes and must return (or resolve to) the stable `attachmentId` that will
 * be stored on the `PreparedChatAttachment` and embedded in the persisted
 * `<file id="...">` tag.
 */
export type AttachmentStorageCallback = (
  raw: Pick<RawChatAttachment, 'id' | 'name' | 'mimeType' | 'size'>,
  buffer: Buffer,
) => Promise<string> | string;

export interface PrepareChatAttachmentsOptions {
  limits?: AttachmentPreparationLimits;
  storage?: AttachmentStorageCallback;
}

export interface AttachmentPreparationLimits {
  maxAttachments: number;
  maxFileBytes: number;
  maxTotalRawBytes: number;
  maxExtractedCharsPerFile: number;
  maxExtractedCharsPerMessage: number;
  maxZipEntries: number;
  maxZipEntryBytes: number;
  maxZipInflatedBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentPreparationLimits = {
  maxAttachments: 5,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalRawBytes: 50 * 1024 * 1024,
  maxExtractedCharsPerFile: 120_000,
  maxExtractedCharsPerMessage: 250_000,
  maxZipEntries: 200,
  maxZipEntryBytes: 10 * 1024 * 1024,
  maxZipInflatedBytes: 50 * 1024 * 1024,
};

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const OFFICE_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.rtf']);
const ARCHIVE_EXTENSIONS = new Set(['.zip']);
const REJECTED_EXTENSIONS = new Set([
  '.app', '.bat', '.cmd', '.com', '.dll', '.dmg', '.exe', '.jar', '.msi', '.ps1', '.scr',
]);
const TEXT_EXTENSIONS = new Set([
  '.bash', '.c', '.conf', '.cpp', '.cs', '.css', '.csv', '.diff', '.env', '.go', '.h', '.hpp',
  '.htm', '.html', '.ini', '.java', '.js', '.json', '.jsonl', '.jsx', '.less', '.log', '.lua',
  '.md', '.markdown', '.mjs', '.php', '.patch', '.properties', '.py', '.rb', '.rs', '.sass',
  '.scss', '.sh', '.sql', '.svg', '.svelte', '.toml', '.ts', '.tsv', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml', '.zsh',
]);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/yaml',
  'image/svg+xml',
]);
const require = createRequire(import.meta.url);

type OfficeParserModule = {
  parseOffice?: (input: Buffer | Uint8Array | ArrayBuffer, config?: Record<string, unknown>) => Promise<{ toText: () => string }>;
  default?: {
    parseOffice?: (input: Buffer | Uint8Array | ArrayBuffer, config?: Record<string, unknown>) => Promise<{ toText: () => string }>;
  };
};

function normalizeName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : 'attachment';
}

function extensionFor(name: string): string {
  return path.extname(name).toLowerCase();
}

function normalizeMime(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function resolvePdfWorkerSrc(): string {
  const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
  return pathToFileURL(workerPath).href;
}

function safeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  const ms = 30_000;
  const label = 'Document text extraction';
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function neutralizeFileTags(text: string): string {
  // Insert a literal backslash so the tag no longer parses as a `<file>` /
  // `<zip-entry>` wrapper when the prompt is round-tripped through Pi
  // history or the conversation reloader. Note: the replacement strings use
  // doubled backslashes because JS ignores `\z` and treats `\f` as form-feed,
  // so `'<\file'` would silently become `<\x0Cile` and `'<\zip-entry'` would
  // become the unchanged `<zip-entry` (a no-op replacement).
  return text
    .replace(/<\/file>/gi, '<\\/file>')
    .replace(/<file\b/gi, '<\\file')
    .replace(/<\/zip-entry>/gi, '<\\/zip-entry>')
    .replace(/<zip-entry\b/gi, '<\\zip-entry');
}

function isImageAttachment(name: string, mimeType: string): boolean {
  const ext = extensionFor(name);
  const mime = normalizeMime(mimeType);
  return IMAGE_MIME_TYPES.has(mime)
    || (mime.length === 0 && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext));
}

function isOfficeAttachment(name: string): boolean {
  return OFFICE_EXTENSIONS.has(extensionFor(name));
}

function isArchiveAttachment(name: string, mimeType: string): boolean {
  const mime = normalizeMime(mimeType);
  return ARCHIVE_EXTENSIONS.has(extensionFor(name)) || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

function isTextAttachment(name: string, mimeType: string): boolean {
  const ext = extensionFor(name);
  const mime = normalizeMime(mimeType);
  return TEXT_EXTENSIONS.has(ext)
    || TEXT_MIME_TYPES.has(mime)
    || TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isRejectedExecutable(name: string): boolean {
  return REJECTED_EXTENSIONS.has(extensionFor(name));
}

function makeError(raw: Pick<RawChatAttachment, 'id' | 'name' | 'mimeType' | 'size'>, error: string): PreparedChatAttachment {
  return {
    id: raw.id,
    name: normalizeName(raw.name),
    mimeType: raw.mimeType || 'application/octet-stream',
    size: raw.size,
    kind: 'error',
    status: 'error',
    error,
  };
}

function decodeBase64(raw: RawChatAttachment): Buffer {
  const value = raw.base64.includes(',') ? raw.base64.split(',').pop() ?? '' : raw.base64;
  return Buffer.from(value, 'base64');
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars))}\n\n[Attachment truncated: extracted text exceeded limit.]`,
    truncated: true,
  };
}

function wrapFileText(
  name: string,
  mimeType: string,
  size: number,
  text: string,
  options: { note?: string; attachmentId?: string } = {},
): string {
  const idAttr = options.attachmentId ? ` id="${safeAttribute(options.attachmentId)}"` : '';
  const header = `<file name="${safeAttribute(name)}" mime="${safeAttribute(mimeType || 'application/octet-stream')}" size="${size}"${idAttr}>`;
  const body = options.note ? `${options.note}\n\n${text}` : text;
  return `${header}\n${neutralizeFileTags(body)}\n</file>`;
}

async function extractOfficeText(buffer: Buffer): Promise<string> {
  const mod = await import('officeparser') as OfficeParserModule;
  const parseOffice = mod.parseOffice ?? mod.default?.parseOffice;
  if (!parseOffice) {
    throw new Error('officeparser did not expose parseOffice');
  }
  const ast = await parseOffice(buffer, {
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
    outputErrorToConsole: false,
    pdfWorkerSrc: resolvePdfWorkerSrc(),
  });
  return ast.toText().trim();
}

function decodeText(buffer: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/^\uFEFF/, '');
}

function isUnsafeZipEntryName(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return true;
  return normalized.split('/').some((part) => part === '..');
}

function prepareTextResult(
  raw: Pick<RawChatAttachment, 'id' | 'name' | 'mimeType' | 'size'>,
  kind: PreparedChatAttachment['kind'],
  extractedText: string,
  limits: AttachmentPreparationLimits,
  remainingMessageChars: number,
  options: { note?: string; attachmentId?: string } = {},
): { attachment: PreparedChatAttachment; consumedChars: number } {
  const cleanText = extractedText.trim();
  const perFileCap = Math.min(limits.maxExtractedCharsPerFile, remainingMessageChars);
  const truncated = truncateText(cleanText, perFileCap);
  const wrapped = wrapFileText(
    normalizeName(raw.name),
    raw.mimeType || 'text/plain',
    raw.size,
    truncated.text || '[No extractable text found.]',
    { ...(options.note ? { note: options.note } : {}), ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}) },
  );
  return {
    attachment: {
      id: raw.id,
      ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}),
      name: normalizeName(raw.name),
      mimeType: raw.mimeType || 'text/plain',
      size: raw.size,
      kind,
      status: 'ready',
      text: wrapped,
      truncated: truncated.truncated,
    },
    consumedChars: truncated.text.length,
  };
}

function prepareZipAttachment(
  raw: RawChatAttachment,
  buffer: Buffer,
  limits: AttachmentPreparationLimits,
  remainingMessageChars: number,
  attachmentId?: string,
): { attachment: PreparedChatAttachment; consumedChars: number } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer);
  } catch (error) {
    return { attachment: makeError(raw, `Could not read ZIP archive: ${error instanceof Error ? error.message : String(error)}`), consumedChars: 0 };
  }

  const names = Object.keys(entries);
  const manifest: string[] = [];
  const textParts: string[] = [];
  let inflatedBytes = 0;
  let scanned = 0;

  for (const entryName of names) {
    if (scanned >= limits.maxZipEntries) {
      manifest.push(`- skipped remaining entries: archive has more than ${limits.maxZipEntries} entries`);
      break;
    }
    scanned += 1;

    const normalizedEntryName = entryName.replace(/\\/g, '/');
    if (normalizedEntryName.endsWith('/')) continue;
    if (isUnsafeZipEntryName(entryName)) {
      return { attachment: makeError(raw, `ZIP archive contains unsafe path: ${entryName}`), consumedChars: 0 };
    }

    const data = entries[entryName];
    if (!data) continue;
    inflatedBytes += data.byteLength;
    if (inflatedBytes > limits.maxZipInflatedBytes) {
      manifest.push(`- skipped ${normalizedEntryName}: archive inflated content exceeded ${limits.maxZipInflatedBytes} bytes`);
      break;
    }
    if (data.byteLength > limits.maxZipEntryBytes) {
      manifest.push(`- skipped ${normalizedEntryName}: entry exceeds ${limits.maxZipEntryBytes} bytes`);
      continue;
    }
    if (isArchiveAttachment(normalizedEntryName, '') || isRejectedExecutable(normalizedEntryName)) {
      manifest.push(`- skipped ${normalizedEntryName}: unsupported nested archive or executable`);
      continue;
    }
    if (!isTextAttachment(normalizedEntryName, '')) {
      manifest.push(`- skipped ${normalizedEntryName}: unsupported binary entry`);
      continue;
    }
    const text = decodeText(data);
    manifest.push(`- included ${normalizedEntryName} (${data.byteLength} bytes)`);
    textParts.push(`<zip-entry name="${safeAttribute(normalizedEntryName)}">\n${neutralizeFileTags(text)}\n</zip-entry>`);
  }

  const archiveText = [
    'ZIP manifest:',
    ...manifest,
    '',
    ...textParts,
  ].join('\n');
  return prepareTextResult(raw, 'archive', archiveText, limits, remainingMessageChars, {
    note: 'Archive was inspected in memory. Only safe text entries were included.',
    ...(attachmentId ? { attachmentId } : {}),
  });
}

async function prepareOneAttachment(
  raw: RawChatAttachment,
  buffer: Buffer,
  limits: AttachmentPreparationLimits,
  remainingMessageChars: number,
  attachmentId?: string,
): Promise<{ attachment: PreparedChatAttachment; consumedChars: number }> {
  const name = normalizeName(raw.name);
  const mimeType = raw.mimeType || 'application/octet-stream';

  if (isImageAttachment(name, mimeType)) {
    return {
      attachment: {
        id: raw.id,
        ...(attachmentId ? { attachmentId } : {}),
        name,
        mimeType,
        size: raw.size,
        kind: 'image',
        status: 'ready',
        image: { type: 'image', data: buffer.toString('base64'), mimeType: normalizeMime(mimeType) || mimeType },
      },
      consumedChars: 0,
    };
  }

  if (isRejectedExecutable(name)) {
    return { attachment: makeError(raw, `Unsupported executable or script file type: ${extensionFor(name)}`), consumedChars: 0 };
  }

  if (isArchiveAttachment(name, mimeType)) {
    return prepareZipAttachment(raw, buffer, limits, remainingMessageChars, attachmentId);
  }

  if (isOfficeAttachment(name)) {
    try {
      const extracted = await withTimeout(extractOfficeText(buffer));
      return prepareTextResult(raw, 'text', extracted, limits, remainingMessageChars, {
        note: 'Document text was extracted without OCR or embedded attachments.',
        ...(attachmentId ? { attachmentId } : {}),
      });
    } catch (error) {
      return { attachment: makeError(raw, `Could not extract document text: ${error instanceof Error ? error.message : String(error)}`), consumedChars: 0 };
    }
  }

  if (isTextAttachment(name, mimeType)) {
    return prepareTextResult(raw, 'text', decodeText(buffer), limits, remainingMessageChars, {
      ...(attachmentId ? { attachmentId } : {}),
    });
  }

  return { attachment: makeError(raw, `Unsupported binary file type: ${extensionFor(name) || mimeType || 'unknown'}`), consumedChars: 0 };
}

function isLimits(value: AttachmentPreparationLimits | PrepareChatAttachmentsOptions): value is AttachmentPreparationLimits {
  return typeof (value as AttachmentPreparationLimits).maxAttachments === 'number';
}

export async function prepareChatAttachments(
  rawAttachments: RawChatAttachment[] | undefined,
  limitsOrOptions: AttachmentPreparationLimits | PrepareChatAttachmentsOptions = DEFAULT_ATTACHMENT_LIMITS,
): Promise<PreparedChatAttachment[]> {
  if (!rawAttachments?.length) return [];

  // Backward compatibility: callers may pass `AttachmentPreparationLimits`
  // directly (as the tests do) or the newer options bag.
  const options: PrepareChatAttachmentsOptions = isLimits(limitsOrOptions)
    ? { limits: limitsOrOptions }
    : limitsOrOptions;
  const limits = options.limits ?? DEFAULT_ATTACHMENT_LIMITS;
  const storage = options.storage;

  const prepared: PreparedChatAttachment[] = [];
  let totalRawBytes = 0;
  let totalExtractedChars = 0;

  for (let index = 0; index < rawAttachments.length; index += 1) {
    const raw = rawAttachments[index]!;
    const name = normalizeName(raw.name);
    const rawMeta = { ...raw, name };

    if (index >= limits.maxAttachments) {
      prepared.push(makeError(rawMeta, `Only ${limits.maxAttachments} attachments are allowed per message.`));
      continue;
    }
    if (totalRawBytes + raw.size > limits.maxTotalRawBytes) {
      prepared.push(makeError(rawMeta, `Attachments exceed the ${limits.maxTotalRawBytes} byte per-message limit.`));
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = decodeBase64(raw);
    } catch {
      prepared.push(makeError(rawMeta, 'Attachment data is not valid base64.'));
      continue;
    }

    if (buffer.byteLength > limits.maxFileBytes) {
      prepared.push(makeError(rawMeta, `File exceeds the ${limits.maxFileBytes} byte per-file limit.`));
      continue;
    }
    if (totalRawBytes + buffer.byteLength > limits.maxTotalRawBytes) {
      prepared.push(makeError(rawMeta, `Attachments exceed the ${limits.maxTotalRawBytes} byte per-message limit.`));
      continue;
    }
    totalRawBytes += buffer.byteLength;

    // Persist raw bytes first when the caller provided a storage callback.
    // Failures are recorded as errors for this attachment but don't abort
    // the batch — the LLM pipeline can still receive extracted text for
    // other files.
    let attachmentId: string | undefined;
    if (storage) {
      try {
        attachmentId = await storage(rawMeta, buffer);
      } catch (error) {
        prepared.push(makeError(rawMeta, `Could not persist attachment: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
    }

    const remainingChars = Math.max(0, limits.maxExtractedCharsPerMessage - totalExtractedChars);
    const result = await prepareOneAttachment(rawMeta, buffer, limits, remainingChars, attachmentId);
    totalExtractedChars += result.consumedChars;
    prepared.push(result.attachment);
  }

  return prepared;
}

export function buildAttachmentPromptText(attachments: PreparedChatAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  return attachments
    .filter((attachment) => attachment.status === 'ready' && attachment.text)
    .map((attachment) => attachment.text)
    .join('\n\n')
    .trim();
}

export function extractAttachmentImages(attachments: PreparedChatAttachment[] | undefined): ImageContent[] {
  if (!attachments?.length) return [];
  return attachments
    .filter((attachment): attachment is PreparedChatAttachment & { image: ImageContent } =>
      attachment.status === 'ready' && attachment.kind === 'image' && Boolean(attachment.image))
    .map((attachment) => attachment.image);
}
