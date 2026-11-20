import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V17_LAYOUT } from "./v17.js";

/**
 * v18: image edit prices by input images. Same blocks as v17; unit billing
 * components may now match `input_images` (how many image files an edit
 * sends), which upstreams bill as input on top of the output.
 */
export const V18_LAYOUT: MetadataLayout = {
  ...V17_LAYOUT,
  vocabulary: extendVocabulary(V17_LAYOUT.vocabulary, {
    matchKeys: ["input_images"],
  }),
};

export const metadataV18 = defineMetadataVersion({
  version: 18,
  wideServiceCounts: true,
  servable: true,
  ...V18_LAYOUT,
});
