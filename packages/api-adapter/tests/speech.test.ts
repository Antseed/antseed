import { describe, expect, it } from 'vitest';
import { detectRequestServiceApiProtocol, selectTargetProtocolForRequest } from '../src/detect.js';
import { extractSpeechRequestFacts, speechAudioDelivered } from '../src/utils.js';

describe('speech requests', () => {
  it('detects POST /v1/audio/speech as openai-audio-speech', () => {
    expect(detectRequestServiceApiProtocol({ path: '/v1/audio/speech', headers: {} })).toBe('openai-audio-speech');
    expect(detectRequestServiceApiProtocol({ path: '/v1/audio/speech?x=1', headers: {} })).toBe('openai-audio-speech');
    expect(detectRequestServiceApiProtocol({ path: '/v1/audio/transcriptions', headers: {} })).toBeNull();
  });

  it('serves speech only on speech services, never through a chat fallback', () => {
    expect(selectTargetProtocolForRequest('openai-audio-speech', ['openai-audio-speech'])).toEqual({ targetProtocol: 'openai-audio-speech', requiresTransform: false });
    expect(selectTargetProtocolForRequest('openai-audio-speech', ['openai-chat-completions'])).toBeNull();
  });

  it('counts the characters of input as code points', () => {
    expect(extractSpeechRequestFacts({ model: 'tts-kokoro', input: 'Hello!', voice: 'af_sky', response_format: 'wav' }))
      .toEqual({ characters: 6, voice: 'af_sky', responseFormat: 'wav' });
    // An emoji is one character, not two UTF-16 units.
    expect(extractSpeechRequestFacts({ input: 'Hi 👋' })).toEqual({ characters: 4 });
    expect(extractSpeechRequestFacts({ input: '' })).toBeNull();
    expect(extractSpeechRequestFacts({ input: 42 })).toBeNull();
    expect(extractSpeechRequestFacts(null)).toBeNull();
  });

  const concat = (...parts: Array<Uint8Array | number[] | string>) => {
    const chunks = parts.map((part) => typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part));
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  };
  const zeros = (n: number) => new Uint8Array(n);
  const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

  /** MPEG-1 layer III, 128 kbps, 44.1 kHz: 417-byte frames. */
  const mp3Frames = (count: number) => concat(...Array.from({ length: count }, () => concat([0xff, 0xfb, 0x90, 0x00], zeros(413))));
  /** AAC in ADTS frames of 200 bytes. */
  const adtsFrames = (count: number) => concat(...Array.from({ length: count }, () =>
    concat([0xff, 0xf1, 0x50, 0x80 | ((200 >> 11) & 0x03), (200 >> 3) & 0xff, ((200 & 0x07) << 5) | 0x1f, 0xfc], zeros(193))));
  /** 16-bit mono PCM at 24 kHz. */
  const wav = (samples: number) => concat('RIFF', u32le(36 + samples * 2), 'WAVE',
    'fmt ', u32le(16), [1, 0, 1, 0], u32le(24_000), u32le(48_000), [2, 0, 16, 0], 'data', u32le(samples * 2), zeros(samples * 2));
  const flacHeader = concat('fLaC', [0x80, 0, 0, 34], [0x10, 0x00, 0x10, 0x00], zeros(6), [0x0a, 0xc4, 0x40], zeros(21));
  /** A frame: sync, 4096-sample blocks at the STREAMINFO rate, mono, 16-bit. */
  const flac = concat(flacHeader, [0xff, 0xf8, 0xc0, 0x08], zeros(100));
  const oggPage = (payload: Uint8Array) => concat('OggS', [0, 0], zeros(8), zeros(4), zeros(4), zeros(4), [1, payload.length], payload);
  const opusHead = oggPage(concat('OpusHead', zeros(11)));
  const opusTags = oggPage(concat('OpusTags', zeros(40)));
  const ogg = concat(opusHead, opusTags, oggPage(zeros(120)));
  const vorbisHeaders = concat(oggPage(concat([1], 'vorbis', zeros(23))), oggPage(concat([3], 'vorbis', zeros(30))), oggPage(concat([5], 'vorbis', zeros(30))));
  const hdlr = (handler: string) => concat(u32be(32), 'hdlr', zeros(8), handler, zeros(12));
  const moov = (handler: string | null) => concat(u32be(8 + (handler ? 32 : 8)), 'moov', handler ? hdlr(handler) : zeros(8));
  const ftyp = concat(u32be(20), 'ftypM4A ', zeros(4), 'M4A ');
  const mdat = concat(u32be(200), 'mdat', zeros(192));
  const mp4 = concat(ftyp, moov('soun'), mdat);
  /** WebM with one track of `trackType` (1 video, 2 audio), then a cluster. */
  const webmWith = (trackType: number) => concat([0x1a, 0x45, 0xdf, 0xa3, 0x84], zeros(4),
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0x16, 0x54, 0xae, 0x6b, 0x85, 0xae, 0x83, 0x83, 0x81, trackType],
    [0x1f, 0x43, 0xb6, 0x75, 0x40, 0x64], zeros(100));
  const webm = webmWith(2);
  const delivered = (body: Uint8Array, format?: string) => speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body }, format);

  it('counts only a 2xx answer that is audio as delivered', () => {
    const mp3 = mp3Frames(3);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: mp3 })).toBe(true);
    expect(speechAudioDelivered({ statusCode: 200, headers: {}, body: mp3 })).toBe(true);
    // Venice labels its JSON errors audio/mpeg: the status decides.
    expect(speechAudioDelivered({ statusCode: 400, headers: { 'content-type': 'audio/mpeg; charset=utf-8' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(0) })).toBe(false);
  });

  it('recognises each audio format a speech API returns', () => {
    expect(delivered(mp3Frames(3))).toBe(true);
    expect(delivered(concat([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20], zeros(20), mp3Frames(2)))).toBe(true); // ID3 tag first
    expect(delivered(adtsFrames(3))).toBe(true);
    expect(delivered(wav(200))).toBe(true);
    expect(delivered(flac)).toBe(true);
    expect(delivered(ogg)).toBe(true);
    expect(delivered(concat(vorbisHeaders, oggPage(zeros(120))))).toBe(true);
    expect(delivered(mp4)).toBe(true);
    expect(delivered(webm)).toBe(true);
    // Raw PCM has no header: whole 16-bit samples, when the request asked for pcm.
    expect(delivered(zeros(256).fill(7), 'pcm')).toBe(true);
    expect(delivered(zeros(256).fill(7))).toBe(false);
    expect(delivered(zeros(257).fill(7), 'pcm')).toBe(false);
  });

  it('counts no characters for a stub, a padded signature, missing metadata or a cut-off file', () => {
    expect(delivered(new Uint8Array([0xff]))).toBe(false);
    const jsonError = new TextEncoder().encode(JSON.stringify({ error: { message: 'Voice is not supported', type: 'invalid_request_error' }, detail: 'x'.repeat(80) }));
    expect(delivered(jsonError)).toBe(false);
    expect(delivered(jsonError, 'pcm')).toBe(false);
    // A signature followed by padding.
    for (const signature of ['ID3', 'RIFF', 'fLaC', 'OggS', '\0\0\0\x20ftyp']) {
      expect(delivered(concat(signature, zeros(256))), signature).toBe(false);
    }
    expect(delivered(concat([0xff, 0xfb, 0x90, 0x00], zeros(252)))).toBe(false);
    expect(delivered(concat([0x1a, 0x45, 0xdf, 0xa3], zeros(252)))).toBe(false);
    // Missing required metadata.
    expect(delivered(concat('RIFF', u32le(100), 'WAVE', 'data', u32le(200), zeros(200)))).toBe(false); // no fmt chunk
    expect(delivered(concat('fLaC', [0x80, 0, 0, 10], zeros(200)))).toBe(false); // no STREAMINFO
    expect(delivered(concat(oggPage(zeros(40)), oggPage(zeros(40))))).toBe(false); // no codec header
    expect(delivered(concat(ftyp, mdat))).toBe(false); // no moov
    expect(delivered(concat(ftyp, moov(null), mdat))).toBe(false); // no track
    expect(delivered(concat(ftyp, moov('vide'), mdat))).toBe(false); // a video track only
    expect(delivered(webmWith(1))).toBe(false); // a video track only
    // Cut off.
    expect(delivered(mp3Frames(2).slice(0, 600))).toBe(false); // the second frame is incomplete
    expect(delivered(mp3Frames(1))).toBe(false);
    expect(delivered(wav(200).slice(0, 44))).toBe(false); // no samples
    expect(delivered(concat(flacHeader, zeros(60)))).toBe(false); // no frame
    expect(delivered(concat(flacHeader, [0xff, 0xf8], zeros(100)))).toBe(false); // sync, then a reserved block size
    expect(delivered(concat(flacHeader, [0xff, 0xf8, 0xc0, 0x08], zeros(4)))).toBe(false); // a frame header, cut off
    expect(delivered(ogg.slice(0, ogg.length - 10))).toBe(false); // the audio page is incomplete
    // Codec headers and nothing to play.
    expect(delivered(concat(opusHead, opusTags))).toBe(false);
    expect(delivered(vorbisHeaders)).toBe(false);
    expect(delivered(mp4.slice(0, mp4.length - 50))).toBe(false); // mdat runs past the end
  });
});
