import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseServiceCapabilitiesInput,
  parseServiceUnitBillingModelsInput,
} from './service-metadata.js';

test('parseServiceCapabilitiesInput validates CLI capability JSON', () => {
  assert.deepEqual(
    parseServiceCapabilitiesInput('{"contextWindow":200000,"inputs":["text","image"],"toolUse":true}'),
    { contextWindow: 200000, inputs: ['text', 'image'], toolUse: true },
  );
  assert.throws(
    () => parseServiceCapabilitiesInput('{"inputs":["telepathy"]}'),
    /Unsupported input modality/,
  );
});

test('parseServiceUnitBillingModelsInput validates CLI billing JSON', () => {
  const models = parseServiceUnitBillingModelsInput(JSON.stringify({
    'openai-images': {
      version: 1,
      components: [{ unit: 'output_images', priceUsd: 0.04, match: { quality: 'high' } }],
    },
  }));
  assert.equal(models['openai-images']?.components[0]?.priceUsd, 0.04);
  assert.throws(
    () => parseServiceUnitBillingModelsInput('{"unknown":{"version":1,"components":[]}}'),
    /known service API protocol/,
  );
});
