import type { PeerField } from "../field.js";

/**
 * [flag:1]([legacyReputation:1][channelCount:4][ghostCount:4][reserved:1])?
 */
export const onChainStatsField: PeerField = {
  keys: ["onChainChannelCount", "onChainGhostCount"],
  encode(writer, metadata) {
    if (metadata.onChainChannelCount === undefined) {
      writer.u8(0);
      return;
    }
    writer.u8(1);
    // Legacy reputation byte: channelCount capped to u8.
    writer.u8(Math.min(255, metadata.onChainChannelCount));
    writer.u32(metadata.onChainChannelCount);
    writer.u32(metadata.onChainGhostCount ?? 0);
    writer.u8(0);
  },
  decode(reader, metadata) {
    // Older encoders could end the body before this block.
    if (reader.remaining() < 1) return;
    if (reader.u8() !== 1) return;
    reader.u8();
    metadata.onChainChannelCount = reader.u32();
    metadata.onChainGhostCount = reader.u32();
    reader.u8();
  },
};
