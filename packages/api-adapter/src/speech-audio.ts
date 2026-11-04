/**
 * Structural checks of the audio a speech API returns. Speech is billed by the
 * characters read aloud, so the bytes must be audio a player can decode: the
 * container's required header and at least the start of real audio data, not
 * a signature followed by padding or an error document labelled as audio.
 * These are framing checks, not a decoder.
 *
 * The same framing measures how long an inline MP3 or WAV source plays, for
 * video models whose output follows their input audio (inlineAudioSeconds).
 */

import { inlineMediaBytes } from './data-url.js';

/** Smallest body counted as speech audio: even a one-word answer is several times larger. */
export const MIN_SPEECH_AUDIO_BYTES = 64;

function ascii(body: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || body.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (body[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
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

interface MpegFrame {
  /** Whole frame length in bytes, header included. */
  length: number;
  /** Samples per channel the frame decodes to. */
  samples: number;
  sampleRate: number;
}

/** The MPEG audio (layer I, II or III) frame whose header is at `offset`, or null when none is there. */
function mpegFrame(body: Uint8Array, offset: number): MpegFrame | null {
  if (body.length < offset + 4) return null;
  const b1 = body[offset + 1]!;
  const b2 = body[offset + 2]!;
  if (body[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
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
  if (layer === 1) return { length: (Math.floor((12 * kbps * 1000) / sampleRate) + padding) * 4, samples: 384, sampleRate };
  const factor = layer === 3 && !mpeg1 ? 72 : 144;
  return { length: Math.floor((factor * kbps * 1000) / sampleRate) + padding, samples: layer === 3 && !mpeg1 ? 576 : 1152, sampleRate };
}

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
  return mpegFrame(body, offset)?.length ?? null;
}

/** Two consecutive complete frames from `offset`: a header alone or padding is not audio. */
function hasAudioFrames(body: Uint8Array, offset: number): boolean {
  const first = audioFrameLength(body, offset);
  if (first === null || body.length < offset + first) return false;
  const second = audioFrameLength(body, offset + first);
  return second !== null && body.length >= offset + first + second;
}

/** Where the ID3v2 tag at `offset` ends, or null when no whole tag header is there. */
function id3v2End(body: Uint8Array, offset: number): number | null {
  if (!ascii(body, offset, 'ID3') || body.length < offset + 10) return null;
  const at = (i: number) => body[offset + i]! & 0x7f;
  const tagSize = (at(6) << 21) | (at(7) << 14) | (at(8) << 7) | at(9);
  const footer = (body[offset + 5]! & 0x10) !== 0 ? 10 : 0;
  return offset + 10 + tagSize + footer;
}

function isMp3OrAac(body: Uint8Array): boolean {
  if (ascii(body, 0, 'ID3')) {
    const end = id3v2End(body, 0);
    return end !== null && hasAudioFrames(body, end);
  }
  return hasAudioFrames(body, 0);
}

// ── WAV ──────────────────────────────────────────────────────────

/** The sample rate and bytes per sample frame of a PCM-family (PCM, float, extensible) `fmt ` chunk at `offset`, or null. */
function wavFormat(body: Uint8Array, view: DataView, offset: number, size: number): { sampleRate: number; blockAlign: number } | null {
  if (size < 16 || body.length < offset + 8 + 16) return null;
  const format = view.getUint16(offset + 8, true);
  const channels = view.getUint16(offset + 10, true);
  const sampleRate = view.getUint32(offset + 12, true);
  const blockAlign = view.getUint16(offset + 20, true);
  if (![1, 3, 0xfffe].includes(format) || channels === 0 || sampleRate === 0 || blockAlign === 0) return null;
  return { sampleRate, blockAlign };
}

/** RIFF/WAVE with a PCM-family `fmt ` chunk and a `data` chunk holding at least one sample frame. */
function isWav(body: Uint8Array): boolean {
  if (!ascii(body, 0, 'RIFF') || !ascii(body, 8, 'WAVE')) return false;
  // RIFF integers are little-endian.
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let blockAlign = 0;
  for (let offset = 12; offset + 8 <= body.length;) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(body, offset, 'fmt ')) {
      const fmt = wavFormat(body, view, offset, size);
      if (!fmt) return false;
      blockAlign = fmt.blockAlign;
    } else if (ascii(body, offset, 'data')) {
      // A streamed WAV may not know its data size yet (0 or 0xFFFFFFFF); the bytes present decide.
      return blockAlign > 0 && body.length - (offset + 8) >= blockAlign;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

// ── FLAC ─────────────────────────────────────────────────────────

/**
 * A FLAC frame header at `offset`: the sync code, then no reserved block size,
 * sample rate, channel assignment or sample size, and frame data after it.
 */
function isFlacFrameHeader(body: Uint8Array, offset: number): boolean {
  if (body.length < offset + 16) return false;
  const [b0, b1, b2, b3] = [body[offset]!, body[offset + 1]!, body[offset + 2]!, body[offset + 3]!];
  if (b0 !== 0xff || (b1 & 0xfe) !== 0xf8) return false;
  const sampleSize = (b3 >> 1) & 0x07;
  return (b2 >> 4) !== 0 && (b2 & 0x0f) !== 0x0f && (b3 >> 4) < 11 && sampleSize !== 3 && sampleSize !== 7 && (b3 & 0x01) === 0;
}

/** `fLaC`, a STREAMINFO block first, the metadata blocks whole, then a valid frame header. */
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
  return isFlacFrameHeader(body, offset);
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
 * Whether `body` is audio in a format the speech APIs return (`mp3`, `aac`,
 * `wav`, `flac`, `opus`, `pcm`): MP3, AAC (ADTS), WAV, FLAC or Ogg Opus/Vorbis,
 * each with its required header and the start of real audio data; or, when
 * the request asked for headerless `pcm`, whole 16-bit samples that are not a
 * JSON document. Other containers (MP4, WebM) are not speech formats.
 */
export function isSpeechAudio(body: Uint8Array, responseFormat?: string): boolean {
  if (body.length < MIN_SPEECH_AUDIO_BYTES) return false;
  if (isMp3OrAac(body) || isWav(body) || isFlac(body) || isOgg(body)) return true;
  return responseFormat?.trim().toLowerCase() === 'pcm' && body.length % 2 === 0 && !isJsonDocument(body);
}

// ── Length of an inline audio source ─────────────────────────────

/**
 * Played length of an MP3 in milliseconds: every whole MPEG audio frame
 * after the leading ID3v2 tags, without a first Xing/Info/VBRI header frame.
 * Bytes between frames (a tag, padding, damage) are skipped the way a
 * decoder resyncs: the next frame counts once two whole frames follow in a
 * row, so audio placed after a gap is measured too. Null unless the audio
 * starts with a frame right after the tags.
 */
function mp3Ms(body: Uint8Array): number | null {
  let offset = 0;
  for (let end = id3v2End(body, offset); end !== null; end = id3v2End(body, offset)) offset = end;
  if (!hasMpegFrames(body, offset)) return null;
  // Samples per sample rate, so the length is summed without rounding each frame.
  const samples = new Map<number, number>();
  let first = true;
  while (offset < body.length) {
    const frame = mpegFrame(body, offset);
    if (frame && body.length >= offset + frame.length) {
      if (!first || !isVbrHeaderFrame(body, offset, frame)) samples.set(frame.sampleRate, (samples.get(frame.sampleRate) ?? 0) + frame.samples);
      first = false;
      offset += frame.length;
      continue;
    }
    offset += 1;
    while (offset < body.length && !(body[offset] === 0xff && hasMpegFrames(body, offset))) offset += 1;
  }
  let ms = 0;
  for (const [rate, count] of samples) ms += (count * 1000) / rate;
  return ms;
}

/** Two whole MPEG audio frames in a row from `offset`. */
function hasMpegFrames(body: Uint8Array, offset: number): boolean {
  const first = mpegFrame(body, offset);
  if (!first || body.length < offset + first.length) return false;
  const second = mpegFrame(body, offset + first.length);
  return second !== null && body.length >= offset + first.length + second.length;
}

/** A Xing, Info or VBRI header frame: it carries the file's summary, not audio. */
function isVbrHeaderFrame(body: Uint8Array, offset: number, frame: MpegFrame): boolean {
  const end = Math.min(offset + frame.length, offset + 40);
  for (let at = offset + 4; at + 4 <= end; at += 1) {
    if (ascii(body, at, 'Xing') || ascii(body, at, 'Info')) return true;
  }
  return ascii(body, offset + 36, 'VBRI');
}

/**
 * Played length of a PCM-family WAV in milliseconds: the bytes of every
 * `data` chunk (a decoder plays them all) over the bytes per second of the
 * `fmt ` chunk before them. A `data` chunk whose size is unknown (0 or
 * 0xFFFFFFFF) or runs past the end counts to the end. Null without a `fmt `
 * chunk before the first `data` chunk, or when bytes after a chunk are not
 * another chunk (they could be samples a `data` size leaves out).
 */
function wavMs(body: Uint8Array): number | null {
  if (!ascii(body, 0, 'RIFF') || !ascii(body, 8, 'WAVE')) return null;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let format: { sampleRate: number; blockAlign: number } | null = null;
  let dataBytes = 0;
  let hasData = false;
  for (let offset = 12; offset + 8 <= body.length;) {
    // Bytes that are not a chunk: some players would read them as more samples.
    for (let i = 0; i < 4; i += 1) if (body[offset + i]! < 0x20 || body[offset + i]! > 0x7e) return null;
    const size = view.getUint32(offset + 4, true);
    if (ascii(body, offset, 'fmt ') && !hasData) {
      format = wavFormat(body, view, offset, size);
      if (!format) return null;
    } else if (ascii(body, offset, 'data')) {
      if (!format) return null;
      hasData = true;
      const available = body.length - (offset + 8);
      if (size === 0 || size === 0xffffffff || size > available) {
        dataBytes += available;
        break;
      }
      dataBytes += size;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !hasData) return null;
  return (Math.floor(dataBytes / format.blockAlign) * 1000) / format.sampleRate;
}

/**
 * Length in whole seconds (rounded down) of an inline
 * `data:audio/...;base64` source that is an MP3 or a PCM WAV, measured from
 * its audio data, never from headers the sender could shorten. The bytes
 * decide the format, not the media type. Null for anything else.
 */
export function inlineAudioSeconds(source: unknown): number | null {
  const bytes = inlineMediaBytes(source, 'audio');
  if (!bytes) return null;
  const ms = ascii(bytes, 0, 'RIFF') ? wavMs(bytes) : mp3Ms(bytes);
  return ms === null ? null : Math.floor(ms / 1000);
}
