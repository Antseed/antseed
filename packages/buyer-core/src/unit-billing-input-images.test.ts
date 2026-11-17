import { describe, expect, it } from 'vitest';
import type { UnitBillingModelV1 } from '@antseed/protocol/billing';
import { captureUnitBillingContext, estimateUnitRequestCost } from './unit-billing.js';

// Per output image by quality, plus what the upstream bills for each image an edit sends.
const gptImage: UnitBillingModelV1 = {
  version: 1,
  components: [
    { unit: 'output_images', priceUsd: 0.05, match: { quality: 'high' } },
    { unit: 'output_images', priceUsd: 0.012, match: { input_images: '1' } },
    { unit: 'output_images', priceUsd: 0.024, match: { input_images: '2' } },
  ],
};
const perImage: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.05 }] };

const BOUNDARY = 'testboundary';

function form(parts: Array<{ name: string; value: string; filename?: string }>): Uint8Array {
  const text = parts.map((part) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"\r\nContent-Type: image/png` : ''}\r\n\r\n${part.value}\r\n`).join('');
  return new TextEncoder().encode(`${text}--${BOUNDARY}--\r\n`);
}

function capture(path: string, body: Uint8Array, contentType = `multipart/form-data; boundary=${BOUNDARY}`) {
  return captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'fal-image',
    service: 'gpt-image',
    serviceApiProtocol: 'openai-images',
    request: { requestId: 'request', method: 'POST', path, headers: { 'content-type': contentType }, body },
  });
}

const text = [
  { name: 'model', value: 'gpt-image' },
  { name: 'prompt', value: 'a hat' },
  { name: 'quality', value: 'high' },
];

describe('image edit prices by input images', () => {
  it('counts the image and mask files an edit sends', () => {
    const one = capture('/v1/images/edits', form([...text, { name: 'image', value: 'png', filename: 'a.png' }]));
    expect(one.context.attributes).toEqual({ model: 'gpt-image', quality: 'high', size: 'auto', input_images: '1' });
    expect(estimateUnitRequestCost(gptImage, one.context, one.requestUsage)).toBe(62_000n);

    const two = capture('/v1/images/edits', form([...text, { name: 'image[]', value: 'png', filename: 'a.png' }, { name: 'mask', value: 'png', filename: 'm.png' }]));
    expect(two.context.attributes?.input_images).toBe('2');
    expect(estimateUnitRequestCost(gptImage, two.context, two.requestUsage)).toBe(74_000n);
  });

  it('counts only file parts, so a text field cannot set the count', () => {
    const captured = capture('/v1/images/edits', form([
      ...text,
      { name: 'input_images', value: '0' },
      { name: 'image', value: 'not a file' },
      { name: 'image', value: 'png', filename: 'a.png' },
    ]));
    expect(captured.context.attributes?.input_images).toBe('1');
  });

  it('reads the part name, not the tail of filename', () => {
    const body = new TextEncoder().encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; filename="image"; name="photo"\r\n\r\npng\r\n--${BOUNDARY}--\r\n`);
    expect(capture('/v1/images/edits', body).context.attributes?.input_images).toBeUndefined();
  });

  it('refuses an edit with a count the service does not price', () => {
    const three = capture('/v1/images/edits', form([...text, ...['a', 'b', 'c'].map((name) => ({ name: 'image[]', value: 'png', filename: `${name}.png` }))]));
    expect(three.context.attributes?.input_images).toBe('3');
    expect(() => estimateUnitRequestCost(gptImage, three.context, three.requestUsage)).toThrow('no price for an edit with 3 input images');
  });

  it('refuses an edit whose count is priced only for other options', () => {
    const bySize: UnitBillingModelV1 = {
      version: 1,
      components: [
        { unit: 'output_images', priceUsd: 0.05 },
        { unit: 'output_images', priceUsd: 0.012, match: { input_images: '1', size: '1024x1024' } },
      ],
    };
    const image = { name: 'image', value: 'png', filename: 'a.png' };
    const priced = capture('/v1/images/edits', form([...text, { name: 'size', value: '1024x1024' }, image]));
    expect(estimateUnitRequestCost(bySize, priced.context, priced.requestUsage)).toBe(62_000n);
    const unpriced = capture('/v1/images/edits', form([...text, { name: 'size', value: '2048x2048' }, image]));
    expect(() => estimateUnitRequestCost(bySize, unpriced.context, unpriced.requestUsage)).toThrow('no price for an edit with 1 input images');
  });

  it('prices an edit on a path in any letter case, as providers read it', () => {
    const captured = capture('/v1/IMAGES/Edits?x=1', form([...text, { name: 'image', value: 'png', filename: 'a.png' }]));
    expect(captured.context.attributes?.input_images).toBe('1');
    expect(estimateUnitRequestCost(gptImage, captured.context, captured.requestUsage)).toBe(62_000n);
  });

  it('bills edits like generations on a service with no input_images price', () => {
    const edit = capture('/v1/images/edits', form([...text, { name: 'image', value: 'png', filename: 'a.png' }]));
    expect(estimateUnitRequestCost(perImage, edit.context, edit.requestUsage)).toBe(50_000n);
  });

  it('sets no input_images on a generation', () => {
    const generation = capture('/v1/images/generations', new TextEncoder().encode(JSON.stringify({ model: 'gpt-image', prompt: 'a hat', quality: 'high' })), 'application/json');
    expect(generation.context.attributes?.input_images).toBeUndefined();
    expect(estimateUnitRequestCost(gptImage, generation.context, generation.requestUsage)).toBe(50_000n);
  });
});
