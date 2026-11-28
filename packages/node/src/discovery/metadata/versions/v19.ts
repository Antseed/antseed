import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V18_LAYOUT } from "./v18.js";

/**
 * v19: reasoning efforts. Same blocks as v18; service capabilities may now
 * carry `reasoningEfforts`, the seller's own labels for the efforts a service
 * accepts. Older documents keep the service and leave the list out.
 */
export const V19_LAYOUT: MetadataLayout = {
  ...V18_LAYOUT,
  vocabulary: extendVocabulary(V18_LAYOUT.vocabulary, {
    capabilityOptions: ["reasoningEfforts"],
  }),
};

export const metadataV19 = defineMetadataVersion({
  version: 19,
  wideServiceCounts: true,
  servable: true,
  ...V19_LAYOUT,
});
