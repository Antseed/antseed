import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V15_LAYOUT } from "./v15.js";

/**
 * v16: a per-service prompt-size limit. Same blocks as v15; service capabilities
 * may now carry `maxPromptTokens` — the largest prompt a seller accepts for the
 * service, a policy limit distinct from `contextWindow`. Older documents drop it
 * (see each version's vocabulary).
 */
export const V16_LAYOUT: MetadataLayout = {
  ...V15_LAYOUT,
  vocabulary: extendVocabulary(V15_LAYOUT.vocabulary, {
    capabilityOptions: ["maxPromptTokens"],
  }),
};

export const metadataV16 = defineMetadataVersion({
  version: 16,
  wideServiceCounts: true,
  servable: true,
  ...V16_LAYOUT,
});
