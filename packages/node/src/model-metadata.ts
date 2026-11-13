import { canonicalModelKey } from './model-identity.js';
import registry from './model-metadata.json' with { type: 'json' };

export type ModelMetadata = {
  readonly tags: readonly string[];
  readonly aliases?: readonly string[];
  readonly sources: Readonly<Record<string, readonly string[]>>;
};

type ModelMetadataRegistry = {
  version: number;
  reviewedAt: string;
  sources: Record<string, { label: string; url: string }>;
  tagDefinitions: Record<string, string>;
  models: Record<string, ModelMetadata>;
};

const modelMetadataRegistry = registry as ModelMetadataRegistry;
if (modelMetadataRegistry.version !== 2) {
  throw new Error(`Unsupported model metadata registry version: ${String(modelMetadataRegistry.version)}`);
}

const metadataByCanonicalKey = new Map<string, ModelMetadata>();
const registeredIdByCanonicalKey = new Map<string, string>();
for (const [registeredId, metadata] of Object.entries(modelMetadataRegistry.models)) {
  for (const candidate of [registeredId, ...(metadata.aliases ?? [])]) {
    const key = canonicalModelKey(candidate);
    if (!key) throw new Error(`Invalid model metadata id: ${candidate}`);
    const existing = metadataByCanonicalKey.get(key);
    if (existing && existing !== metadata) {
      throw new Error(`Duplicate canonical model metadata id: ${candidate}`);
    }
    metadataByCanonicalKey.set(key, metadata);
    registeredIdByCanonicalKey.set(key, registeredId);
  }
}

/** Release-owned model metadata that cannot be expanded by a seller. */
export function modelMetadataFor(serviceId: string): ModelMetadata | null {
  return metadataByCanonicalKey.get(canonicalModelKey(serviceId)) ?? null;
}

/**
 * The reviewed registry id of a model, whatever spelling it was asked for
 * under (vendor path, alias, version punctuation, `-latest`, a release date):
 * `anthropic/claude-opus-4-6` and `claude-opus-4.6` are both `claude-opus-4.6`.
 * Null for a model the registry does not list.
 */
export function registeredModelIdFor(serviceId: string): string | null {
  return registeredIdByCanonicalKey.get(canonicalModelKey(serviceId)) ?? null;
}

/** Tags the model pickers do not offer as filters. */
const HIDDEN_MODEL_TAGS = new Set(['Video input']);

/** The reviewed tags of a model (e.g. Coding, Reasoning, Vision), as the model pickers show them. */
export function modelTagsFor(serviceId: string): string[] {
  return (modelMetadataFor(serviceId)?.tags ?? [])
    .filter((tag) => !HIDDEN_MODEL_TAGS.has(tag));
}

/** Every tag the given models carry, deduplicated and alphabetized. */
export function availableModelTags(serviceIds: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const serviceId of serviceIds) {
    for (const tag of modelTagsFor(serviceId)) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}
