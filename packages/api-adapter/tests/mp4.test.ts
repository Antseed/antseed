import { describe, expect, it } from 'vitest';
import { createMp4Inspector, nativeVideoDelivered } from '../src/index.js';

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  return out;
}

function mvhd(durationMs: number, version: 0 | 1 = 0): Uint8Array {
  const body = new Uint8Array(version === 1 ? 32 : 20);
  const view = new DataView(body.buffer);
  body[0] = version;
  const fields = version === 1 ? 20 : 12;
  view.setUint32(fields, 1000);
  if (version === 1) view.setBigUint64(fields + 4, BigInt(durationMs));
  else view.setUint32(fields + 4, durationMs);
  return box('mvhd', body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function mp4(durationMs: number, options: { moovLast?: boolean; version?: 0 | 1 } = {}): Uint8Array {
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
  const moov = box('moov', mvhd(durationMs, options.version));
  const mdat = box('mdat', new Uint8Array(5000).fill(7));
  return options.moovLast ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
}

function inspect(bytes: Uint8Array, chunkSize = bytes.length) {
  const inspector = createMp4Inspector();
  for (let offset = 0; offset < bytes.length; offset += chunkSize) inspector.update(bytes.subarray(offset, offset + chunkSize));
  return inspector.finish();
}

function delivered(bytes: Uint8Array, requestedSeconds?: number, contentType = 'video/mp4') {
  const facts = inspect(bytes);
  return nativeVideoDelivered({
    requestId: 'r', statusCode: 200, headers: { 'content-type': contentType }, body: new Uint8Array(),
    streamedBody: { byteLength: bytes.length, responseHash: '0x', ...(facts ? { videoDurationMs: facts.durationMs } : {}) },
  }, requestedSeconds);
}

describe('createMp4Inspector', () => {
  it('reads the duration with moov before or after the media, in any chunk size', () => {
    for (const chunkSize of [1, 3, 7, 64, 100_000]) {
      expect(inspect(mp4(10_000), chunkSize)).toEqual({ durationMs: 10_000 });
      expect(inspect(mp4(5_000, { moovLast: true }), chunkSize)).toEqual({ durationMs: 5_000 });
      expect(inspect(mp4(8_000, { version: 1 }), chunkSize)).toEqual({ durationMs: 8_000 });
    }
  });

  it('rejects bytes that are not a complete MP4', () => {
    expect(inspect(new TextEncoder().encode('<html>error</html>'))).toBeNull();
    expect(inspect(new Uint8Array(1000).fill(9))).toBeNull();
    const full = mp4(10_000);
    expect(inspect(full.subarray(0, full.length - 10))).toBeNull();
    expect(inspect(mp4(10_000, { moovLast: true }).subarray(0, 5030))).toBeNull();
  });
});

describe('nativeVideoDelivered for streamed downloads', () => {
  it('requires a real MP4 of most of the requested length', () => {
    expect(delivered(mp4(10_000), 10)).toBe(true);
    expect(delivered(mp4(9_000), 10)).toBe(true);
    expect(delivered(mp4(8_999), 10)).toBe(false);
    expect(delivered(mp4(2_000), 10)).toBe(false);
    expect(delivered(mp4(2_000))).toBe(true);
    expect(delivered(mp4(10_000), 10, 'text/html')).toBe(false);
    expect(delivered(new TextEncoder().encode('not a video'), 10)).toBe(false);
  });
});
