import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayModelEntry } from '../../gateway/models.js';
import type { GatewayEndpoint } from '../../gateway/service.js';
import { appModelsFromEntries, appModelsReader, patchTarget } from './app-models.js';

const seller = (n: string, fields: Record<string, unknown>) => ({ peerId: n.repeat(40), ...fields });
const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const paid = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
const trusted = { effectiveReputationScore: 80 };
const lowTrust = { effectiveReputationScore: 10 };

const ids = (models: Array<{ id: string }>) => models.map((model) => model.id);

test('an app without funds starts on a free model, even one only low-trust sellers serve', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'trusted-paid', type: 'text', peers: [seller('a', { ...trusted, ...paid })] },
    { id: 'low-trust-free', type: 'text', peers: [seller('b', { ...lowTrust, ...free })] },
    { id: 'low-trust-paid', type: 'text', peers: [seller('c', { ...lowTrust, ...paid })] },
  ];
  const { models, recommended } = appModelsFromEntries(entries);
  assert.deepEqual(ids(models).sort(), ['low-trust-free', 'trusted-paid']);
  assert.equal(recommended[0]?.id, 'low-trust-free');
});

test('a trusted free model leaves the low-trust ones out of the apps', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'trusted-paid', type: 'text', peers: [seller('a', { ...trusted, ...paid })] },
    { id: 'trusted-free', type: 'text', peers: [seller('d', { ...trusted, ...free })] },
    { id: 'low-trust-free', type: 'text', peers: [seller('b', { ...lowTrust, ...free })] },
  ];
  const { models, recommended } = appModelsFromEntries(entries);
  assert.deepEqual(ids(models).sort(), ['trusted-free', 'trusted-paid']);
  assert.deepEqual(ids(recommended), ['trusted-free', 'trusted-paid']);
});

test('a trusted image model alone still leaves the apps their text models', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'image', type: 'image', peers: [seller('a', { ...trusted, minImageUsdPerImage: 0.01 })] },
    { id: 'text-a', type: 'text', peers: [seller('b', { ...lowTrust, ...paid })] },
    { id: 'text-b', type: 'text', peers: [seller('c', { ...lowTrust, ...free })] },
  ];
  const { models, recommended } = appModelsFromEntries(entries);
  assert.deepEqual(ids(models).sort(), ['text-a', 'text-b']);
  assert.equal(recommended[0]?.id, 'text-b');
});

test('a fresh read after a privacy switch skips the cached model list', async () => {
  const endpoint = { mode: 'local', origin: 'http://127.0.0.1:1', apiKey: 'key' } as GatewayEndpoint;
  const forced: boolean[] = [];
  const deps = {
    fetchEntries: async (_endpoint: GatewayEndpoint, options: { force?: boolean } = {}) => {
      forced.push(options.force === true);
      return [];
    },
    log: () => {},
  };
  await appModelsReader({ freshModels: true }, deps)(endpoint);
  await appModelsReader({}, deps)(endpoint);
  assert.deepEqual(forced, [true, false]);
});

test('text models the apps leave out stay at hand for an app already on one', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'trusted-free', type: 'text', peers: [seller('a', { ...trusted, ...free })] },
    { id: 'low-trust-paid', type: 'text', peers: [seller('b', { ...lowTrust, ...paid })] },
    { id: 'low-trust-image', type: 'image', peers: [seller('c', { ...lowTrust, minImageUsdPerImage: 0.01 })] },
  ];
  const { models, unlisted, modelsLoaded } = appModelsFromEntries(entries);
  assert.deepEqual(ids(models), ['trusted-free']);
  assert.deepEqual(ids(unlisted), ['low-trust-paid']);
  assert.equal(modelsLoaded, true);
});

test('a list that could not be read is told apart from an empty one', async () => {
  const endpoint = { mode: 'local', origin: 'http://127.0.0.1:1', apiKey: 'key' } as GatewayEndpoint;
  const read = (fetchEntries: () => Promise<GatewayModelEntry[]>) => appModelsReader({}, { fetchEntries, log: () => {} })(endpoint);
  const empty = await read(async () => []);
  assert.deepEqual(empty.models, []);
  assert.equal(empty.modelsLoaded, true);
  const failed = await read(async () => { throw new Error('HTTP 502'); });
  assert.deepEqual(failed.models, []);
  assert.equal(failed.modelsLoaded, false);
});

test('the patch target carries the models, the unlisted models and whether the list loaded', () => {
  const endpoint = { mode: 'local', origin: 'http://127.0.0.1:1', apiKey: 'key' } as GatewayEndpoint;
  const entries: GatewayModelEntry[] = [
    { id: 'z-ai/glm-5', type: 'text', capabilities: { reasoning: true }, peers: [seller('a', { ...trusted, ...free })] },
    { id: 'low-trust', type: 'text', peers: [seller('b', { ...lowTrust, ...paid })] },
  ];
  const target = patchTarget(endpoint, appModelsFromEntries(entries));
  assert.deepEqual(target.models, [{ id: 'z-ai/glm-5', label: 'z-ai/glm-5', reasoning: true }]);
  assert.deepEqual(target.unlistedModels, [{ id: 'low-trust', label: 'low-trust' }]);
  assert.equal(target.modelsLoaded, true);
  assert.equal(target.defaultModel, 'z-ai/glm-5');
  assert.equal(patchTarget(endpoint, { models: [], unlisted: [], recommended: [], modelsLoaded: false }).modelsLoaded, false);
});
