// The codec is split into shared field modules and one file per version
// under ./metadata/; this module keeps the old import path working.
export {
  decodeMetadata,
  encodeMetadata,
  encodeMetadataForSigning,
  getMetadataCodec,
  metadataVersionIntroducing,
  negotiateMetadataVersion,
  SERVED_METADATA_VERSIONS,
  type MetadataVersionCodec,
  type MetadataVocabulary,
  type MetadataVocabularyNameKind,
} from "./metadata/index.js";
