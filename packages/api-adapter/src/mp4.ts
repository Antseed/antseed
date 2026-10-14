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
