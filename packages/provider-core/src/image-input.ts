/**
 * Pre-payment checks of an input image (a character or reference image) sent
 * inline as a data URL. Upstream limits on such images (size, aspect ratio,
 * bytes) would otherwise only fail after the buyer paid. Images given by URL
 * are left to the upstream: fetching them here would cost a request each.
 */

export interface ImageInputRule {
  maxBytes?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
}

/** Width and height of a PNG, JPEG, GIF or WebP image, or null when unreadable. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return positive(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
    return positive(b.readUInt16LE(6), b.readUInt16LE(8));
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return positive(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    if (chunk === 'VP8 ') return positive(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return positive((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) return null;
      const marker = b[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = b.readUInt16BE(offset + 2);
      // Start-of-frame markers (not DHT C4, JPG C8, DAC CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return positive(b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5));
      }
      offset += 2 + length;
    }
  }
  return null;
}

function positive(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * What is wrong with an inline image for this rule, or null when it fits or
 * is not a data URL. `field` names the request field in the message.
 */
export function imageInputProblem(value: unknown, rule: ImageInputRule, field: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  const header = comma > 0 ? value.slice(5, comma) : '';
  if (comma < 0 || !header.endsWith(';base64')) return `${field} must be a base64 data URL or a public https URL`;
  const bytes = Buffer.from(value.slice(comma + 1), 'base64');
  if (rule.maxBytes && bytes.length > rule.maxBytes) {
    return `${field} is ${(bytes.length / 1_000_000).toFixed(1)} MB; this model takes images up to ${(rule.maxBytes / 1_000_000).toFixed(1)} MB`;
  }
  const needsSize = rule.minWidth ?? rule.minHeight ?? rule.maxWidth ?? rule.maxHeight ?? rule.minAspectRatio ?? rule.maxAspectRatio;
  if (needsSize === undefined) return null;
  const size = imageDimensions(bytes);
  if (!size) return `Could not read the size of ${field}; send a PNG, JPEG or WebP image`;
  const { width, height } = size;
  if ((rule.minWidth && width < rule.minWidth) || (rule.minHeight && height < rule.minHeight)) {
    return `${field} is ${width}x${height}; this model needs at least ${rule.minWidth ?? 1}x${rule.minHeight ?? 1}`;
  }
  if ((rule.maxWidth && width > rule.maxWidth) || (rule.maxHeight && height > rule.maxHeight)) {
    return `${field} is ${width}x${height}; this model takes at most ${rule.maxWidth ?? '-'}x${rule.maxHeight ?? '-'}`;
  }
  const ratio = width / height;
  if ((rule.minAspectRatio && ratio < rule.minAspectRatio - 0.005) || (rule.maxAspectRatio && ratio > rule.maxAspectRatio + 0.005)) {
    return `${field} is ${width}x${height} (aspect ratio ${ratio.toFixed(2)}); this model takes ${rule.minAspectRatio ?? 0} to ${rule.maxAspectRatio ?? '∞'}`;
  }
  return null;
}
