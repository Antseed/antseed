import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V17_LAYOUT } from "./v17.js";

/**
 * v18: a per-service prompt-size limit. Same blocks as v17; service capabilities
 * may now carry `maxPromptTokens`, the largest prompt a seller accepts for the
 * service, a policy limit distinct from `contextWindow`. Older documents drop it
 * (see each version's vocabulary).
 */
export const V18_LAYOUT: MetadataLayout = {
  ...V17_LAYOUT,
  vocabulary: extendVocabulary(V17_LAYOUT.vocabulary, {
    capabilityOptions: ["maxPromptTokens"],
  }),
};

export const metadataV18 = defineMetadataVersion({
  version: 18,
  wideServiceCounts: true,
  servable: true,
  ...V18_LAYOUT,
});
