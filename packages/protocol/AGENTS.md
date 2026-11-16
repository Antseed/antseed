# @antseed/protocol

The wire: frames, codecs, EIP-712 SpendingAuth and ReserveAuth. `src/service-api.ts` is the list of standards Antseed carries. A routing protocol also gets a binding in `ROUTING_WIRES` (`src/routing.ts`), following `docs/protocol/model-routing.md`. It depends only on `ethers`, and everything depends on it.

Published to npm. Portable: buyers, sellers, the browser SDK and the desktop run the same bytes through it, in Node, a browser or a Worker.

## Inside

One module per concern; each is a subpath export in `package.json` and a line in `src/index.ts`, and a new module needs both.

- A message type: a free code in its range in `MessageType` (`src/messages.ts`), its payload interface and codec, and a `CONNECTION_CAPABILITY_*` string when peers on the previous release can't handle it.
- A service API protocol: append it in `src/service-api.ts`, copy it into `packages/api-adapter/src/types.ts`, detect it in `packages/api-adapter/src/detect.ts`, and give it a new metadata version so older documents leave it out.
- A metadata version: the constant in `src/peer-metadata.ts`, any new match key or unit in `src/billing.ts`, then `versions/vNN.ts` and `metadata/index.ts` in node, and `docs/protocol/spec/01-discovery.md`.
- Signed structs, domains, channel ids and SpendingAuth metadata are in `src/signatures.ts`; unit billing both sides run on the same bytes is in `src/billing.ts`.

| Rule | Enforced by |
| --- | --- |
| Protocol ids are append-only: billing metadata encodes them by position. | `src/billing.test.ts` |
| EIP-712 domain `AntseedChannels` / `1`, typehashes byte-equal to the contract. | `packages/node/tests/eip712-contract-compat.test.ts`, `src/signatures.test.ts` |
| Peers on the previous release still read every message: add fields, never repurpose or remove them. | review only |
| Billing units and match keys are append-only too; health enums go on the wire as ids, so never reorder them. | `src/billing.test.ts` (units); review only for health enums and match keys |
| `ZERO_METADATA_HASH`, the SpendingAuth digest, channel id derivation and the v4 and v5 metadata bytes are pinned. Moving any of them breaks open channels. | `src/signatures.test.ts` |
| A payment payload over 64 KiB throws at the sender instead of being dropped by the peer; metadata lists a bounded number of services and the rest share one overflow entry. | `src/payment-codec.test.ts`, `packages/buyer-core/src/channel-usage-accounting.test.ts` |
| The frame header is 9 bytes, big-endian. | `src/framing.test.ts` |
| Node re-exports these exact implementations, and the browser's `hello` verifies on node. | `packages/web-sdk/src/parity.test.ts` |
| Environment-free: no `node:*` or Node built-in imports, no `Buffer`, no `process`, file system or sockets, no runtime dependency but `ethers`. | review only |

## Connections

- Pinned (`workspace:*`) by api-adapter, buyer-core, node, web-sdk and connected-apps; a bump here needs bumps there (`scripts/npm-publish-plan.mjs` fails until they are). Node also re-exports it from its old paths.
- Build tier 0. Dependents import `dist/`, so build this before running their tests. The desktop copies it into its app (`apps/desktop/scripts/prepare-dist.mjs`).
- Kept in sync by hand: EIP-712 type strings with `packages/contracts/payments/AntseedChannels.sol`; the protocol list with `packages/api-adapter/src/types.ts`; the metadata constants with node's `versions/`.

## Traps

- Typecheck does not catch Node-only APIs: the hoisted `@types/node` makes `Buffer` and `node:` imports typecheck. Read your imports.
- Two constants are named `METADATA_VERSION`: SpendingAuth metadata in `signatures.ts` and discovery metadata in `peer-metadata.ts`. The root export is the payments one. The README and `src/index.ts` comment quote older values.
- `OUTPUT_IMAGE_TOKEN_EQUIVALENT` is bound to the SpendingAuth metadata version; changing it needs a version bump.
- A new SpendingAuth metadata version keeps the previous zero form in `ZERO_METADATA_BY_HASH` and its decoder in `decodeSpendingAuthMetadata`, since buyers that have not upgraded still sign it.
- A SpendingAuth once grew past the 64 KiB payment limit, the seller dropped every later auth and the channel answered 402 forever. Hence `MAX_METADATA_SERVICES` and `boundServiceMetadata`.
- `eip712-contract-compat.test.ts` compares against a copied type string, not the `.sol` file; a contract change updates that test in the same PR.
- Raising `MIN_SUPPORTED_METADATA_VERSION` or `LEGACY_METADATA_VERSION` drops peers that have not upgraded.

**Ask first:** any message type, frame layout, codec or signed struct.

**Prove it:** `pnpm --filter @antseed/protocol test` and `typecheck`, then build it and run `pnpm --filter @antseed/node test` and `pnpm --filter @antseed/web-sdk test`. A signed-struct change also runs `forge test` in `packages/contracts`.
