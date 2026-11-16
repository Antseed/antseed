import { DATA_SERVICE_PROTOCOLS } from "../../peer-metadata.js";
import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V17_LAYOUT } from "./v17.js";

/**
 * v18: data services. Same blocks as v17; documents may now name the
 * `openapi-data` protocol. Data services bill `completed_requests`, a unit
 * every served version already knows.
 */
export const V18_LAYOUT: MetadataLayout = {
  ...V17_LAYOUT,
  vocabulary: extendVocabulary(V17_LAYOUT.vocabulary, {
    protocols: DATA_SERVICE_PROTOCOLS,
  }),
};

export const metadataV18 = defineMetadataVersion({
  version: 18,
  wideServiceCounts: true,
  servable: true,
  ...V18_LAYOUT,
});
