import type { PeerMetadata, ProviderAnnouncement } from "../peer-metadata.js";
import type { MetadataReader, MetadataWriter } from "./wire.js";

export interface MetadataFieldContext {
  version: number;
  /** v12+ writes per-service entry counts as u16 instead of u8. */
  wideServiceCounts: boolean;
}

/**
 * One block of a provider entry. A metadata version is an ordered list of
 * these, so adding a field means writing a new module and listing it in a
 * new version file — existing versions keep their bytes.
 */
export interface ProviderField {
  /** The ProviderAnnouncement key this field carries, if any. */
  readonly key?: keyof ProviderAnnouncement;
  encode(writer: MetadataWriter, provider: ProviderAnnouncement, ctx: MetadataFieldContext): void;
  decode(reader: MetadataReader, provider: ProviderAnnouncement, ctx: MetadataFieldContext): void;
}

/** One peer-level block, written after every provider entry. */
export interface PeerField {
  /** The PeerMetadata keys this field carries. */
  readonly keys: ReadonlyArray<keyof PeerMetadata>;
  encode(writer: MetadataWriter, metadata: PeerMetadata, ctx: MetadataFieldContext): void;
  decode(reader: MetadataReader, metadata: PeerMetadata, ctx: MetadataFieldContext): void;
}
