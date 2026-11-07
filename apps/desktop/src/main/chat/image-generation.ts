import { servedPeerFromResponse } from './served-peer.js';
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayEndpoint } from '../gateway/service.js';
import { GATEWAY_PROVIDER_ID } from './gateway-model.js';
import { resolveAttachmentPath, saveAttachment } from './attachments/store.js';
import type { AiChatMessage } from './conversation-types.js';
import type { PiConversationStore } from './conversation-store.js';

// High-quality image models can legitimately take several minutes. Keep a
// finite ceiling, but do not abort healthy generations at the two-minute mark.
const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const UNSAFE_IPV4 = new BlockList();
const UNSAFE_IPV6 = new BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  (family === 'ipv4' ? UNSAFE_IPV4 : UNSAFE_IPV6).addSubnet(network, prefix, family);
}

export type GenerateChatImageRequest = {
  conversationId: string;
  prompt: string;
  moderation?: 'auto' | 'low';
  service: string;
  sourceImageAttachmentId?: string | null;
};

export type GenerateChatImageResult = {
  ok: boolean;
  user?: AiChatMessage;
  assistant?: AiChatMessage;
  error?: string;
  /** Set when the gateway could not pay, as a text reply's stop reports it. */
  stopReason?: { kind: 'payment_required'; message: string; errorCode?: string };
};

type ImageResponse = {
  data?: Array<{ url?: unknown; b64_json?: unknown }>;
  error?: { message?: unknown; code?: unknown };
};

function safeErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

function isUnsafeIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const version = isIP(host);
  return version === 4
    ? UNSAFE_IPV4.check(host, 'ipv4')
    : version === 6 && UNSAFE_IPV6.check(host, 'ipv6');
}

function validateRemoteImageUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8_192) throw new Error('Image service returned an invalid image URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Image service returned an unsafe image URL.');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isUnsafeIpLiteral(hostname)) {
    throw new Error('Image service returned an unsafe image URL.');
  }
  return url;
}

function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

function decodeBase64Image(value: unknown): { bytes: Buffer; mimeType: string } {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Image service returned invalid image data.');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) throw new Error('Image service returned invalid image data.');
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('Generated image exceeds the desktop size limit.');
  }
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) throw new Error('Image service returned an unsupported image format.');
  return { bytes: buffer, mimeType };
}

async function assertPublicHostname(url: URL): Promise<void> {
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isUnsafeIpLiteral(entry.address))) {
      throw new Error('Image service returned an unsafe image URL.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Image service returned an unsafe image URL.') throw error;
    throw new Error('Image service returned an invalid image URL.');
  }
}

async function downloadImage(value: unknown): Promise<{ bytes: Buffer; mimeType: string }> {
  const url = validateRemoteImageUrl(value);
  await assertPublicHostname(url);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
  });
  if (!response.ok) throw new Error(`Could not download generated image (HTTP ${String(response.status)}).`);
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('Image service returned an unsupported image format.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('Generated image exceeds the desktop size limit.');
  }
  if (!response.body) throw new Error('Image service returned invalid image data.');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_GENERATED_IMAGE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Generated image exceeds the desktop size limit.');
    }
    chunks.push(bytes);
  }
  if (totalBytes === 0) throw new Error('Image service returned invalid image data.');
  const bytes = Buffer.concat(chunks, totalBytes);
  if (detectImageMimeType(bytes) !== mimeType) {
    throw new Error('Image service returned content that does not match its image format.');
  }
  return { bytes, mimeType };
}

export type GenerateChatImageDependencies = {
  persistAttachment?: typeof saveAttachment;
  loadSourceAttachment?: (conversationId: string, attachmentId: string) => Promise<{ bytes: Buffer; fileName: string }>;
  signal?: AbortSignal;
  sellerName?: (peerId: string) => string | null;
};

async function loadSourceAttachment(conversationId: string, attachmentId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const filePath = await resolveAttachmentPath(conversationId, attachmentId);
  if (!filePath) throw new Error('The image to edit is no longer available.');
  return { bytes: await readFile(filePath), fileName: path.basename(filePath) };
}

