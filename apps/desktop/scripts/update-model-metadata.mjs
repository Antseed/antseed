#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalModelKey } from '../../../packages/node/dist/model-identity.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const VENICE_URL = 'https://api.venice.ai/api/v1/models?type=all';
const OUTPUT_URL = new URL('../../../packages/node/src/model-metadata.json', import.meta.url);
const TAG_ORDER = [
  'Uncensored',
  'Coding',
  'Reasoning',
  'Vision',
  'Web search',
  'Audio input',
  'Video input',
  'Roleplay',
  'Anime',
  'Fast',
  'Open weights',
];

async function fetchCatalog(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error(`Invalid model catalog from ${url}`);
  return payload.data;
}

function explicitlyOpenWeights(description) {
  return typeof description === 'string'
    && !/\bproprietary\b/i.test(description)
    && /\b(open[- ]source(?:d)?|open[- ]weights?|open[- ]weight(?:ed)?)\b/i.test(description);
}

function tagsFromOpenRouter(model) {
  const tags = new Set();
  const name = model.name ?? model.id;
  if (model.reasoning) tags.add('Reasoning');
  if (model.architecture?.input_modalities?.includes('image')) tags.add('Vision');
  if (/\b(sonar|search)\b/i.test(name)
    && (model.pricing?.web_search != null || model.supported_parameters?.includes('web_search_options'))) {
    tags.add('Web search');
  }
  if (/\b(codex|coder|codestral|code[- ]?audit)\b/i.test(name)) tags.add('Coding');
  if (/\brole[- ]?play\b/i.test(name)) tags.add('Roleplay');
  if (/\b(fast|flash|turbo|lightning|spark|highspeed)\b/i.test(name)) tags.add('Fast');
  if (explicitlyOpenWeights(model.description)) tags.add('Open weights');
  return tags;
}

function tagsFromVenice(model) {
  const tags = new Set();
  const spec = model.model_spec ?? {};
  const capabilities = spec.capabilities ?? {};
  const name = spec.name ?? model.id;
  if (spec.uncensored === true) tags.add('Uncensored');
  if (capabilities.optimizedForCode === true) tags.add('Coding');
  if (capabilities.supportsReasoning === true) tags.add('Reasoning');
  if (capabilities.supportsVision === true) tags.add('Vision');
  if (/\b(sonar|search)\b/i.test(name)
    && (capabilities.supportsWebSearch === true || spec.supportsWebSearch === true)) tags.add('Web search');
  if (capabilities.supportsAudioInput === true) tags.add('Audio input');
  if (capabilities.supportsVideoInput === true) tags.add('Video input');
  if (/\brole[- ]?play\b/i.test(name)) tags.add('Roleplay');
  if (/\banime\b/i.test(name)) tags.add('Anime');
  if (spec.traits?.includes('fastest') || /\b(fast|flash|turbo|lightning|spark|highspeed)\b/i.test(name)) {
    tags.add('Fast');
  }
  if (explicitlyOpenWeights(spec.description)) tags.add('Open weights');
  return tags;
}

function preferredOpenRouterId(id) {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function isCanonicalOpenRouterModel(model) {
  return typeof model.id === 'string'
    && !model.id.startsWith('openrouter/')
    && !model.id.startsWith('~')
    && !model.id.includes(':');
}

function mergeModel(byCanonicalKey, id, source, sourceId, tags) {
  const key = canonicalModelKey(id);
  if (!key) return;
  const entry = byCanonicalKey.get(key) ?? { id, tags: new Set(), sources: {} };
  for (const tag of tags) entry.tags.add(tag);
  const sourceIds = entry.sources[source] ?? new Set();
  sourceIds.add(sourceId);
  entry.sources[source] = sourceIds;
  byCanonicalKey.set(key, entry);
}

async function main() {
  const [openRouter, venice] = await Promise.all([
    fetchCatalog(OPENROUTER_URL),
    fetchCatalog(VENICE_URL),
  ]);
  const byCanonicalKey = new Map();

  // Prefer OpenRouter's unqualified slug as the registry key when both
  // maintained catalogs describe the same canonical model.
  for (const model of openRouter) {
    if (!isCanonicalOpenRouterModel(model)) continue;
    mergeModel(byCanonicalKey, preferredOpenRouterId(model.id), 'openrouter', model.id, tagsFromOpenRouter(model));
  }
  for (const model of venice) {
    mergeModel(byCanonicalKey, model.id, 'venice', model.id, tagsFromVenice(model));
  }

  const aliasesByModel = {
    'e2ee-gemma-4-26b-a4b-uncensored-p': ['gemma-4-26b-uncensored-p'],
    'e2ee-qwen3-6-35b-a3b-uncensored-p': ['qwen3.6-35b-uncensored-p'],
    'olafangensan-glm-4.7-flash-heretic': ['glm-4.7-flash-heretic'],
    'qwen3.6-plus': ['qwen3.6-plus-uncensored'],
    'venice-uncensored-role-play': ['venice-role-play-uncensored'],
  };
  for (const [modelId, aliases] of Object.entries(aliasesByModel)) {
    const entry = byCanonicalKey.get(canonicalModelKey(modelId));
    if (entry) entry.aliases = aliases;
  }

  const models = {};
  for (const entry of [...byCanonicalKey.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const sources = {};
    if (entry.sources.openrouter) sources.openrouter = [...entry.sources.openrouter].sort();
    if (entry.sources.venice) sources.venice = [...entry.sources.venice].sort();
    models[entry.id] = {
      tags: TAG_ORDER.filter((tag) => entry.tags.has(tag)),
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      sources,
    };
  }

  const registry = {
    version: 2,
    reviewedAt: new Date().toISOString().slice(0, 10),
    sources: {
      openrouter: { label: 'OpenRouter model catalog', url: OPENROUTER_URL },
      venice: { label: 'Venice model catalog', url: VENICE_URL },
    },
    tagDefinitions: {
      Uncensored: 'The maintained upstream catalog explicitly marks the model uncensored.',
      Coding: 'The upstream catalog identifies the model as code-optimized or its official model name is code-specific.',
      Reasoning: 'The upstream catalog explicitly identifies reasoning support.',
      Vision: 'The upstream catalog explicitly identifies image input support.',
      'Web search': 'The upstream catalog identifies a search-specialized model with integrated web search.',
      'Audio input': 'The upstream catalog explicitly identifies audio input support.',
      'Video input': 'The upstream catalog explicitly identifies video input support.',
      Roleplay: 'The official model name identifies a roleplay specialization.',
      Anime: 'The official model name identifies an anime image specialization.',
      Fast: 'The official model name or maintained upstream trait identifies a speed-optimized variant.',
      'Open weights': 'A maintained upstream description explicitly identifies the model as open-source or open-weight.',
    },
    models,
  };

  await writeFile(OUTPUT_URL, `${JSON.stringify(registry, null, 2)}\n`);
  const taggedCount = Object.values(models).filter((entry) => entry.tags.length > 0).length;
  console.log(`Updated ${fileURLToPath(OUTPUT_URL)} with ${Object.keys(models).length} models (${taggedCount} tagged).`);
}

await main();
