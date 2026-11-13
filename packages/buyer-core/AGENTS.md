# @antseed/buyer-core

The buyer itself: request handling, payment negotiation, what it signs and reserves, and channel accounting. It is environment-free so that the CLI (through `@antseed/node`) and the browser (`@antseed/web-sdk`) run the same code. The environment plugs in through the structural interfaces in `src/interfaces.ts` and `src/channel-store-types.ts`. On-chain channel states are in `channel-session-state.ts`, and stored statuses are in `channel-store-types.ts`.

Published to npm. Every buyer runs it (the CLI buyer, and so the desktop and gateway, and the browser SDK); sellers use `base-evm-client.ts` for their transactions and `keccak.ts` for receipts.

## Inside

- `buyer-request-handler.ts` — one request to one seller, including the single 402 retry. `buyer-payment-negotiator.ts` is the wire side of payments; `buyer-payment-manager.ts` is the money (what is signed, top-ups, how far a seller's claim is believed).
- `proxy-mux.ts`, `payment-mux.ts`, `verification-mux.ts` — frame multiplexers over one `FrameSender`.
- `pricing.ts`, `unit-billing.ts`, `channel-usage-accounting.ts` — cost and usage. A new unit-billed protocol gets an adapter in `unit-billing.ts`.
- `base-evm-client.ts` and the ABI-string `channels-client.ts`, `deposits-client.ts` — the chain.
- A new error code goes in `ERROR_CODES` (`errors.ts`). A new environment need is a member on an interface in `interfaces.ts` or `channel-store-types.ts`, never an import. A new public module needs a line in `src/index.ts` and a subpath export.

| Rule | Enforced by |
| --- | --- |
| Depends only on `protocol`, `api-adapter`, `ethers`, `tokenx`, `@noble/hashes` and `hash-wasm`. No Node-only APIs. | review only |
| On a session channel, `maxPerRequestUsdc` limits one signing step, a catch-up allows one step per request in flight, and the reserve ceiling stops signing. `maxReserveAmountUsdc` limits the opening reserve and sets the top-up step, which grows under load. | `packages/node/tests/buyer-payment-manager.test.ts` |
| Normal signing never lowers `cumulativeAmount`. A close capped at the channel's deposit signs lower and is not persisted. A catch-up signs the seller's required amount and nothing on top, or less when a limit above stops it. | `packages/node/tests/buyer-payment-*.test.ts`, `src/buyer-payment-manager.test.ts` |
| Environment-free means no `node:*` or built-in imports, no `Buffer`, native modules, files or sockets (storage is a `BuyerChannelStore`, transport a `BuyerConnection`). `process` is read only through `readEnv` in `debug.ts`. | review only |
| A signed authorization is persisted, and the store's `flush()` awaited, before it is sent (`_commitAuthorization`). A crash after sending never loses a signature the seller holds. | review only |
| A signature for a channel replaced or retired while being signed never touches the new channel. Of two racing signatures, the higher stays committed and nothing lower is sent. | `packages/node/tests/buyer-payment-stale-write.test.ts` |
| A seller's claimed cost is capped at `costToleranceMultiplier` times the buyer's own estimate. A video is paid at its advertised price, with no tolerance. | `packages/node/tests/buyer-payment-manager.test.ts` |
| A response counted on one path is not counted again on the other; an image adds `OUTPUT_IMAGE_TOKEN_EQUIVALENT` output tokens once. | `src/channel-usage-accounting.test.ts` |
| Transactions never pay ethers' 1 gwei fallback tip; a failed tip read falls back to `DEFAULT_PRIORITY_FEE_WEI`. | `src/base-evm-client.test.ts` |
| A receipt is filed under the peer the request went to and the service the buyer asked for (`ResponseAuthContext`), never the fields the seller wrote. | `src/buyer-request-handler.test.ts` (the peer) |
| Debug logging stays off in content-free mode, since debug lines print upstream bodies. | `src/debug.test.ts` |

## Connections

- `@antseed/node` pins it, re-exports it from `packages/node/src/payments/*.ts`, wires it to sqlite and `PeerConnection`, and holds most of its tests. `@antseed/web-sdk` wires it to WebRTC and IndexedDB. Buyer behavior goes here, never in one of them.
- Release: a bump here needs node and web-sdk bumped, then node's pinning dependents (`scripts/npm-publish-plan.mjs`).
- Kept in sync by hand: the ABI strings in `channels-client.ts` and `deposits-client.ts` with `packages/contracts/payments/*.sol`; the first sentence of `OUT_OF_CREDITS_MESSAGE` with the clients that match it (`apps/cli/src/gateway/server.ts`, `apps/gateway-console/src/pages/Chat.tsx`, telemetry tests, `apps/website/docs/connect/api.md`).
- Limit defaults are set by the hosts (`packages/node/src/node.ts`, `apps/cli/src/cli/commands/buyer/start.ts`, `packages/web-sdk/src/client.ts`), not here.

## Traps

- Typecheck does not catch Node-only APIs (hoisted `@types/node`). The browser build is where it breaks.
- Node's tests import this package from `dist/`. Run `pnpm --filter @antseed/buyer-core build` first, or they test the old code.
- Stale comments: `buyer-payment-manager.ts` says "bytes/4 estimate" (it is tokenx), and `ProxyMuxUploadLimits` says the upload threshold is 512 KiB (it is 240 KiB).
- The nonce cursor and lock in `base-evm-client.ts` are module state. Per-client cursors once let two clients of one wallet pick the same nonce. Keep one copy of this package per process.
- Base can leave a low-tip transaction unmined; `base-evm-client.ts` resends it on its nonce with a higher tip. An RPC timeout while waiting for a receipt once crashed the seller; waits catch it.
- Top-ups for one seller run one at a time (`runQueued`) and read the deposit first. Concurrent paid requests on one channel once stalled on catch-up.
- After any await on a chain read, recheck that the live channel is still the one you read (`getActiveSession(peerId)?.sessionId`). A reserve replay the deposits cannot fund is retired as `ghost` and answered 402 instead of reverting.
- `keccak.ts` returns the pure-JS hash until WASM compiles; never make a digest depend on which ran. A new buyer-only response header goes in `BUYER_ONLY_RESPONSE_HEADERS`, or a seller can set it.

**Ask first:** what or how much the buyer signs or reserves, including defaults; a widened structural interface; a new dependency.

**Prove it:** the payment tests live in `packages/node/tests`, so run node's and web-sdk's tests too. `pnpm --filter @antseed/buyer-core test`, `typecheck` and `build`, then `pnpm --filter @antseed/node test` and `pnpm --filter @antseed/web-sdk test`.
