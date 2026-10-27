# @antseed/web-sdk

The browser buyer: buyer-core plus a browser environment, which is WebRTC through `apps/relay` (`connection.ts`, `signaling.ts`), a key-based identity, a channel store and a tab lock. Sellers can't tell it from any other buyer. Buyer behavior belongs in buyer-core, not here.

| Rule | Enforced by |
| --- | --- |
| Runtime deps are `buyer-core`, `protocol` and `ethers` only; no native modules. | review only |
| Same implementations as the node, accepted by the node's verifier. | `src/parity.test.ts` |
| One tab writes a buyer's channels at a time. | `src/tab-lock.test.ts` |

**Ask first:** a runtime dependency; how the browser holds the key.

**Prove it:** a transport change also runs `test:browser` (Playwright).
