import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V16_LAYOUT } from "./v16.js";

/**
 * v17: video prices for reference videos. Same blocks as v16; unit billing
 * components may now match `reference_video` (`"true"` when a create sends
 * reference videos), which upstreams bill on top of the output.
 */
export const V17_LAYOUT: MetadataLayout = {
  ...V16_LAYOUT,
  vocabulary: extendVocabulary(V16_LAYOUT.vocabulary, {
    matchKeys: ["reference_video"],
  }),
};

export const metadataV17 = defineMetadataVersion({
  version: 17,
  wideServiceCounts: true,
  servable: true,
  ...V17_LAYOUT,
});
