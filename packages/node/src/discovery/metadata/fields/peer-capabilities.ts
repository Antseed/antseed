import type { PeerField } from "../field.js";

/** [count:1]([len:1][capability:N])... — lowercased, deduped, sorted. */
export const peerCapabilitiesField: PeerField = {
  keys: ["capabilities"],
  encode(writer, metadata) {
    const capabilities = Array.from(new Set(
      (metadata.capabilities ?? [])
        .map((capability) => capability.trim().toLowerCase())
        .filter((capability) => capability.length > 0),
    )).sort();
    writer.u8(capabilities.length);
    for (const capability of capabilities) writer.utf8Wrapping(capability);
  },
  decode(reader, metadata) {
    const count = reader.u8();
    const capabilities: string[] = [];
    for (let i = 0; i < count; i += 1) capabilities.push(reader.utf8());
    if (capabilities.length > 0) metadata.capabilities = capabilities;
  },
};
