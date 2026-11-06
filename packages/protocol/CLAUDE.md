# @antseed/protocol

The wire: frames, codecs, EIP-712 SpendingAuth and ReserveAuth. `src/service-api.ts` is the list of standards AntSeed carries. A routing protocol also gets a binding in `ROUTING_WIRES` (`src/routing.ts`), following `docs/protocol/model-routing.md`. It depends only on `ethers`, and everything depends on it.

| Rule | Enforced by |
| --- | --- |
| Protocol ids are append-only: billing metadata encodes them by position. | `src/billing.test.ts` |
| EIP-712 domain `AntseedChannels` / `1`, typehashes byte-equal to the contract. | `packages/node/tests/eip712-contract-compat.test.ts`, `src/signatures.test.ts` |
| Peers on the previous release still read every message: add fields, never repurpose or remove them. | review only |

**Ask first:** any message type, frame layout, codec or signed struct.
