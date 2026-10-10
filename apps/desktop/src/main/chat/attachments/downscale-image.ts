import { nativeImage } from 'electron';
import type { ImageContent } from '@mariozechner/pi-ai';

/** Longest edge vision models read; larger images only add upload bytes. */
const MAX_IMAGE_EDGE = 1568;
const JPEG_QUALITY = 85;

/**
 * Shrinks PNG and JPEG attachments to MAX_IMAGE_EDGE, keeping their format.
 * Every turn resends the image, so this saves upload bytes on each request.
 * Other formats, and images Electron cannot decode, are returned unchanged.
 */
export function downscaleChatImage(image: ImageContent): ImageContent {
  if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') return image;

  const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'));
  const { width, height } = decoded.getSize();
  const longestEdge = Math.max(width, height);
  if (decoded.isEmpty() || longestEdge <= MAX_IMAGE_EDGE) return image;

  const scale = MAX_IMAGE_EDGE / longestEdge;
  const resized = decoded.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'best',
  });
  const encoded = image.mimeType === 'image/png' ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY);
  return { ...image, data: encoded.toString('base64') };
}
