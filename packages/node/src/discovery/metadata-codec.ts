// The codec is split into shared field modules and one file per version
// under ./metadata/; this module keeps the old import path working.
export {
  decodeMetadata,
  encodeMetadata,
  encodeMetadataForSigning,
  getMetadataCodec,
  negotiateMetadataVersion,
  SERVED_METADATA_VERSIONS,
  type MetadataVersionCodec,
} from "./metadata/index.js";
