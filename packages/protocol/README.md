# @antseed/protocol

The Antseed wire protocol as a standalone, dependency-light package (ethers
only, no Node-specific APIs). Extracted from `@antseed/node`, which re-exports
everything from its original paths, so existing consumers are unaffected.

Contents, one module per concern (each also available as a subpath export):

| Module | Contents |
|---|---|
| `messages` | `MessageType`, frame constants, all payment/verification/sweep payload interfaces, capability constants |
| `framing` | 9-byte frame header codec (`encodeFrame`, `decodeFrame`, `FrameDecoder`, `MessageMux`) |
| `http` | Serialized HTTP types, streaming/upload header names, upload thresholds |
| `request-codec` | Binary HTTP request/response/chunk payload codec |
| `payment-codec` | JSON codecs for the 0x50–0x5F payment messages |
| `json-codec` | Bounded JSON parsing helpers |
| `signatures` | EIP-712 SpendingAuth/ReserveAuth/EIP-3009 types + signing, metadata v2 encoding, `computeChannelId`, domains |
| `connection-auth` | Signed `intro`/`hello` envelope wire format |
| `signing` | EIP-191 domain-tagged signing (`signData`, `signUtf8`, …) and hex utils |
| `peer-id` | `PeerId` branded type and helpers |
| `billing` | Portable unit-billing metadata, usage reports, validation, and cost evaluation |
| `peer-metadata`, `capability`, `service-api`, `peer-pricing` | Signed discovery metadata types |
| `connection-state` | `ConnectionState` and connection config types |

Note: both `signatures` (SpendingAuth metadata, `2n`) and `peer-metadata`
(discovery records, `10`) define `METADATA_VERSION`. The root export resolves
to the payments constant, matching `@antseed/node`'s public API; use the
`./peer-metadata` subpath for the discovery one.
