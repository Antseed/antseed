# @antseed/node

The runtime around buyer-core and the plugins: P2P transport and identity, discovery, metering, seller request handling and sqlite. It is the plugin host. `src/interfaces/plugin.ts` and `seller-provider.ts` define what a plugin implements, including `serviceApiProtocols`, and the node does everything else. `seller-request-handler.ts` picks a protocol for billing only and never translates; the buyer proxy (`apps/cli/src/proxy/buyer-proxy.ts`) does that. `src/payments/` re-exports the buyer's payment code from buyer-core; the seller side (`seller-payment-manager.ts`), the sqlite channel store (`channel-store.ts`) and the chain config are node's own.

| Rule | Enforced by |
| --- | --- |
| A schema change is a new numbered migration in `src/storage/migrations/<domain>/`. A shipped one is never edited. | review only; `add-migration` skill |
| Settle-on-disconnect closes at the latest amount the buyer signed. | `tests/payment-flow-integration.test.ts` (that it settles, not the amount) |

**Ask first:** `src/p2p/identity.ts`, `identity-envelope.ts`, `secure-channel.ts`; a new migration; the plugin interfaces (every plugin implements them).
