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

  /** `head` padded to a body the size of a short real answer. */
  const file = (head: number[] | string, size = 256) => {
    const bytes = new Uint8Array(size);
    bytes.set(typeof head === 'string' ? new TextEncoder().encode(head) : head);
    return bytes;
  };
  const mp3 = file([0xff, 0xfb, 0x90, 0x64]);

  it('counts only a 2xx answer framed like audio as delivered', () => {
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: mp3 })).toBe(true);
    expect(speechAudioDelivered({ statusCode: 200, headers: {}, body: mp3 })).toBe(true);
    // Venice labels its JSON errors audio/mpeg: the status decides.
    expect(speechAudioDelivered({ statusCode: 400, headers: { 'content-type': 'audio/mpeg; charset=utf-8' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: mp3 })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(0) })).toBe(false);
  });

  it('recognises each audio format a speech API returns', () => {
    const delivered = (body: Uint8Array, format?: string) => speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body }, format);
    // An ID3 tag of 20 bytes, then the first MPEG frame.
    const id3 = file([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20]);
    id3.set([0xff, 0xfb, 0x90, 0x64], 30);
    expect(delivered(id3)).toBe(true);
    expect(delivered(file([0xff, 0xf1, 0x50, 0x80]))).toBe(true); // AAC (ADTS)
    expect(delivered(file('RIFF\0\0\0\0WAVEfmt '))).toBe(true);
    expect(delivered(file('fLaC'))).toBe(true);
    expect(delivered(file('OggS'))).toBe(true);
    expect(delivered(file('\0\0\0\x20ftypM4A '))).toBe(true);
    expect(delivered(file([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    // Raw PCM has no header: whole 16-bit samples, when the request asked for pcm.
    expect(delivered(file([1, 2, 3, 4]), 'pcm')).toBe(true);
    expect(delivered(file([1, 2, 3, 4]))).toBe(false);
    expect(delivered(file([1, 2, 3, 4], 257), 'pcm')).toBe(false);
  });

  it('counts no characters for a stub or an error document labelled as audio', () => {
    const delivered = (body: Uint8Array, format?: string) => speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body }, format);
    expect(delivered(new Uint8Array([0xff]))).toBe(false);
    expect(delivered(new Uint8Array([0x49, 0x44, 0x33, 1]))).toBe(false);
    const jsonError = new TextEncoder().encode(JSON.stringify({ error: { message: 'Voice is not supported', type: 'invalid_request_error', code: 'voice' }, detail: 'x'.repeat(80) }));
    expect(delivered(jsonError)).toBe(false);
    expect(delivered(jsonError, 'pcm')).toBe(false);
    // Framing that is not audio: an ID3 tag with no frame after it, a RIFF that is not WAVE.
    expect(delivered(file([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20]))).toBe(false);
    expect(delivered(file('RIFF\0\0\0\0AVI LIST'))).toBe(false);
    expect(delivered(file([0xff, 0xff, 0xff, 0xff]))).toBe(false);
  });
});
