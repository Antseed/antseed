import { describe, expect, it } from 'vitest';
import { imageDimensions, imageInputProblem } from './image-input.js';

const png = (width: number, height: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
};
const jpeg = (width: number, height: number) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const gif = (width: number, height: number) => {
  const b = Buffer.alloc(13); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(width, 6); b.writeUInt16LE(height, 8); return b;
};
const webpX = (width: number, height: number) => {
  const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b;
};
const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`;

describe('input image checks', () => {
  it('reads the size of PNG, JPEG, GIF and WebP images', () => {
    expect(imageDimensions(png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(gif(10, 20))).toEqual({ width: 10, height: 20 });
    expect(imageDimensions(webpX(4000, 300))).toEqual({ width: 4000, height: 300 });
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull();
  });

  it('refuses inline images outside the model limits', () => {
    const rule = { minWidth: 340, minHeight: 340, maxWidth: 3850, maxHeight: 3850, minAspectRatio: 0.4, maxAspectRatio: 2.5, maxBytes: 10_485_760 };
    expect(imageInputProblem(dataUrl(png(800, 600)), rule, 'image_url')).toBeNull();
    expect(imageInputProblem(dataUrl(png(200, 600)), rule, 'image_url')).toMatch(/image_url is 200x600; this model needs at least 340x340/);
    expect(imageInputProblem(dataUrl(png(3000, 400)), rule, 'image_url')).toMatch(/aspect ratio 7.50/);
    expect(imageInputProblem(dataUrl(Buffer.from('xx')), rule, 'image_url')).toMatch(/Could not read the size/);
    expect(imageInputProblem(dataUrl(Buffer.alloc(100)), { maxBytes: 10 }, 'image_url')).toMatch(/up to/);
    expect(imageInputProblem('data:image/png,abc', rule, 'image_url')).toMatch(/base64 data URL/);
    // A URL is left to the upstream.
    expect(imageInputProblem('https://example.com/a.png', rule, 'image_url')).toBeNull();
    expect(imageInputProblem(undefined, rule, 'image_url')).toBeNull();
  });
});
