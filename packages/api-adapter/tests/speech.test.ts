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

  it('counts only a 2xx non-JSON body as delivered audio', () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33]);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: audio })).toBe(true);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'Content-Type': 'audio/wav' }, body: audio })).toBe(true);
    expect(speechAudioDelivered({ statusCode: 200, headers: {}, body: audio })).toBe(true);
    // Venice labels its JSON errors audio/mpeg: the status decides.
    expect(speechAudioDelivered({ statusCode: 400, headers: { 'content-type': 'audio/mpeg; charset=utf-8' }, body: audio })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: audio })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: audio })).toBe(false);
    expect(speechAudioDelivered({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(0) })).toBe(false);
  });
});
