import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, SPEECH_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import { buildNetworkServiceOffers, selectLowestPricedNetworkServiceOffer } from '../src/discovery/service-catalog.js';
import { supportsHealthProbe } from '../src/health/model-health-checker.js';

/** A Venice-style seller: chat, an image service with edits, and two speech services. */
function speechMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'openai',
      services: ['kimi-k3', 'nano-banana-pro', 'tts-kokoro', 'tts-elevenlabs-turbo-v2-5'],
      defaultPricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.45 },
      servicePricing: { 'tts-kokoro': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceCategories: { 'tts-kokoro': ['audio'], 'kimi-k3': ['chat'] },
      serviceApiProtocols: {
        'kimi-k3': ['openai-chat-completions'],
        'nano-banana-pro': ['openai-images'],
        'tts-kokoro': ['openai-audio-speech'],
        'tts-elevenlabs-turbo-v2-5': ['openai-audio-speech'],
      },
      serviceUnitBillingModels: {
        'nano-banana-pro': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.0625 }] } },
        'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.0000625 }] } },
        'tts-elevenlabs-turbo-v2-5': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.00003125 }] } },
      },
      serviceCapabilities: {
        'kimi-k3': { contextWindow: 256_000, inputs: ['text'] },
        'nano-banana-pro': { inputs: ['text', 'image'], outputs: ['image'], supportedParameters: ['image', 'moderation'] },
        'tts-kokoro': { inputs: ['text'], outputs: ['audio'], speech: { voices: ['af_sky', 'am_adam'], formats: ['mp3', 'wav'], customVoices: false } },
        'tts-elevenlabs-turbo-v2-5': { inputs: ['text'], outputs: ['audio'], speech: { voices: ['Rachel', 'Brian'], customVoices: true } },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('speech services in peer metadata', () => {
  it('is v15, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBeGreaterThanOrEqual(15);
    expect(SPEECH_METADATA_VERSION).toBe(15);
    expect(SERVED_METADATA_VERSIONS).toContain(15);
    expect(negotiateMetadataVersion(15)).toBe(15);
    expect(negotiateMetadataVersion(14)).toBe(14);
  });

  it('round-trips speech options and re-encodes to the same signed bytes', () => {
    const original = speechMetadata();
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(METADATA_VERSION);
    expect(decoded.providers[0]!.serviceCapabilities).toEqual(original.providers[0]!.serviceCapabilities);
    // Prices travel as f32: a per-character price keeps ~7 significant digits.
    const decodedPrice = decoded.providers[0]!.serviceUnitBillingModels!['tts-kokoro']!['openai-audio-speech']!.components[0]!;
    expect(decodedPrice.unit).toBe('input_characters');
    expect(decodedPrice.priceUsd).toBeCloseTo(0.0000625, 10);
    expect(decoded.providers[0]!.serviceApiProtocols?.['tts-kokoro']).toEqual(['openai-audio-speech']);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  it('signs the voice list', () => {
    const original = speechMetadata();
    const changed = structuredClone(original);
    changed.providers[0]!.serviceCapabilities!['tts-kokoro']!.speech!.voices = ['af_sky'];
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(original));
  });

  for (const version of [12, 13, 14]) {
    it(`leaves speech services out of the v${version} document so older buyers keep the rest of the seller`, () => {
      const older = getMetadataCodec(version).fromLatest(speechMetadata());
      expect(older.version).toBe(version);
      const provider = older.providers[0]!;
      expect(provider.services).toEqual(['kimi-k3', 'nano-banana-pro']);
      expect(Object.keys(provider.serviceApiProtocols ?? {})).toEqual(['kimi-k3', 'nano-banana-pro']);
      expect(Object.keys(provider.serviceUnitBillingModels ?? {})).toEqual(['nano-banana-pro']);
      expect(provider.servicePricing).toBeUndefined();
      expect(Object.keys(provider.serviceCategories ?? {})).toEqual(['kimi-k3']);
      expect(Object.values(provider.serviceCapabilities ?? {}).some((caps) => caps.speech !== undefined)).toBe(false);
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
      // What a buyer on that version decodes, with the unit and protocol ids it knows.
      expect(decodeMetadata(encodeMetadata(older)).providers[0]!.services).toEqual(['kimi-k3', 'nano-banana-pro']);
    });
  }

  it('drops a provider that only offers speech from older documents', () => {
    const latest = speechMetadata();
    const provider = latest.providers[0]!;
    latest.providers = [{
      ...provider,
      services: ['tts-kokoro'],
      serviceApiProtocols: { 'tts-kokoro': ['openai-audio-speech'] },
      serviceUnitBillingModels: { 'tts-kokoro': provider.serviceUnitBillingModels!['tts-kokoro']! },
      serviceCapabilities: { 'tts-kokoro': provider.serviceCapabilities!['tts-kokoro']! },
      servicePricing: undefined,
      serviceCategories: undefined,
    }];
    expect(getMetadataCodec(14).fromLatest(latest).providers).toEqual([]);
  });

  it('strips speech entries from a wildcard provider and keeps its wildcard', () => {
    const latest = speechMetadata();
    latest.providers = [{ ...latest.providers[0]!, services: [] }];
    expect(validateMetadata(latest)).toEqual([]);
    const older = getMetadataCodec(14).fromLatest(latest);
    const provider = older.providers[0]!;
    expect(provider.services).toEqual([]);
    expect(Object.keys(provider.serviceApiProtocols ?? {})).toEqual(['kimi-k3', 'nano-banana-pro']);
    expect(Object.keys(provider.serviceUnitBillingModels ?? {})).toEqual(['nano-banana-pro']);
    expect(Object.values(provider.serviceCapabilities ?? {}).some((caps) => caps.speech !== undefined)).toBe(false);
    expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
    expect(() => encodeMetadataForSigning(older)).not.toThrow();
  });

  it('refuses speech fields in documents older than v15', () => {
    const older = { ...speechMetadata(), version: 14 };
    const messages = validateMetadata(older).map((error) => error.message);
    expect(messages).toContain('Service API protocol "openai-audio-speech" requires metadata version 15');
    expect(messages).toContain('Billing unit "input_characters" requires metadata version 15');
    expect(messages).toContain('Service capability "speech" requires metadata version 15');
    expect(() => encodeMetadataForSigning(older)).toThrow('Speech capabilities require metadata version 15');
  });

  it('lists speech services as speech offers priced per character', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['openai'],
      providerServiceApiProtocols: { openai: { services: { 'tts-kokoro': ['openai-audio-speech'] } } },
      providerServiceCapabilities: { openai: { services: { 'tts-kokoro': { outputs: ['audio'], speech: { voices: ['af_sky'] } } } } },
      providerServiceUnitBillingModels: { openai: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.0000035 }] } } } } },
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.45 } } },
    }]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ serviceId: 'tts-kokoro', type: 'speech', protocol: 'openai-audio-speech' });
    expect(offers[0]!.inputUsdPerMillion).toBeUndefined();
    expect(offers[0]!.unitBillingModels?.['openai-audio-speech']?.components[0]?.unit).toBe('input_characters');
    expect(offers[0]!.capabilities?.speech?.voices).toEqual(['af_sky']);
  });

  it('selects the cheaper per-character speech offer even when it sorts later', () => {
    const speechPeer = (provider: string, priceUsd: number) => ({
      providerServiceApiProtocols: { [provider]: { services: { 'tts-kokoro': ['openai-audio-speech'] } } },
      providerServiceUnitBillingModels: { [provider]: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd }] } } } } },
    });
    const expensive = speechPeer('alpha', 0.00005);
    const cheap = speechPeer('zeta', 0.00001);
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['alpha', 'zeta'],
      providerServiceApiProtocols: { ...expensive.providerServiceApiProtocols, ...cheap.providerServiceApiProtocols },
      providerServiceUnitBillingModels: { ...expensive.providerServiceUnitBillingModels, ...cheap.providerServiceUnitBillingModels },
    }]);
    expect(offers.map((offer) => offer.provider)).toEqual(['alpha', 'zeta']);
    expect(selectLowestPricedNetworkServiceOffer(offers)?.provider).toBe('zeta');
  });

  it('adds model-matched speech charges when comparing per-character prices', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['alpha', 'zeta'],
      providerServiceApiProtocols: {
        alpha: { services: { 'tts-kokoro': ['openai-audio-speech'] } },
        zeta: { services: { 'tts-kokoro': ['openai-audio-speech'] } },
      },
      providerServiceUnitBillingModels: {
        // 0.000001 + 0.0001 per character for this model: dearer than zeta.
        alpha: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [
          { unit: 'input_characters', priceUsd: 0.000001 },
          { unit: 'input_characters', priceUsd: 0.0001, match: { model: 'tts-kokoro' } },
          { unit: 'input_characters', priceUsd: 0.5, match: { model: 'another-voice-model' } },
        ] } } } },
        zeta: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.00001 }] } } } },
      },
    }]);
    expect(selectLowestPricedNetworkServiceOffer(offers)?.provider).toBe('zeta');
  });

  it('ranks a speech offer with an empty billing model as free', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['alpha', 'zeta'],
      providerServiceApiProtocols: {
        alpha: { services: { 'tts-kokoro': ['openai-audio-speech'] } },
        zeta: { services: { 'tts-kokoro': ['openai-audio-speech'] } },
      },
      providerServiceUnitBillingModels: {
        alpha: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.000001 }] } } } },
        zeta: { services: { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [] } } } },
      },
    }]);
    expect(selectLowestPricedNetworkServiceOffer(offers)?.provider).toBe('zeta');
  });

  it('never health-probes speech services, which would cost money', () => {
    expect(supportsHealthProbe('openai-audio-speech')).toBe(false);
    expect(supportsHealthProbe('openai-chat-completions')).toBe(true);
  });
});
