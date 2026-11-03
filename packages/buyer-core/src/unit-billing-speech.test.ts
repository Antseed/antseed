import { describe, expect, it } from 'vitest';
import type { UnitBillingModelV1 } from '@antseed/protocol/billing';
import { validateUnitBillingUsage } from '@antseed/protocol/billing';
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  estimateUnitRequestCost,
  isUnitBilledProtocol,
  validateUnitBillingModelForProtocolV1,
} from './unit-billing.js';

/** $62.50 per million characters, as Venice prices ElevenLabs. */
const perCharacter: UnitBillingModelV1 = { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.0000625 }] };

function speechRequest(body: Record<string, unknown>) {
  return {
    requestId: 'r',
    method: 'POST',
    path: '/v1/audio/speech',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function capture(body: Record<string, unknown> = { model: 'tts-elevenlabs-turbo-v2-5', input: 'a'.repeat(1000), voice: 'Rachel' }) {
  return captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'openai',
    service: 'tts-elevenlabs-turbo-v2-5',
    serviceApiProtocol: 'openai-audio-speech',
    request: speechRequest(body),
  });
}

const audio = (statusCode: number, contentType = 'audio/mpeg') => ({
  requestId: 'r', statusCode, headers: { 'content-type': contentType }, body: new Uint8Array([0x49, 0x44, 0x33, 4]),
});

describe('speech billing', () => {
  it('bills input_characters only for openai-audio-speech', () => {
    expect(isUnitBilledProtocol('openai-audio-speech')).toBe(true);
    expect(validateUnitBillingModelForProtocolV1('openai-audio-speech', perCharacter)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', perCharacter)).toEqual(['input_characters is not supported for openai-images']);
    expect(validateUnitBillingModelForProtocolV1('openai-audio-speech', { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] }))
      .toEqual(['output_images is not supported for openai-audio-speech']);
  });

  it('reserves the price of the input before the request', () => {
    const captured = capture();
    expect(captured.requestUsage).toEqual({ units: { input_characters: 1000 } });
    expect(captured.context.unitLimits).toEqual({ input_characters: 1000 });
    expect(captured.requestFacts).toEqual({ kind: 'speech', speech: { characters: 1000, voice: 'Rachel' } });
    expect(estimateUnitRequestCost(perCharacter, captured.context, captured.requestUsage)).toBe(62_500n);
  });

  it('charges delivered audio and nothing for an error, even one labelled audio', () => {
    const captured = capture();
    const cost = (response: ReturnType<typeof audio>) => computeFinalUnitBilling(perCharacter, captured.context, response, captured.requestFacts);
    expect(cost(audio(200)).costUsdc).toBe(62_500n);
    expect(cost(audio(200)).billingUsage).toEqual({ version: 1, units: { input_characters: '1000' } });
    expect(cost(audio(200, 'audio/wav')).costUsdc).toBe(62_500n);
    expect(cost(audio(400, 'audio/mpeg; charset=utf-8')).costUsdc).toBe(0n);
    expect(cost(audio(500)).costUsdc).toBe(0n);
    expect(cost(audio(200, 'application/json')).costUsdc).toBe(0n);
  });

  it('lets the buyer refuse a seller claim beyond the characters it sent', () => {
    const captured = capture();
    expect(() => validateUnitBillingUsage(
      perCharacter, captured.context, { version: 1, units: { input_characters: '1001' } }, 62_563n, 1, { units: { input_characters: 1000 } },
    )).toThrow('Seller reported input_characters=1001 but request allowed 1000');
    expect(validateUnitBillingUsage(
      perCharacter, captured.context, { version: 1, units: { input_characters: '1000' } }, 62_500n, 1, { units: { input_characters: 1000 } },
    )).toBe(62_500n);
  });

  it('refuses a speech request without text input', () => {
    expect(() => capture({ model: 'tts-kokoro', voice: 'af_sky' })).toThrow('Speech billing requires a JSON body with a non-empty text "input"');
  });
});
