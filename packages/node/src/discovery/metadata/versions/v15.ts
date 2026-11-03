import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { V14_LAYOUT } from "./v14.js";

/**
 * v15: speech services. Same blocks as v14; the documents may now name the
 * `openai-audio-speech` protocol and the `input_characters` billing unit, and
 * service capabilities may carry a speech options block (voices, formats).
 */
export const V15_LAYOUT: MetadataLayout = V14_LAYOUT;

export const metadataV15 = defineMetadataVersion({
  version: 15,
  wideServiceCounts: true,
  ...V15_LAYOUT,
  fromLatest: (latest) => latest,
});
