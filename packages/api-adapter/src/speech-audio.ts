/**
 * Structural checks of the audio a speech API returns. Speech is billed by the
 * characters read aloud, so the bytes must be audio a player can decode: the
 * container's required header and at least the start of real audio data, not
 * a signature followed by padding or an error document labelled as audio.
 * These are framing checks, not a decoder.
 */

/** Smallest body counted as speech audio: even a one-word answer is several times larger. */
export const MIN_SPEECH_AUDIO_BYTES = 64;

function ascii(body: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || body.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (body[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function u32be(body: Uint8Array, offset: number): number {
  return ((body[offset]! << 24) >>> 0) + (body[offset + 1]! << 16) + (body[offset + 2]! << 8) + body[offset + 3]!;
}

function u32le(body: Uint8Array, offset: number): number {
  return (body[offset]! | (body[offset + 1]! << 8) | (body[offset + 2]! << 16)) + ((body[offset + 3]! << 24) >>> 0);
}

function u16le(body: Uint8Array, offset: number): number {
  return body[offset]! | (body[offset + 1]! << 8);
}

// ── MPEG audio (MP3) and ADTS (AAC) ─────────────────────────────

/** kbps by `<1 for MPEG-1, 2 for MPEG-2/2.5>-<layer>`, indexed by the header's bitrate index. */
const MPEG_BITRATES: Record<string, readonly number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_SAMPLE_RATES = [44_100, 48_000, 32_000];

/** Length of the MPEG audio or ADTS frame at `offset`, or null when no valid frame header is there. */
function audioFrameLength(body: Uint8Array, offset: number): number | null {
  if (body.length < offset + 7) return null;
  const b1 = body[offset + 1]!;
  const b2 = body[offset + 2]!;
  if (body[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  if ((b1 & 0xf6) === 0xf0) {
    // ADTS: 12 sync bits, layer 00; the 13-bit frame length includes the header.
    if (((b2 >> 2) & 0x0f) >= 13) return null;
    const length = ((body[offset + 3]! & 0x03) << 11) | (body[offset + 4]! << 3) | (body[offset + 5]! >> 5);
    const header = (b1 & 0x01) === 1 ? 7 : 9;
    return length > header ? length : null;
  }
  const version = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 reserved
  const layerBits = (b1 >> 1) & 0x03; // 3 = layer I, 2 = layer II, 1 = layer III, 0 reserved
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 0x0f || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const mpeg1 = version === 3;
  const kbps = MPEG_BITRATES[`${mpeg1 ? 1 : 2}-${layer}`]![bitrateIndex]!;
  const sampleRate = MPEG_SAMPLE_RATES[rateIndex]! / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const padding = (b2 >> 1) & 0x01;
  if (layer === 1) return (Math.floor((12 * kbps * 1000) / sampleRate) + padding) * 4;
  const factor = layer === 3 && !mpeg1 ? 72 : 144;
  return Math.floor((factor * kbps * 1000) / sampleRate) + padding;
}

/** Two consecutive complete frames from `offset`: a header alone or padding is not audio. */
function hasAudioFrames(body: Uint8Array, offset: number): boolean {
  const first = audioFrameLength(body, offset);
  if (first === null || body.length < offset + first) return false;
  const second = audioFrameLength(body, offset + first);
  return second !== null && body.length >= offset + first + second;
}

function isMp3OrAac(body: Uint8Array): boolean {
  if (ascii(body, 0, 'ID3')) {
    if (body.length < 10) return false;
    const tagSize = ((body[6]! & 0x7f) << 21) | ((body[7]! & 0x7f) << 14) | ((body[8]! & 0x7f) << 7) | (body[9]! & 0x7f);
    const footer = (body[5]! & 0x10) !== 0 ? 10 : 0;
    return hasAudioFrames(body, 10 + tagSize + footer);
  }
  return hasAudioFrames(body, 0);
}

// ── WAV ──────────────────────────────────────────────────────────

/** RIFF/WAVE with a PCM-family `fmt ` chunk and a `data` chunk holding at least one sample frame. */
function isWav(body: Uint8Array): boolean {
  if (!ascii(body, 0, 'RIFF') || !ascii(body, 8, 'WAVE')) return false;
  let blockAlign = 0;
  for (let offset = 12; offset + 8 <= body.length;) {
    const size = u32le(body, offset + 4);
    if (ascii(body, offset, 'fmt ')) {
      if (size < 16 || body.length < offset + 8 + 16) return false;
      const format = u16le(body, offset + 8);
      const channels = u16le(body, offset + 10);
      const sampleRate = u32le(body, offset + 12);
      blockAlign = u16le(body, offset + 20);
      if (![1, 3, 0xfffe].includes(format) || channels === 0 || sampleRate === 0 || blockAlign === 0) return false;
    } else if (ascii(body, offset, 'data')) {
      // A streamed WAV may not know its data size yet (0 or 0xFFFFFFFF); the bytes present decide.
      return blockAlign > 0 && body.length - (offset + 8) >= blockAlign;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

// ── FLAC ─────────────────────────────────────────────────────────

/** `fLaC`, a STREAMINFO block first, the metadata blocks whole, then a frame sync code. */
function isFlac(body: Uint8Array): boolean {
  if (!ascii(body, 0, 'fLaC') || body.length < 8 + 34) return false;
  if ((body[4]! & 0x7f) !== 0) return false; // the first block must be STREAMINFO
  const streamInfoLength = (body[5]! << 16) | (body[6]! << 8) | body[7]!;
  if (streamInfoLength !== 34) return false;
  const minBlock = (body[8]! << 8) | body[9]!;
  const sampleRate = (body[18]! << 12) | (body[19]! << 4) | (body[20]! >> 4);
  if (minBlock < 16 || sampleRate === 0) return false;
  let offset = 4;
  for (;;) {
    if (body.length < offset + 4) return false;
    const last = (body[offset]! & 0x80) !== 0;
    const length = (body[offset + 1]! << 16) | (body[offset + 2]! << 8) | body[offset + 3]!;
    offset += 4 + length;
    if (last) break;
  }
  return body.length >= offset + 2 && body[offset] === 0xff && (body[offset + 1]! & 0xfe) === 0xf8;
}

// ── Ogg (Opus, Vorbis) ───────────────────────────────────────────

/** Length of the whole Ogg page at `offset`, or null when no complete page is there. */
function oggPageLength(body: Uint8Array, offset: number): number | null {
  if (!ascii(body, offset, 'OggS') || body[offset + 4] !== 0 || body.length < offset + 27) return null;
  const segments = body[offset + 26]!;
  if (body.length < offset + 27 + segments) return null;
  let payload = 0;
  for (let i = 0; i < segments; i += 1) payload += body[offset + 27 + i]!;
  const length = 27 + segments + payload;
  return body.length >= offset + length ? length : null;
}

/**
 * The complete packets of the whole Ogg pages in `body`, in order, as
 * [offset, length] pairs (a packet may span pages; one cut off is left out).
 * Lazy, so a caller can stop at the packet it needs.
 */
function* oggPackets(body: Uint8Array): Generator<[number, number]> {
  let start: number | null = null;
  let size = 0;
  for (let page = 0; ;) {
    const length = oggPageLength(body, page);
    if (length === null) return;
    const segments = body[page + 26]!;
    let data = page + 27 + segments;
    for (let i = 0; i < segments; i += 1) {
      const lacing = body[page + 27 + i]!;
      start ??= data;
      size += lacing;
      data += lacing;
      if (lacing < 255) {
        yield [start, size];
        start = null;
        size = 0;
      }
    }
    page += length;
  }
}

/**
 * Ogg Opus (OpusHead, OpusTags) or Vorbis (identification, comment, setup)
 * whose codec headers are followed by at least one complete, non-empty audio
 * packet: headers alone hold nothing to play.
 */
function isOgg(body: Uint8Array): boolean {
  let headerPackets: number | null = null;
  let index = 0;
  for (const [offset, length] of oggPackets(body)) {
    if (index === 0) {
      headerPackets = ascii(body, offset, 'OpusHead') ? 2 : body[offset] === 0x01 && ascii(body, offset + 1, 'vorbis') ? 3 : null;
      if (headerPackets === null) return false;
    } else if (index >= headerPackets! && length > 0) {
      return true;
    }
    index += 1;
  }
  return false;
}

// ── MP4 / M4A ────────────────────────────────────────────────────

/** Whether `body[from, to)` holds `needle` with `value` at `valueAt` bytes from the needle's start. */
function contains(body: Uint8Array, from: number, to: number, needle: readonly number[], valueAt: number, value: readonly number[]): boolean {
  for (let offset = from; offset + Math.max(needle.length, valueAt + value.length) <= to; offset += 1) {
    if (bytesAt(body, offset, needle) && bytesAt(body, offset + valueAt, value)) return true;
  }
  return false;
}

const HDLR = [0x68, 0x64, 0x6c, 0x72]; // 'hdlr'
const SOUN = [0x73, 0x6f, 0x75, 0x6e]; // 'soun'

/**
 * Top-level boxes that fit the body, starting with `ftyp`, a `moov` with a
 * sound track (an `hdlr` of type `soun`) and a non-empty `mdat`.
 */
function isMp4(body: Uint8Array): boolean {
  if (!ascii(body, 4, 'ftyp')) return false;
  let soundTrack = false;
  let media = false;
  for (let offset = 0; offset + 8 <= body.length;) {
    let size = u32be(body, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > body.length) return false;
      size = u32be(body, offset + 8) * 2 ** 32 + u32be(body, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = body.length - offset; // the last box runs to the end
    }
    if (size < header || offset + size > body.length) return false;
    // hdlr: type, version and flags, pre_defined, then the handler type.
    if (ascii(body, offset + 4, 'moov')) soundTrack ||= contains(body, offset + header, offset + size, HDLR, 12, SOUN);
    if (ascii(body, offset + 4, 'mdat') && size > header) media = true;
    offset += size;
  }
  return soundTrack && media;
}

// ── WebM / Matroska ──────────────────────────────────────────────

/** An EBML variable-length size at `offset`: its byte width and value, or null. */
function ebmlSize(body: Uint8Array, offset: number): { width: number; value: number } | null {
  const first = body[offset];
  if (first === undefined || first === 0) return null;
  const width = Math.clz32(first) - 23;
  if (width > 8 || body.length < offset + width) return null;
  let value = first & (0xff >> width);
  for (let i = 1; i < width; i += 1) value = value * 256 + body[offset + i]!;
  return { width, value };
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
/** TrackType (0x83), one byte long, 2: an audio track. */
const AUDIO_TRACK_TYPE = [0x83, 0x81, 0x02];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

function bytesAt(body: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  return bytes.every((byte, i) => body[offset + i] === byte);
}

/** A whole EBML header, then a Segment with an audio track before a Cluster (where the audio is). */
function isWebm(body: Uint8Array): boolean {
  if (!bytesAt(body, 0, EBML_ID)) return false;
  const header = ebmlSize(body, 4);
  if (!header) return false;
  const segment = 4 + header.width + header.value;
  if (!bytesAt(body, segment, SEGMENT_ID)) return false;
  for (let offset = segment + 4; offset + 4 <= body.length; offset += 1) {
    if (bytesAt(body, offset, CLUSTER_ID)) {
      return body.length > offset + 8 && contains(body, segment + 4, offset, AUDIO_TRACK_TYPE, 0, []);
    }
  }
  return false;
}

/** Whether a body is a JSON document (an error answer), whatever its label. */
function isJsonDocument(body: Uint8Array): boolean {
  const first = body.find((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
  if (first !== 0x7b && first !== 0x5b) return false;
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `body` is audio a speech API returns: MP3, AAC (ADTS), WAV, FLAC,
 * Ogg Opus or Vorbis, MP4/M4A or WebM, each with its required header and the
 * start of real audio data; or, when the request asked for headerless `pcm`,
 * whole 16-bit samples that are not a JSON document.
 */
export function isSpeechAudio(body: Uint8Array, responseFormat?: string): boolean {
  if (body.length < MIN_SPEECH_AUDIO_BYTES) return false;
  if (isMp3OrAac(body) || isWav(body) || isFlac(body) || isOgg(body) || isMp4(body) || isWebm(body)) return true;
  return responseFormat?.trim().toLowerCase() === 'pcm' && body.length % 2 === 0 && !isJsonDocument(body);
}
