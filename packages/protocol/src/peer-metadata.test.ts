import { describe, expect, it } from 'vitest';
import { speechVoiceProblem, validateServiceCapabilityFields } from './peer-metadata.js';
import { AUDIO_SPEECH_PROTOCOLS, isAudioSpeechProtocol, isKnownServiceApiProtocol } from './service-api.js';

describe('speech capabilities', () => {
  it('accepts listed voices, formats and the custom voice flag', () => {
    expect(validateServiceCapabilityFields({
      inputs: ['text'],
      outputs: ['audio'],
      speech: { voices: ['af_sky', 'Uncle_Fu', 'Charlotte'], formats: ['mp3', 'wav'], customVoices: true },
    })).toEqual([]);
  });

  it('rejects empty, duplicate, malformed and unknown speech options', () => {
    expect(validateServiceCapabilityFields({ speech: {} })).toContain('speech must announce at least one option');
    expect(validateServiceCapabilityFields({ speech: { voices: [] } })).toContain('speech.voices must contain 1-128 values');
    expect(validateServiceCapabilityFields({ speech: { voices: ['a', 'a'] } })).toContain('Duplicate speech.voices value "a"');
    expect(validateServiceCapabilityFields({ speech: { voices: ['<script>'] } })).toContain('Invalid speech.voices value "<script>"');
    expect(validateServiceCapabilityFields({ speech: { formats: ['MP3'] } })).toContain('Invalid speech.formats value "MP3"');
    expect(validateServiceCapabilityFields({ speech: { voices: ['a'], pitch: 1 } as never })).toContain('Unsupported speech option pitch');
  });

  it('refuses a voice the service does not list instead of substituting one', () => {
    const speech = { voices: ['af_sky', 'am_adam'] };
    expect(speechVoiceProblem(speech, 'af_sky')).toBeNull();
    expect(speechVoiceProblem(speech, undefined)).toBeNull();
    expect(speechVoiceProblem(speech, 'alloy')).toBe('Voice "alloy" is not offered by this service. Available voices: af_sky, am_adam');
    expect(speechVoiceProblem(speech, '')).toBe('voice must be a non-empty string');
    // Unknown lists and custom voice IDs are left to the upstream.
    expect(speechVoiceProblem(undefined, 'alloy')).toBeNull();
    expect(speechVoiceProblem({ ...speech, customVoices: true }, 'my-cloned-voice')).toBeNull();
  });

  it('knows the speech protocol', () => {
    expect(AUDIO_SPEECH_PROTOCOLS).toEqual(['openai-audio-speech']);
    expect(isAudioSpeechProtocol('openai-audio-speech')).toBe(true);
    expect(isAudioSpeechProtocol('openai-images')).toBe(false);
    expect(isKnownServiceApiProtocol('openai-audio-speech')).toBe(true);
  });
});
