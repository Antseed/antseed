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

/** An MP3: three 417-byte MPEG-1 layer III frames (128 kbps, 44.1 kHz). */
const MP3 = new Uint8Array(417 * 3);
for (const offset of [0, 417, 834]) MP3.set([0xff, 0xfb, 0x90, 0x00], offset);

const audio = (statusCode: number, contentType = 'audio/mpeg', body: Uint8Array = MP3) => ({
  requestId: 'r', statusCode, headers: { 'content-type': contentType }, body,
});

describe('speech billing', () => {
  it('bills input_characters only for openai-audio-speech', () => {
    expect(isUnitBilledProtocol('openai-audio-speech')).toBe(true);
    expect(validateUnitBillingModelForProtocolV1('openai-audio-speech', perCharacter)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', perCharacter)).toEqual(['input_characters is not supported for openai-images']);
    expect(validateUnitBillingModelForProtocolV1('openai-audio-speech', { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] }))
      .toEqual(['output_images is not supported for openai-audio-speech']);
  });

  it('reserves a request for its audio as a stream of events like one for the audio itself', () => {
    const body = { model: 'tts-elevenlabs-turbo-v2-5', input: 'Hello', voice: 'Rachel' };
    for (const format of ['sse', 'audio', true, '', null, undefined]) {
      expect(capture({ ...body, stream_format: format }).requestUsage, String(format)).toEqual({ units: { input_characters: 5 } });
    }
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
    // Bytes that are not audio are free whatever their label: a stub, an error document.
    expect(cost(audio(200, 'audio/mpeg', new Uint8Array([0xff]))).costUsdc).toBe(0n);
    expect(cost(audio(200, 'audio/mpeg', new TextEncoder().encode(JSON.stringify({ error: { message: 'x'.repeat(80) } })))).costUsdc).toBe(0n);
    // An Ogg Opus stream cut off right after its codec headers holds no audio.
    const page = (payload: number[]) => [0x4f, 0x67, 0x67, 0x53, 0, 0, ...new Array(20).fill(0), 1, payload.length, ...payload];
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    const headersOnly = new Uint8Array([...page([...ascii('OpusHead'), ...new Array(11).fill(0)]), ...page([...ascii('OpusTags'), ...new Array(40).fill(0)])]);
    expect(cost(audio(200, 'audio/ogg', headersOnly)).costUsdc).toBe(0n);
  });

  it('charges raw pcm only when the request asked for pcm', () => {
    const pcm = audio(200, 'audio/pcm', new Uint8Array(256).fill(7));
    const asked = capture({ model: 'tts-elevenlabs-turbo-v2-5', input: 'a'.repeat(1000), response_format: 'pcm' });
    expect(computeFinalUnitBilling(perCharacter, asked.context, pcm, asked.requestFacts).costUsdc).toBe(62_500n);
    const mp3Asked = capture();
    expect(computeFinalUnitBilling(perCharacter, mp3Asked.context, pcm, mp3Asked.requestFacts).costUsdc).toBe(0n);
  });

  describe('audio streamed as events (stream_format "sse")', () => {
    // OpenAI's speech events: `speech.audio.delta` with a chunk of base64 audio, then `speech.audio.done` with the usage.
    const event = (data: Record<string, unknown>) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const delta = (bytes: Uint8Array) => event({ type: 'speech.audio.delta', audio: base64(bytes) });
    const DONE = event({ type: 'speech.audio.done', usage: { input_tokens: 14, output_tokens: 101, total_tokens: 115 } });
    /** The MP3 in three deltas, cut mid-frame as an upstream cuts its chunks. */
    const DELTAS = [MP3.subarray(0, 100), MP3.subarray(100, 700), MP3.subarray(700)].map(delta);
    const stream = (text: string, statusCode = 200) => ({
      requestId: 'r', statusCode, headers: { 'content-type': 'text/event-stream' }, body: new TextEncoder().encode(text),
    });
    const sse = () => capture({ model: 'tts-elevenlabs-turbo-v2-5', input: 'a'.repeat(1000), voice: 'Rachel', stream_format: 'sse' });
    const cost = (response: ReturnType<typeof stream>, captured = sse()) => computeFinalUnitBilling(perCharacter, captured.context, response, captured.requestFacts).costUsdc;

    it('charges the characters when the deltas, decoded and joined in order, are audio and the done event ends them', () => {
      expect(cost(stream(DELTAS.join('') + DONE))).toBe(62_500n);
      // A comment line between events (a keep-alive) is no event.
      expect(cost(stream(`${DELTAS[0]}: keep-alive\n\n${DELTAS.slice(1).join('')}${DONE}`))).toBe(62_500n);
      // A delta whose data spans several lines that join into one JSON object, as a standard client reads it.
      const json = JSON.stringify({ type: 'speech.audio.delta', audio: base64(MP3) });
      const half = json.indexOf(',');
      expect(cost(stream(`data: ${json.slice(0, half + 1)}\ndata: ${json.slice(half + 1)}\n\n${DONE}`))).toBe(62_500n);
    });

    it('charges headerless pcm only when the request asked for pcm', () => {
      const pcm = stream(delta(new Uint8Array(128).fill(7)) + delta(new Uint8Array(128).fill(9)) + DONE);
      const asked = capture({ model: 'tts-elevenlabs-turbo-v2-5', input: 'a'.repeat(1000), response_format: 'pcm', stream_format: 'sse' });
      expect(cost(pcm, asked)).toBe(62_500n);
      expect(cost(pcm)).toBe(0n);
      // Raw pcm is any even-length body, so a stream cut off before its done event must not pass for it.
      expect(cost(stream(delta(new Uint8Array(256).fill(7))), asked)).toBe(0n);
    });

    it('charges nothing for a stream that does not prove the whole audio arrived', () => {
      const cases: Record<string, string> = {
        'no done event': DELTAS.join(''),
        'a done event the stream ended inside': DELTAS.join('') + DONE.slice(0, -1),
        'cut off inside a delta': DELTAS.join('') + DELTAS[0]!.slice(0, 40),
        'no audio': DONE,
        'too little audio': delta(MP3.subarray(0, 32)) + DONE,
        'deltas out of order': [...DELTAS].reverse().join('') + DONE,
        'an error event': DELTAS.join('') + event({ type: 'error', error: { message: 'The server had an error' } }) + DONE,
        'a delta that is not base64': DELTAS.join('') + event({ type: 'speech.audio.delta', audio: '*not base64*' }) + DONE,
        'a delta without audio': DELTAS.join('') + event({ type: 'speech.audio.delta' }) + DONE,
        'deltas whose data lines do not join into one JSON object': `${DELTAS.map((text) => text.split('\n')[1]).join('\n')}\n\n${DONE}`,
        'an event that is not JSON': DELTAS.join('') + 'data: not json\n\n' + DONE,
      };
      for (const [name, text] of Object.entries(cases)) expect(cost(stream(text)), name).toBe(0n);
      expect(cost(stream(DELTAS.join('') + DONE, 500)), 'an error status').toBe(0n);
    });

    it('charges the audio itself from an upstream that ignores stream_format, but no events the request did not ask for', () => {
      expect(cost(audio(200)), 'audio when events were asked for').toBe(62_500n);
      const other = capture({ model: 'tts-elevenlabs-turbo-v2-5', input: 'a'.repeat(1000), voice: 'Rachel', stream_format: true });
      expect(cost(audio(200), other), 'audio when stream_format is not a string').toBe(62_500n);
      expect(cost(stream(DELTAS.join('') + DONE), capture()), 'events when audio was asked for').toBe(0n);
    });
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
