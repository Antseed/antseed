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

function fullBox(type: string, version: number, body: Uint8Array): Uint8Array {
  return box(type, concat(new Uint8Array([version, 0, 0, 0]), body));
}

/** A video track: tkhd (size, duration in movie units of 1000/s), mdhd (timescale 600), hdlr vide, stts. */
function videoTrak(options: { durationMs: number; width: number; height: number; fps: number; rotate?: boolean }): Uint8Array {
  const tkhd = new Uint8Array(80);
  const t = new DataView(tkhd.buffer);
  t.setUint32(16, options.durationMs);
  const matrix = 36;
  if (options.rotate) { t.setInt32(matrix + 4, 0x10000); t.setInt32(matrix + 12, -0x10000); }
  else { t.setInt32(matrix, 0x10000); t.setInt32(matrix + 16, 0x10000); }
  t.setUint32(matrix + 32, 0x40000000);
  t.setUint32(72, options.width * 65536);
  t.setUint32(76, options.height * 65536);
  const timescale = 600;
  const mdhd = new Uint8Array(20);
  const m = new DataView(mdhd.buffer);
  m.setUint32(8, timescale);
  m.setUint32(12, Math.round(options.durationMs * timescale / 1000));
  const hdlr = new Uint8Array(21);
  hdlr.set(new TextEncoder().encode('vide'), 4);
  const frames = Math.round(options.durationMs * options.fps / 1000);
  const stts = new Uint8Array(12);
  const s = new DataView(stts.buffer);
  s.setUint32(0, 1);
  s.setUint32(4, frames);
  s.setUint32(8, Math.round(timescale / options.fps));
  return box('trak', concat(
    fullBox('tkhd', 0, tkhd.subarray(0, 80)),
    box('mdia', concat(fullBox('mdhd', 0, mdhd), fullBox('hdlr', 0, hdlr), box('minf', box('stbl', fullBox('stts', 0, stts))))),
  ));
}

describe('mp4 track facts', () => {
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
  const file = (mvhdMs: number, trak: Uint8Array) => concat(ftyp, box('moov', concat(mvhd(mvhdMs), trak)), box('mdat', new Uint8Array(100)));

  it('reads the track length, size and frame rate', () => {
    const facts = inspect(file(6_000, videoTrak({ durationMs: 6_000, width: 864, height: 496, fps: 25 })), 7);
    expect(facts?.durationMs).toBe(6_000);
    expect(facts?.trackDurationMs).toBe(6_000);
    expect(facts?.video).toEqual({ width: 864, height: 496, fps: 25 });
  });

  it('shows the real length of a file whose mvhd was edited to look shorter', () => {
    const facts = inspect(file(6_500, videoTrak({ durationMs: 37_250, width: 864, height: 496, fps: 24 })));
    expect(facts?.durationMs).toBe(6_500);
    expect(facts?.trackDurationMs).toBeGreaterThanOrEqual(37_000);
  });

  it('swaps the display size of a rotated track', () => {
    expect(inspect(file(5_000, videoTrak({ durationMs: 5_000, width: 1280, height: 720, fps: 30, rotate: true })))?.video)
      .toEqual({ width: 720, height: 1280, fps: 30 });
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
