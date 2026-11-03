/** Largest `moov` box buffered while inspecting a streamed MP4. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

export interface Mp4Facts {
  /** Movie duration from the `mvhd` box, in milliseconds. */
  durationMs: number;
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
  let durationMs: number | undefined;
  let invalid = false;

  const endMoov = (): void => {
    const data = new Uint8Array(moovBytes);
    let offset = 0;
    for (const part of moov!) {
      data.set(part, offset);
      offset += part.length;
    }
    moov = null;
    durationMs = readMvhdDuration(data);
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
      if (invalid || header.length || (remaining !== 0 && !toEnd) || durationMs === undefined) return null;
      return { durationMs };
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

/**
 * Length in whole seconds (rounded down) of an inline `data:video/...;base64`
 * source: its longest video track's played length, from its edit list
 * (`elst`) or else its samples (`stts`, checked against `stsz`), never from
 * headers the sender could shorten. Null when it is not a readable inline
 * MP4: a malformed box, a fragmented MP4 or no video track.
 */
export function inlineVideoSeconds(source: unknown): number | null {
  if (typeof source !== 'string') return null;
  const match = /^data:video\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]*)*;base64,/i.exec(source.slice(0, 256));
  if (!match) return null;
  let binary: string;
  try {
    binary = atob(source.slice(match[0].length));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const moov = only(childBoxes(bytes, { type: '', body: 0, end: bytes.length }), 'moov', 'ftyp');
  const inMoov = moov && childBoxes(bytes, moov);
  // A fragmented MP4 (`mvex`) keeps its samples outside `moov`, so its length can't be read here.
  if (!inMoov || inMoov.some(box => box.type === 'mvex')) return null;
  const mvhd = only(inMoov, 'mvhd');
  const movieTimescale = mvhd && timescaleOf(bytes, mvhd);
  if (!movieTimescale) return null;
  let longestMs: number | null = null;
  for (const trak of inMoov.filter(box => box.type === 'trak')) {
    const inTrak = childBoxes(bytes, trak);
    const mdia = inTrak && only(inTrak, 'mdia');
    const inMdia = mdia && childBoxes(bytes, mdia);
    const hdlr = inMdia && only(inMdia, 'hdlr');
    if (!inTrak || !inMdia || !hdlr || hdlr.body + 12 > hdlr.end) return null;
    if (boxType(bytes, hdlr.body + 8) !== 'vide') continue;
    const mdhd = only(inMdia, 'mdhd');
    const minf = only(inMdia, 'minf');
    const inMinf = minf && childBoxes(bytes, minf);
    const stbl = inMinf && only(inMinf, 'stbl');
    const inStbl = stbl && childBoxes(bytes, stbl);
    const stts = inStbl && only(inStbl, 'stts');
    const stsz = inStbl && only(inStbl, 'stsz');
    // The sample table (stts) counts in mdhd's timescale; the edit list in the movie's.
    const media = mdhd && timescaleOf(bytes, mdhd);
    const samples = stts && stsz && media ? sampleTableMs(bytes, stts, stsz, media) : undefined;
    if (samples === undefined) return null;
    // An edit list (`edts`/`elst`, written by trims) sets what is played; samples outside it are skipped.
    const edts = only(inTrak, 'edts');
    const inEdts = edts && childBoxes(bytes, edts);
    if (edts && !inEdts) return null;
    const elst = inEdts && only(inEdts, 'elst');
    const edited = elst ? editListMs(bytes, elst, movieTimescale) : null;
    if (edited === undefined) return null;
    longestMs = Math.max(longestMs ?? 0, edited ?? samples);
  }
  return longestMs === null ? null : Math.floor(longestMs / 1000);
}

interface Box { type: string; body: number; end: number }

/** The boxes inside `parent`, or null when one is malformed or runs past it. */
function childBoxes(bytes: Uint8Array, parent: Box): Box[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let offset = parent.body;
  for (; offset + 8 <= parent.end && boxes.length < 1000;) {
    const size32 = view.getUint32(offset);
    const headerSize = size32 === 1 ? 16 : 8;
    if (offset + headerSize > parent.end) return null;
    const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32 === 0 ? parent.end - offset : size32;
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > parent.end) return null;
    boxes.push({ type: boxType(bytes, offset + 4), body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return offset === parent.end ? boxes : null;
}

/**
 * The single box of `type` among `boxes` (and `boxes` starts with `first`,
 * when given), or undefined when it is missing or repeated.
 */
function only(boxes: Box[] | null, type: string, first?: string): Box | undefined {
  if (!boxes || (first && boxes[0]?.type !== first)) return undefined;
  const found = boxes.filter(box => box.type === type);
  return found.length === 1 ? found[0] : undefined;
}

/** Timescale of an `mvhd` or `mdhd` box (same layout); undefined outside 1..2^31-1. */
function timescaleOf(bytes: Uint8Array, box: Box): number | undefined {
  // version/flags (4), creation and modification times (8 or 16), timescale (4).
  const at = box.body + (bytes[box.body] === 1 ? 20 : 12);
  if (at + 4 > box.end) return undefined;
  const timescale = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
  return timescale && timescale <= 0x7fffffff ? timescale : undefined;
}

/** Total length of an `elst` box's segments, in the movie's timescale; null when it has none. */
function editListMs(bytes: Uint8Array, box: Box, movieTimescale: number): number | null | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (box.body + 8 > box.end) return undefined;
  const version1 = bytes[box.body] === 1;
  const entries = view.getUint32(box.body + 4);
  const size = version1 ? 20 : 12;
  if (entries === 0) return null;
  if (box.body + 8 + entries * size > box.end) return undefined;
  let total = 0;
  for (let i = 0, at = box.body + 8; i < entries; i += 1, at += size) {
    total += version1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
  }
  return Number.isSafeInteger(total) ? Math.floor((total * 1000) / movieTimescale) : undefined;
}

/**
 * Total length of a track's samples from its `stts` box, in the media
 * timescale. Undefined unless `stts` counts exactly the samples `stsz` lists,
 * so a table that leaves samples out is refused.
 */
function sampleTableMs(bytes: Uint8Array, stts: Box, stsz: Box, timescale: number): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (stts.body + 8 > stts.end || stsz.body + 12 > stsz.end) return undefined;
  const entries = view.getUint32(stts.body + 4);
  if (stts.body + 8 + entries * 8 > stts.end) return undefined;
  let count = 0;
  let total = 0;
  for (let i = 0, at = stts.body + 8; i < entries; i += 1, at += 8) {
    count += view.getUint32(at);
    total += view.getUint32(at) * view.getUint32(at + 4);
  }
  if (count !== view.getUint32(stsz.body + 8) || !Number.isSafeInteger(total)) return undefined;
  return Math.floor((total * 1000) / timescale);
}
