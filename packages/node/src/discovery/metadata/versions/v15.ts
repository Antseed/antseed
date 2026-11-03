import { AUDIO_SPEECH_PROTOCOLS } from "../../peer-metadata.js";
import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { extendVocabulary } from "../vocabulary.js";
import { V14_LAYOUT } from "./v14.js";

/**
 * v15: speech services. Same blocks as v14; documents may now name the
 * `openai-audio-speech` protocol and the `input_characters` billing unit, and
 * service capabilities may carry a speech options block (voices, formats).
 */
export const V15_LAYOUT: MetadataLayout = {
  ...V14_LAYOUT,
  vocabulary: extendVocabulary(V14_LAYOUT.vocabulary, {
    protocols: AUDIO_SPEECH_PROTOCOLS,
    units: ["input_characters"],
    capabilityOptions: ["speech"],
  }),
};

export const metadataV15 = defineMetadataVersion({
  version: 15,
  wideServiceCounts: true,
  servable: true,
  ...V15_LAYOUT,
});
