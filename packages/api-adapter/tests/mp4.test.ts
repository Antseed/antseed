import { describe, expect, it } from 'vitest';
import { createMp4Inspector, nativeVideoDelivered, videoSourceLengthProblem } from '../src/index.js';
import { inlineVideoSeconds } from '../src/mp4.js';

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

describe('inline source length', () => {
  const dataUrl = (bytes: Uint8Array, mime = 'video/mp4') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const ftyp = () => box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
  const u32 = (...values: number[]) => {
    const out = new Uint8Array(values.length * 4);
    values.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value));
    return out;
  };
  interface TrackOptions { handler?: string; samples?: [count: number, delta: number]; sampleSizes?: number; elstMs?: number }
  /** A track (timescales 1000) whose media header, sample table and optional edit list say how long it is. */
  const track = (ms: number, options: TrackOptions = {}) => {
    const { handler = 'vide', samples = [1, ms], sampleSizes = samples[0], elstMs } = options;
    const mdhd = mvhd(ms).slice();
    mdhd.set(new TextEncoder().encode('mdhd'), 4);
    const hdlr = box('hdlr', concat(u32(0, 0), new TextEncoder().encode(handler), u32(0, 0, 0), new Uint8Array(1)));
    const stbl = box('stbl', concat(box('stts', u32(0, 1, ...samples)), box('stsz', u32(0, 0, sampleSizes))));
    const edts = elstMs === undefined ? new Uint8Array(0) : box('edts', box('elst', u32(0, 1, elstMs, 0, 0x10000)));
    return box('trak', concat(edts, box('mdia', concat(mdhd, hdlr, box('minf', stbl)))));
  };
  const file = (movieMs: number, ...tracks: Uint8Array[]) =>
    dataUrl(concat(ftyp(), box('moov', concat(mvhd(movieMs), ...tracks)), box('mdat', new Uint8Array(64))));

  it('measures the source in whole seconds, rounded down', () => {
    expect(inlineVideoSeconds(file(12_700, track(12_700)))).toBe(12);
    expect(inlineVideoSeconds(file(600, track(600)))).toBe(0);
    expect(inlineVideoSeconds(file(5_000, track(5_000)).replace('video/mp4', 'video/quicktime'))).toBe(5);
  });

  it('measures a file whose headers claim a shorter length at its real one', () => {
    // Every header says 3 s, the samples add up to 300 x 41 ms = 12.3 s.
    expect(inlineVideoSeconds(file(3_000, track(3_000, { samples: [300, 41] })))).toBe(12);
    // A sample table that counts 1 of 300 samples hides the rest: refused.
    expect(inlineVideoSeconds(file(1_000, track(1_000, { samples: [1, 1_000], sampleSizes: 300 })))).toBeNull();
  });

  it('measures a trimmed track by its edit list, not its leftover samples', () => {
    // A copy trim keeps samples from the previous keyframe (4.5 s) and plays 3.2 s of them.
    expect(inlineVideoSeconds(file(3_200, track(4_500, { elstMs: 3_200 })))).toBe(3);
  });

  it('measures video tracks only', () => {
    // A 7.2 s audio track next to a 5.1 s video: the upstream renders 5 s.
    expect(inlineVideoSeconds(file(7_200, track(5_100), track(7_200, { handler: 'soun' })))).toBe(5);
    expect(inlineVideoSeconds(file(7_200, track(7_200, { handler: 'soun' })))).toBeNull();
  });

  it('is null for anything but a readable inline MP4', () => {
    expect(inlineVideoSeconds('https://example.com/source.mp4')).toBeNull();
    expect(inlineVideoSeconds(file(5_000, track(5_000)).replace('video/mp4', 'image/png'))).toBeNull();
    expect(inlineVideoSeconds('data:video/mp4;base64,!!!')).toBeNull();
    expect(inlineVideoSeconds(dataUrl(new TextEncoder().encode('<html>')))).toBeNull();
    expect(inlineVideoSeconds(undefined)).toBeNull();
    // Fragmented: the samples are in moof boxes outside moov.
    expect(inlineVideoSeconds(file(0, track(0), box('mvex', new Uint8Array(0))))).toBeNull();
    // A track box that runs past moov hides the real track: refused, not measured from mvhd.
    const overrun = track(12_000);
    new DataView(overrun.buffer).setUint32(0, overrun.length + 100);
    expect(inlineVideoSeconds(file(3_000, overrun))).toBeNull();
    // A media timescale of 0 can't be read.
    const noTimescale = track(12_000);
    const at = Buffer.from(noTimescale).indexOf('mdhd') + 4 + 12;
    new DataView(noTimescale.buffer).setUint32(at, 0);
    expect(inlineVideoSeconds(file(3_000, noTimescale))).toBeNull();
  });

  it('asks for the measured length as duration', () => {
    const source = file(12_700, track(12_700));
    expect(videoSourceLengthProblem(source, 12)).toBeNull();
    expect(videoSourceLengthProblem(source, '12s')).toBeNull();
    expect(videoSourceLengthProblem(source, 3)).toContain('rounded down: 12');
    expect(videoSourceLengthProblem(file(600, track(600)), 1)).toBeNull();
    expect(videoSourceLengthProblem('https://example.com/source.mp4', 12)).toContain('inline');
  });
});
