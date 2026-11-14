import type { PeerMetadata, ProviderAnnouncement } from "../peer-metadata.js";
import { compareCodeUnits, type MetadataReader, type MetadataWriter } from "./wire.js";

export interface MetadataFieldContext {
  version: number;
  /** v12+ writes per-service entry counts as u16 instead of u8. */
  wideServiceCounts: boolean;
  /**
   * Ordering for signed service maps. Signing and verification default to
   * "legacy-locale" — the historical host-locale `localeCompare` order — so
   * existing signed bytes are unchanged. The compatibility-aware verifier
   * additionally reconstructs with "code-unit" order to accept documents
   * whose signature was produced on a host whose collation differs
   * (issue #1678).
   */
  serviceOrder?: "legacy-locale" | "code-unit";
}

/**
 * Comparator for signed service-map entry order, selected by the field
 * context: "code-unit" is the deterministic order the compatibility-aware
 * verifier also accepts, and "legacy-locale" (the default) is the
 * historical host-localeCompare sort.
 */
export function compareServiceNames(
  a: string,
  b: string,
  ctx: MetadataFieldContext,
): number {
  return ctx.serviceOrder === "code-unit"
    ? compareCodeUnits(a, b)
    : a.localeCompare(b);
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
