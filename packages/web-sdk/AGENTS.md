# @antseed/web-sdk

The browser buyer: buyer-core plus a browser environment, which is WebRTC through `apps/relay` (`connection.ts`, `signaling.ts`), a key-based identity, a channel store and a tab lock. Sellers can't tell it from any other buyer. Buyer behavior belongs in buyer-core, not here.

Published to npm for third-party web apps; no app in this repo imports it. It runs in browsers only, and its tests run it in Node with polyfills.

## Inside

- `src/index.ts` — the public surface. It re-exports all of buyer-core and protocol, so a symbol added there is public here too.
- `src/client.ts` — `AntseedWebClient` and `SellerSession` (`create()` for paid use, `ephemeral()` for tests and free sellers).
- `src/connection.ts`, `src/signaling.ts` — the WebRTC transport; `src/channel-store.ts`, `src/tab-lock.ts` — persistence.
- `browser-e2e/` (Playwright) and `examples/` (demo) are the only in-repo users.

| Rule | Enforced by |
| --- | --- |
| Runtime deps are `buyer-core`, `protocol` and `ethers` only; no native modules. | review only |
| Same implementations as the node, accepted by the node's verifier. | `src/parity.test.ts` |
| One tab writes a buyer's channels at a time. | `src/tab-lock.test.ts` |
| `create()` throws without the Web Locks API; paid use never falls back to the memory store. A second tab fails with `BuyerAlreadyActiveError` unless `persistence.waitForLock`. | `src/client.test.ts` (the second tab); review only for the missing API |
| A restart recovers the exact signed state, including an ambiguously delivered top-up. | `src/channel-store.test.ts` |
| A queued IndexedDB write failure is reported at once (`onWriteError`), and `flush()` and every later write throw. | `src/channel-store.test.ts` (report and `flush()`) |
| The private key never reaches IndexedDB or the client options kept after `create()`. | review only |
| Browser-only: Web APIs are fine; Node built-ins, `Buffer` and `process` are not. Everything is injectable for tests. | review only |

## Connections

- Pins buyer-core and protocol exactly, so a bump of either needs a bump here. Build tier 1; tests import node, buyer-core and protocol from `dist/`, so build tier 0 first.
- `apps/relay` is the other half of the transport. `src/integration.test.ts` runs the relay's source against a real node seller, so a relay change can break these tests.
- `BASE_MAINNET` in `client.ts` copies the Base addresses from `packages/node/src/payments/chain-config.ts`; a redeploy changes both. A new metadata field reaches browser routing only through `sellerSummaryFromMetadata`.

## Traps

- Browser WebRTC caps a message near 256 KiB against libdatachannel sellers, so uploads chunk at a lower threshold here (`BROWSER_UPLOAD_THRESHOLD_BYTES`). The README and the comment beside it still say 512 KiB.
- The seller caps the bytes before the first newline, so the `hello` line goes in its own WebSocket frame, never with the SDP offer.
- The relay bridge closes once the DataChannel opens; a dropped DataChannel means a fresh `connect()`.
- Two tabs signing one channel corrupt the cumulative sequence; a custom `channelStore` shared across tabs must serialize signing itself.
- A new IndexedDB object store or index needs `DATABASE_VERSION` raised and a step in `onupgradeneeded`.
- The README says ethers is the only runtime dependency, and `BuyerAlreadyActiveError`'s message says "AntSeed". Callers match its `code`.

**Ask first:** a runtime dependency; how the browser holds the key.

**Prove it:** a transport change also runs `test:browser` (Playwright). `pnpm --filter @antseed/web-sdk test` (after building tier 0) and `typecheck`.
