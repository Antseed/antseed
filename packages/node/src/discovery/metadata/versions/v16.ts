import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V15_LAYOUT } from "./v15.js";

/**
 * v16: video prices by aspect ratio and audio. Same blocks as v15; unit
 * billing components may now match `aspect_ratio` and `audio`, and a model may
 * carry up to 64 components (a resolution × aspect ratio × audio grid needs
 * more than 8).
 */
export const V16_LAYOUT: MetadataLayout = {
  ...V15_LAYOUT,
  vocabulary: extendVocabulary(V15_LAYOUT.vocabulary, {
    matchKeys: ["aspect_ratio", "audio"],
    maxBillingComponents: 64,
  }),
};

export const metadataV16 = defineMetadataVersion({
  version: 16,
  wideServiceCounts: true,
  servable: true,
  ...V16_LAYOUT,
});
