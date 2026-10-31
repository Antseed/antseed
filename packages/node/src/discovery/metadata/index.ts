/**
 * Signed peer metadata codec.
 *
 * Every metadata version lives in its own file under `versions/` and lists
 * the shared field modules from `fields/` it carries, in wire order. To add a
 * version: write the new field module, add `versions/vNN.ts` that extends the
 * previous layout, register it below, and bump METADATA_VERSION. Older
 * versions keep their bytes, so sellers can keep serving them to buyers that
 * have not upgraded (see `negotiateMetadataVersion`).
 */
import type { PeerMetadata } from "../peer-metadata.js";
import { LEGACY_METADATA_VERSION, METADATA_VERSION } from "../peer-metadata.js";
import { hexToBytes } from "../../utils/hex.js";
import type { MetadataVersionCodec } from "./define-version.js";
import { metadataV10 } from "./versions/v10.js";
import { metadataV11 } from "./versions/v11.js";
import { metadataV12 } from "./versions/v12.js";
import { metadataV13 } from "./versions/v13.js";
import { metadataV14 } from "./versions/v14.js";

export type { MetadataVersionCodec } from "./define-version.js";

const CODECS = new Map<number, MetadataVersionCodec>(
  [metadataV10, metadataV11, metadataV12, metadataV13, metadataV14].map((codec) => [codec.version, codec]),
);

if (!CODECS.has(METADATA_VERSION)) {
  throw new Error(`No codec registered for METADATA_VERSION ${METADATA_VERSION}`);
}

export function getMetadataCodec(version: number): MetadataVersionCodec {
  const codec = CODECS.get(version);
  if (!codec) throw new Error(`Unsupported metadata version ${version}`);
  return codec;
}

/** Versions a seller signs on every refresh, oldest first. */
export const SERVED_METADATA_VERSIONS: readonly number[] = [...CODECS.values()]
  .filter((codec) => codec.servable && codec.version <= METADATA_VERSION)
  .map((codec) => codec.version)
  .sort((a, b) => a - b);

/**
 * The version a seller should answer with. `requested` is the newest version
 * the buyer understands, from the metadata version request header; buyers
 * that predate the header send nothing and get the legacy version.
 */
export function negotiateMetadataVersion(requested: number | undefined): number {
  const ceiling = requested === undefined || !Number.isSafeInteger(requested)
    ? LEGACY_METADATA_VERSION
    : Math.min(requested, METADATA_VERSION);
  let chosen = SERVED_METADATA_VERSIONS[0]!;
  for (const version of SERVED_METADATA_VERSIONS) {
    if (version <= ceiling) chosen = version;
  }
  return chosen;
}

/** Signed bytes for `metadata`, laid out by its own `version`. */
export function encodeMetadataForSigning(metadata: PeerMetadata): Uint8Array {
  return getMetadataCodec(metadata.version).encodeBody(metadata);
}

export function encodeMetadata(metadata: PeerMetadata): Uint8Array {
  const body = encodeMetadataForSigning(metadata);
  const signature = hexToBytes(metadata.signature);
  const result = new Uint8Array(body.length + signature.length);
  result.set(body, 0);
  result.set(signature, body.length);
  return result;
}

export function decodeMetadata(data: Uint8Array): PeerMetadata {
  if (data.length < 1) throw new Error("Truncated metadata buffer");
  return getMetadataCodec(data[0]!).decode(data);
}
