import { describe, expect, it } from 'vitest';
import { estimatePromptTokensForChecks } from './estimated-usage.js';
import { estimateTokensFromBytesSampled } from './pricing.js';

const encoder = new TextEncoder();
const IMAGE_DATA = 'A'.repeat(500_000);

/** A request parsed and the bytes it was parsed from, as a seller holds them. */
const request = (value: Record<string, unknown>) => ({ value, body: encoder.encode(JSON.stringify(value)) });
const estimate = ({ value, body }: { value: Record<string, unknown>; body: Uint8Array }) => estimatePromptTokensForChecks(value, body);

describe('estimatePromptTokensForChecks', () => {
  it('estimates a request without images from its bytes, as before', () => {
    const plain = request({ model: 'm', messages: [{ role: 'user', content: 'seed '.repeat(50_000) }] });
    expect(estimate(plain)).toBe(estimateTokensFromBytesSampled(plain.body));
  });

  it('counts each image as the flat allowance in place of its data, wherever it sits', () => {
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_DATA}` } };
    const withImages = request({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Compare these.' }, image] },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'Screenshot:' }, image] },
    ] });
    const withoutData = request({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Compare these.' }, { type: 'image_url' }] },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'Screenshot:' }, { type: 'image_url' }] },
    ] });
    expect(estimate(withImages)).toBe(estimateTokensFromBytesSampled(withoutData.body) + 2 * 1_290);
  });

  it('counts a document by its bytes', () => {
    const document = request({ model: 'm', messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: IMAGE_DATA } },
    ] }] });
    expect(estimate(document)).toBe(estimateTokensFromBytesSampled(document.body));
  });

  it('reads a request too wide to spread into one call', () => {
    const wide = request({ model: 'm', input: Array.from({ length: 200_000 }, () => 1) });
    expect(estimate(wide)).toBe(estimateTokensFromBytesSampled(wide.body));
  });
});
