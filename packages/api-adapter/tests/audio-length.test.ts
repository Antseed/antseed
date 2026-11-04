import { describe, expect, it } from 'vitest';
import { audioSourceLengthProblem, inlineAudioSeconds } from '../src/index.js';

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const ascii = (text: string) => new TextEncoder().encode(text);
const dataUrl = (bytes: Uint8Array, type = 'audio/mpeg') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** `count` MPEG-1 layer III frames, 128 kbps at 44.1 kHz: 417 bytes and 1152 samples (26.1 ms) each. */
const mp3Frames = (count: number) => {
  const frames = new Uint8Array(417 * count);
  for (let i = 0; i < count; i += 1) frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return frames;
};
/** A frame of the same format that carries a Xing header instead of audio. */
const xingFrame = () => {
  const frame = mp3Frames(1);
  frame.set(ascii('Xing'), 36);
  return frame;
};
/** An ID3v2 tag with `size` bytes of body. */
const id3 = (size: number) => concat(ascii('ID3'), Uint8Array.from([4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]), new Uint8Array(size));

const le32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return new Uint8Array(b); };
const le16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return new Uint8Array(b); };
const chunk = (id: string, body: Uint8Array, size = body.length) => concat(ascii(id), le32(size), body, body.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
/** `fmt ` of 16-bit mono PCM at 8 kHz: 16000 bytes per second. */
const pcmFormat = (format = 1) => chunk('fmt ', concat(le16(format), le16(1), le32(8000), le32(16000), le16(2), le16(16)));
const wav = (...chunks: Uint8Array[]) => concat(ascii('RIFF'), le32(0), ascii('WAVE'), ...chunks);

describe('inline audio length', () => {
  it('measures an MP3 by its frames, rounded down', () => {
    // 192 frames are 5.016 s, 191 frames 4.990 s.
    expect(inlineAudioSeconds(dataUrl(mp3Frames(192)))).toBe(5);
    expect(inlineAudioSeconds(dataUrl(mp3Frames(191)))).toBe(4);
    expect(inlineAudioSeconds(dataUrl(concat(id3(2048), mp3Frames(192))))).toBe(5);
    // A trailing ID3v1 tag and a cut-off last frame are not audio.
    expect(inlineAudioSeconds(dataUrl(concat(mp3Frames(192), ascii('TAG'), new Uint8Array(125))))).toBe(5);
    expect(inlineAudioSeconds(dataUrl(concat(mp3Frames(192), mp3Frames(1).subarray(0, 200))))).toBe(5);
  });

  it('does not count a Xing header frame as audio', () => {
    expect(inlineAudioSeconds(dataUrl(concat(xingFrame(), mp3Frames(191))))).toBe(4);
  });

  it('counts audio a decoder finds after a gap, so it cannot be hidden', () => {
    // 1 s of frames, a damaged stretch, then 29 s more: a decoder resyncs and plays 30 s.
    expect(inlineAudioSeconds(dataUrl(concat(mp3Frames(39), new Uint8Array(500).fill(0xff), mp3Frames(1110))))).toBe(30);
  });

  it('measures a PCM WAV by its data, not its headers', () => {
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(88_000))), 'audio/wav'))).toBe(5);
    // A size of 0 or 0xFFFFFFFF (a streamed WAV), or one past the end, counts to the end.
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(48_000), 0xffffffff)), 'audio/wav'))).toBe(3);
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(48_000), 0)), 'audio/wav'))).toBe(3);
    // Samples past a data size that is too small are not a chunk: refused, since some players would play them.
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(48_000), 16_000)), 'audio/wav'))).toBeNull();
    // A decoder plays every data chunk.
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(16_000)), chunk('LIST', new Uint8Array(30)), chunk('data', new Uint8Array(64_000))), 'audio/wav'))).toBe(5);
  });

  it('reads the format from the bytes, not the label', () => {
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(), chunk('data', new Uint8Array(88_000))), 'audio/mpeg'))).toBe(5);
    expect(inlineAudioSeconds(dataUrl(mp3Frames(192), 'audio/wav'))).toBe(5);
  });

  it('is null for anything but a readable inline MP3 or PCM WAV', () => {
    expect(inlineAudioSeconds('https://example.com/voice.mp3')).toBeNull();
    expect(inlineAudioSeconds(dataUrl(mp3Frames(192), 'video/mp4'))).toBeNull();
    expect(inlineAudioSeconds('data:audio/mpeg;base64,%%%')).toBeNull();
    // Leading bytes that are not a tag or a frame: another format the upstream may play differently.
    expect(inlineAudioSeconds(dataUrl(concat(new Uint8Array(64), mp3Frames(192))))).toBeNull();
    expect(inlineAudioSeconds(dataUrl(concat(ascii('....ftypM4A '), new Uint8Array(500))))).toBeNull();
    // Compressed WAV (MP3 in WAV), and WAV without a format before its data.
    expect(inlineAudioSeconds(dataUrl(wav(pcmFormat(0x55), chunk('data', new Uint8Array(88_000))), 'audio/wav'))).toBeNull();
    expect(inlineAudioSeconds(dataUrl(wav(chunk('data', new Uint8Array(88_000)), pcmFormat()), 'audio/wav'))).toBeNull();
  });
});

describe('audioSourceLengthProblem', () => {
  const voice = dataUrl(mp3Frames(192));

  it('accepts a duration equal to the audio length, as a number or string', () => {
    expect(audioSourceLengthProblem(voice, 5)).toBeNull();
    expect(audioSourceLengthProblem(voice, '5')).toBeNull();
    expect(audioSourceLengthProblem(voice, '5s')).toBeNull();
    // Audio under a second is paid as 1 s.
    expect(audioSourceLengthProblem(dataUrl(mp3Frames(20)), 1)).toBeNull();
  });

  it('refuses any other duration, naming the length', () => {
    expect(audioSourceLengthProblem(voice, 1)).toBe('duration must be the source length in whole seconds, rounded down: 5');
    expect(audioSourceLengthProblem(voice, 6)).toContain(': 5');
    expect(audioSourceLengthProblem(voice, undefined)).toContain(': 5');
  });

  it('refuses audio the seller cannot measure', () => {
    expect(audioSourceLengthProblem(undefined, 5)).toContain('send audio_url inline as an MP3 or WAV');
    expect(audioSourceLengthProblem('https://example.com/voice.mp3', 5)).toContain('send audio_url inline');
  });
});