export async function generateChatImage(
  store: Pick<PiConversationStore, 'appendImageGeneration'>,
  endpoint: GatewayEndpoint,
  request: GenerateChatImageRequest,
  dependencies: GenerateChatImageDependencies = {},
): Promise<GenerateChatImageResult> {
  const conversationId = request.conversationId.trim();
  const prompt = request.prompt.trim();
  const service = request.service.trim();
  const sourceImageAttachmentId = request.sourceImageAttachmentId?.trim() ?? '';
  if (!conversationId || !prompt || !service) {
    return { ok: false, error: 'Conversation, prompt, and image model are required.' };
  }

  try {
    let apiPath = '/v1/images/generations';
    let body: string | FormData;
    const headers: Record<string, string> = {
      authorization: `Bearer ${endpoint.apiKey}`,
      // The buyer routes only to sellers that take this option; it doesn't read it from the body.
      ...(request.moderation ? { 'x-antseed-required-parameters': 'moderation' } : {}),
    };
    if (sourceImageAttachmentId) {
      const source = await (dependencies.loadSourceAttachment ?? loadSourceAttachment)(conversationId, sourceImageAttachmentId);
      if (source.bytes.length === 0 || source.bytes.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error('The image to edit is invalid or exceeds the desktop size limit.');
      }
      const sourceMimeType = detectImageMimeType(source.bytes);
      if (!sourceMimeType) throw new Error('The image to edit uses an unsupported image format.');
      const form = new FormData();
      form.append('model', service);
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('response_format', 'b64_json');
      if (request.moderation) form.append('moderation', request.moderation);
      form.append('image', new Blob([source.bytes], { type: sourceMimeType }), source.fileName);
      apiPath = '/v1/images/edits';
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        model: service,
        prompt,
        n: 1,
        response_format: 'b64_json',
        ...(request.moderation ? { moderation: request.moderation } : {}),
      });
    }

    const response = await fetch(`${endpoint.origin}${apiPath}`, {
      method: 'POST',
      headers,
      body,
      signal: dependencies.signal
        ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });
    const peerId = servedPeerFromResponse(response);
    const peerName = peerId ? dependencies.sellerName?.(peerId) : null;
    const payload = await response.json().catch(() => null) as ImageResponse | null;
    if (!response.ok) {
      const upstreamMessage = typeof payload?.error?.message === 'string' ? payload.error.message : '';
      if (response.status === 402) {
        const message = upstreamMessage || 'Your gateway balance is too low to generate images. Add funds and try again.';
        const errorCode = typeof payload?.error?.code === 'string' ? payload.error.code : undefined;
        return { ok: false, error: message, stopReason: { kind: 'payment_required', message, ...(errorCode ? { errorCode } : {}) } };
      }
      throw new Error(upstreamMessage || `Image generation failed (HTTP ${String(response.status)}).`);
    }
    const image = payload?.data?.[0];
    if (!image) throw new Error('Image service returned no image.');
    const routedService = response.headers.get('x-antseed-service')?.trim() || service;

    let bytes: Buffer;
    let mimeType = 'image/png';
    if (typeof image.b64_json === 'string' && image.b64_json.length > 0) {
      const decoded = decodeBase64Image(image.b64_json);
      bytes = decoded.bytes;
      mimeType = decoded.mimeType;
    } else {
      const downloaded = await downloadImage(image.url);
      bytes = downloaded.bytes;
      mimeType = downloaded.mimeType;
    }

    const attachmentId = randomUUID();
    const extension = ALLOWED_IMAGE_MIME_TYPES.get(mimeType) ?? 'png';
    const fileName = `generated-${attachmentId.slice(0, 8)}.${extension}`;
    await (dependencies.persistAttachment ?? saveAttachment)(conversationId, attachmentId, fileName, bytes);
    const persistedMarker = `<generated-image id="${attachmentId}" mime="${mimeType}" name="${fileName}">`;
    const persisted = await store.appendImageGeneration(
      conversationId,
      prompt,
      persistedMarker,
      routedService,
      peerId ? { peerId, ...(peerName ? { peerName } : {}) } : null,
    );
    const user: AiChatMessage = { role: 'user', content: prompt, createdAt: persisted.user.timestamp };
    const assistant: AiChatMessage = {
      role: 'assistant',
      content: [{
        type: 'file',
        fileName,
        mimeType,
        size: bytes.length,
        status: 'ready',
        attachmentId,
        generated: true,
      }],
      createdAt: persisted.assistant.timestamp,
      meta: {
        provider: GATEWAY_PROVIDER_ID,
        service: routedService,
        tokenSource: 'unknown',
        outputImages: 1,
        ...(peerId ? { peerId } : {}),
        ...(peerName ? { peerName } : {}),
      },
    };
    return { ok: true, user, assistant };
  } catch (error) {
    if (dependencies.signal?.aborted) return { ok: false, error: 'Request aborted' };
    return { ok: false, error: safeErrorMessage(error, 'Image generation failed.') };
  }
}
