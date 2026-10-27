/** Largest `moov` box buffered while inspecting a streamed MP4. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

export interface Mp4Facts {
  /** Movie duration from the `mvhd` box, in milliseconds. */
  durationMs: number;
  /**
   * Longest track's length in milliseconds, from each track's own timeline
   * (`tkhd`, `mdhd` and the `stts` sample durations), when readable. A file
   * whose `mvhd` was edited to look shorter still shows its real length here.
   */
  trackDurationMs?: number;
  /** First video track: display size in pixels and frames per second, when readable. */
  video?: { width?: number; height?: number; fps?: number };
}

/**
 * Inspects an MP4 while it streams by, without keeping the media data.
 * It reads top-level box headers and buffers only the small `moov` box, so
 * it works whether `moov` comes before or after the media data.
 * `finish()` returns null unless the bytes are a complete MP4 that starts
 * with `ftyp` and has a readable duration.
 */
export function createMp4Inspector() {
  let header: Uint8Array = new Uint8Array(0);
  let remaining = 0;
  let toEnd = false;
  let boxes = 0;
  let moov: Uint8Array[] | null = null;
  let moovBytes = 0;
  let facts: Mp4Facts | undefined;
  let invalid = false;

  const endMoov = (): void => {
    const data = new Uint8Array(moovBytes);
    let offset = 0;
    for (const part of moov!) {
      data.set(part, offset);
      offset += part.length;
    }
    moov = null;
    facts = mp4MoovFacts(data);
  };

  const startBox = (): void => {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const size32 = view.getUint32(0);
    const type = boxType(header, 4);
    const headerSize = size32 === 1 ? 16 : 8;
    const size = size32 === 1 ? Number(view.getBigUint64(8)) : size32;
    header = new Uint8Array(0);
    if (boxes === 0 && type !== 'ftyp') { invalid = true; return; }
    boxes += 1;
    toEnd = size32 === 0;
    if (!toEnd && (!Number.isSafeInteger(size) || size < headerSize)) { invalid = true; return; }
    remaining = toEnd ? Infinity : size - headerSize;
    if (type === 'moov') {
      if (remaining > MAX_MOOV_BYTES && !toEnd) { invalid = true; return; }
      moov = [];
      moovBytes = 0;
      if (remaining === 0) endMoov();
    }
  };

  const consume = (data: Uint8Array): void => {
    let chunk = data;
    while (chunk.length && !invalid) {
      if (remaining === 0) {
        const need = header.length >= 8 && new DataView(header.buffer, header.byteOffset).getUint32(0) === 1 ? 16 : 8;
        const take = Math.min(need - header.length, chunk.length);
        header = concat(header, chunk.subarray(0, take));
        chunk = chunk.subarray(take);
        if (header.length < need) continue;
        if (need === 8 && new DataView(header.buffer, header.byteOffset).getUint32(0) === 1) continue;
        startBox();
        continue;
      }
      const take = Math.min(remaining, chunk.length);
      if (moov) {
        moov.push(chunk.slice(0, take));
        moovBytes += take;
        if (moovBytes > MAX_MOOV_BYTES) { invalid = true; return; }
      }
      remaining -= take;
      chunk = chunk.subarray(take);
      if (remaining === 0 && moov) endMoov();
    }
  };

  return {
    update(data: Uint8Array): void {
      if (!invalid) consume(data);
    },
    finish(): Mp4Facts | null {
      if (moov && toEnd) endMoov();
      if (invalid || header.length || (remaining !== 0 && !toEnd) || facts === undefined) return null;
      return facts;
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * What the `moov` box body says about the file: the `mvhd` duration, the
 * longest track timeline, and the first video track's size and frame rate.
 * Undefined when it has no readable `mvhd`.
 */
export function mp4MoovFacts(moov: Uint8Array): Mp4Facts | undefined {
  const durationMs = readMvhdDuration(moov);
  if (durationMs === undefined) return undefined;
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const movieTimescale = readMvhdTimescale(moov, view);
  let trackDurationMs: number | undefined;
  let video: Mp4Facts['video'];
  let fallback: Mp4Facts['video'];
  for (const trak of childBoxes(moov, view, 0, moov.length)) {
    if (trak.type !== 'trak') continue;
    const track = readTrack(moov, view, trak.body, trak.end, movieTimescale);
    if (track.durationMs !== undefined) trackDurationMs = Math.max(trackDurationMs ?? 0, track.durationMs);
    if (!video && track.handler === 'vide') video = track.video;
    // Without a readable handler, the first track with a picture size is the video track (audio tracks have none).
    if (!fallback && track.handler === undefined && track.video.width) fallback = track.video;
  }
  video ??= fallback;
  return {
    durationMs,
    ...(trackDurationMs !== undefined ? { trackDurationMs } : {}),
    ...(video && Object.keys(video).length > 0 ? { video } : {}),
  };
}

interface ChildBox { type: string; body: number; end: number }

/** Child boxes between `start` and `end`; stops at the first malformed one. */
function childBoxes(bytes: Uint8Array, view: DataView, start: number, end: number): ChildBox[] {
  const boxes: ChildBox[] = [];
  let offset = start;
  while (offset + 8 <= end && boxes.length < 1000) {
    const size32 = view.getUint32(offset);
    const headerSize = size32 === 1 ? 16 : 8;
    if (offset + headerSize > end) break;
    const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32 === 0 ? end - offset : size32;
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
    boxes.push({ type: boxType(bytes, offset + 4), body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

const child = (bytes: Uint8Array, view: DataView, parent: { body: number; end: number }, type: string) =>
  childBoxes(bytes, view, parent.body, parent.end).find(box => box.type === type);

function readMvhdTimescale(moov: Uint8Array, view: DataView): number | undefined {
  const mvhd = childBoxes(moov, view, 0, moov.length).find(box => box.type === 'mvhd');
  if (!mvhd) return undefined;
  const version = moov[mvhd.body];
  const at = mvhd.body + 4 + (version === 1 ? 16 : 8);
  return at + 4 <= mvhd.end ? view.getUint32(at) || undefined : undefined;
}

const toMs = (duration: number, timescale: number | undefined) =>
  timescale && Number.isSafeInteger(duration) && duration > 0 && duration !== 0xffffffff ? Math.floor((duration * 1000) / timescale) : undefined;

function readTrack(bytes: Uint8Array, view: DataView, body: number, end: number, movieTimescale: number | undefined) {
  const trak = { body, end };
  const durations: number[] = [];
  let video: { width?: number; height?: number; fps?: number } = {};
  const tkhd = child(bytes, view, trak, 'tkhd');
  if (tkhd) {
    const version = bytes[tkhd.body];
    // version/flags, creation and modification times, track id, reserved, then duration.
    const durationAt = tkhd.body + 4 + (version === 1 ? 24 : 16);
    // reserved (8), layer, alternate group, volume, reserved (8), then the matrix.
    const fixed = durationAt + (version === 1 ? 8 : 4) + 16;
    if (fixed + 44 <= tkhd.end) {
      const duration = version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
      const ms = toMs(duration, movieTimescale);
      if (ms !== undefined) durations.push(ms);
      // Matrix a b u / c d v / x y w (16.16 fixed); a 90 or 270 degree rotation swaps the display size.
      const a = view.getInt32(fixed), b = view.getInt32(fixed + 4);
      const width = view.getUint32(fixed + 36) / 65536;
      const height = view.getUint32(fixed + 40) / 65536;
      const rotated = a === 0 && b !== 0;
      if (width > 0 && height > 0) video = { width: Math.round(rotated ? height : width), height: Math.round(rotated ? width : height) };
    }
  }
  const mdia = child(bytes, view, trak, 'mdia');
  let handler: string | undefined;
  if (mdia) {
    const hdlr = child(bytes, view, mdia, 'hdlr');
    if (hdlr && hdlr.body + 12 <= hdlr.end) handler = boxType(bytes, hdlr.body + 8);
    const mdhd = child(bytes, view, mdia, 'mdhd');
    let timescale: number | undefined;
    if (mdhd) {
      const version = bytes[mdhd.body];
      const at = mdhd.body + 4 + (version === 1 ? 16 : 8);
      if (at + (version === 1 ? 12 : 8) <= mdhd.end) {
        timescale = view.getUint32(at) || undefined;
        const duration = version === 1 ? Number(view.getBigUint64(at + 4)) : view.getUint32(at + 4);
        const ms = toMs(duration, timescale);
        if (ms !== undefined) durations.push(ms);
      }
    }
    const minf = child(bytes, view, mdia, 'minf');
    const stbl = minf ? child(bytes, view, minf, 'stbl') : undefined;
    const stts = stbl ? child(bytes, view, stbl, 'stts') : undefined;
    if (stts && stts.body + 8 <= stts.end) {
      const entries = view.getUint32(stts.body + 4);
      let samples = 0;
      let total = 0;
      for (let i = 0, at = stts.body + 8; i < entries && at + 8 <= stts.end; i += 1, at += 8) {
        const count = view.getUint32(at);
        samples += count;
        total += count * view.getUint32(at + 4);
      }
      const ms = toMs(total, timescale);
      if (ms !== undefined) {
        durations.push(ms);
        if (handler === 'vide' && samples > 1) video = { ...video, fps: Math.round((samples * 1000 / ms) * 100) / 100 };
      }
    }
  }
  return { handler, video, durationMs: durations.length > 0 ? Math.max(...durations) : undefined };
}

/** Largest `moov` box read when measuring an MP4. */
export const MP4_MAX_MOOV_BYTES = MAX_MOOV_BYTES;

/** Duration in milliseconds from the `mvhd` box inside `moov`, if present. */
function readMvhdDuration(moov: Uint8Array): number | undefined {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let offset = 0;
  while (offset + 8 <= moov.length) {
    const size32 = view.getUint32(offset);
    const headerSize = size32 === 1 ? 16 : 8;
    if (offset + headerSize > moov.length) return undefined;
    const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32 === 0 ? moov.length - offset : size32;
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > moov.length) return undefined;
    if (boxType(moov, offset + 4) === 'mvhd') {
      const body = offset + headerSize;
      const version = moov[body];
      const fields = body + 4 + (version === 1 ? 16 : 8);
      if (fields + (version === 1 ? 12 : 8) > offset + size) return undefined;
      const timescale = view.getUint32(fields);
      const duration = version === 1 ? Number(view.getBigUint64(fields + 4)) : view.getUint32(fields + 4);
      if (!timescale || !Number.isSafeInteger(duration)) return undefined;
      return Math.floor((duration * 1000) / timescale);
    }
    offset += size;
  }
  return undefined;
}
