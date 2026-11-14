import type { PeerMetadata, ProviderAnnouncement } from "../peer-metadata.js";
import { toPeerId } from "../../types/peer.js";
import { bytesToHex, hexToBytes } from "../../utils/hex.js";
import type { MetadataFieldContext, PeerField, ProviderField } from "./field.js";
import { MetadataReader, MetadataWriter, SIGNATURE_LENGTH } from "./wire.js";
import { withinVocabulary, type MetadataVocabulary } from "./vocabulary.js";

export interface MetadataLayout {
  /** Blocks of each provider entry, in wire order. */
  providerFields: readonly ProviderField[];
  /** Peer-level blocks after the provider entries, in wire order. */
  peerFields: readonly PeerField[];
  /** Protocols, billing units and capability options documents may name. */
  vocabulary: MetadataVocabulary;
}

export interface MetadataVersionSpec extends MetadataLayout {
  version: number;
  /** Per-service entry counts are u16 instead of u8. */
  wideServiceCounts: boolean;
  /** Whether sellers still sign and serve this version; the rest are decode-only. */
  servable: boolean;
  /**
   * Version-specific changes when building this version's document from the
   * seller's newest metadata. Services outside the version's vocabulary and
   * fields it does not carry are left out automatically, before and after.
   */
  fromLatest?: (latest: PeerMetadata) => PeerMetadata;
}

export interface MetadataEncodeOptions {
  /**
   * Ordering for signed service maps. "legacy-locale" (the default) is the
   * historical host-locale `localeCompare` order, so existing signed bytes
   * are unchanged; "code-unit" is the deterministic order the
   * compatibility-aware verifier also accepts (issue #1678).
   */
  serviceOrder?: "legacy-locale" | "code-unit";
}

export interface MetadataVersionCodec {
  readonly version: number;
  /** Whether sellers still sign and serve this version. */
  readonly servable: boolean;
  /** Signed bytes: everything except the trailing signature. */
  encodeBody(metadata: PeerMetadata, options?: MetadataEncodeOptions): Uint8Array;
  decode(data: Uint8Array): PeerMetadata;
  /** This version's document built from the seller's newest metadata. */
  fromLatest(latest: PeerMetadata): PeerMetadata;
  /** Whether this version carries the given provider field. */
  carriesProviderField(key: keyof ProviderAnnouncement): boolean;
  /** Protocols, billing units and capability options documents may name. */
  readonly vocabulary: MetadataVocabulary;
}

/** Keys every provider entry and every document carries. */
const PROVIDER_REQUIRED_KEYS = new Set<keyof ProviderAnnouncement>([
  "provider", "services", "defaultPricing", "maxConcurrency", "currentLoad",
]);
const PEER_HEADER_KEYS = new Set<keyof PeerMetadata>([
  "peerId", "version", "region", "timestamp", "providers", "signature",
  // Unsigned buyer-local or informational fields that ride along in JSON.
  "stakeAmountUSDC", "resolvedAtMs", "serverDateMs",
]);

/**
 * Wire layout shared by every version:
 * [version:1][peerId:20][regionLen:1][region:N][timestamp:8][providerCount:1]
 * [provider fields...]×providerCount [peer fields...] [signature:65]
 */
export function defineMetadataVersion(spec: MetadataVersionSpec): MetadataVersionCodec {
  const ctx: MetadataFieldContext = { version: spec.version, wideServiceCounts: spec.wideServiceCounts };
  const providerKeys = new Set<keyof ProviderAnnouncement>(PROVIDER_REQUIRED_KEYS);
  for (const field of spec.providerFields) if (field.key) providerKeys.add(field.key);
  const peerKeys = new Set<keyof PeerMetadata>(PEER_HEADER_KEYS);
  for (const field of spec.peerFields) for (const key of field.keys) peerKeys.add(key);

  function strip(metadata: PeerMetadata): PeerMetadata {
    const result = Object.fromEntries(
      Object.entries(metadata).filter(([key]) => peerKeys.has(key as keyof PeerMetadata)),
    ) as unknown as PeerMetadata;
    result.version = spec.version;
    result.providers = metadata.providers.map((provider) => Object.fromEntries(
      Object.entries(provider).filter(([key]) => providerKeys.has(key as keyof ProviderAnnouncement)),
    ) as unknown as ProviderAnnouncement);
    return result;
  }

  return {
    version: spec.version,
    servable: spec.servable,
    vocabulary: spec.vocabulary,

    encodeBody(metadata, options) {
      // Signing keeps the historical host-locale order by default so existing
      // signed bytes are unchanged; verification may request code-unit order
      // for its compatibility candidate (issue #1678).
      const encodeCtx: MetadataFieldContext =
        options?.serviceOrder === "code-unit" ? { ...ctx, serviceOrder: "code-unit" } : ctx;
      const writer = new MetadataWriter();
      writer.u8(spec.version);
      writer.bytes(hexToBytes(metadata.peerId));
      writer.utf8Wrapping(metadata.region);
      writer.u64(metadata.timestamp);
      writer.u8(metadata.providers.length);
      for (const provider of metadata.providers) {
        for (const field of spec.providerFields) field.encode(writer, provider, encodeCtx);
      }
      for (const field of spec.peerFields) field.encode(writer, metadata, encodeCtx);
      return writer.finish();
    },

    decode(data) {
      const reader = new MetadataReader(data, data.length - SIGNATURE_LENGTH);
      reader.u8(); // version, already dispatched on
      const peerId = bytesToHex(reader.bytes(20));
      const region = reader.utf8();
      const timestamp = reader.u64();
      const providerCount = reader.u8();
      const providers: ProviderAnnouncement[] = [];
      for (let i = 0; i < providerCount; i += 1) {
        const provider: ProviderAnnouncement = {
          provider: "",
          services: [],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          maxConcurrency: 0,
          currentLoad: 0,
        };
        for (const field of spec.providerFields) field.decode(reader, provider, ctx);
        providers.push(provider);
      }
      const metadata: PeerMetadata = {
        peerId: toPeerId(peerId),
        version: spec.version,
        providers,
        region,
        timestamp,
        signature: "",
      };
      for (const field of spec.peerFields) field.decode(reader, metadata, ctx);
      if (data.length - reader.offset < SIGNATURE_LENGTH) throw new Error("Truncated metadata buffer");
      metadata.signature = bytesToHex(data.slice(reader.offset, reader.offset + SIGNATURE_LENGTH));
      return metadata;
    },

    fromLatest(latest) {
      if (!spec.servable) throw new Error(`Metadata v${spec.version} is decode-only`);
      const known = withinVocabulary(latest, spec.vocabulary);
      return strip(spec.fromLatest ? spec.fromLatest(known) : known);
    },

    carriesProviderField(key) {
      return providerKeys.has(key);
    },
  };
}


/** Copy of `fields` with `added` placed right before `anchor`. */
export function insertBefore<T>(fields: readonly T[], anchor: T, ...added: T[]): T[] {
  const index = fields.indexOf(anchor);
  if (index < 0) throw new Error("insertBefore: anchor field is not in the layout");
  return [...fields.slice(0, index), ...added, ...fields.slice(index)];
}
