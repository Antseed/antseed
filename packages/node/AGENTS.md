# @antseed/node

The runtime around buyer-core and the plugins: P2P transport and identity, discovery, metering, seller request handling and sqlite. It is the plugin host. `src/interfaces/plugin.ts` and `seller-provider.ts` define what a plugin implements, including `serviceApiProtocols`, and the node does everything else. `seller-request-handler.ts` picks a protocol for billing only and never translates; the buyer proxy (`apps/cli/src/proxy/buyer-proxy.ts`) does that. `src/payments/` re-exports the buyer's payment code from buyer-core; the seller side (`seller-payment-manager.ts`), the sqlite channel store (`channel-store.ts`) and the chain config are node's own.

| Rule | Enforced by |
| --- | --- |
| A schema change is a new numbered migration in `src/storage/migrations/<domain>/`. A shipped one is never edited. | review only; `add-migration` skill |
| Settle-on-disconnect closes at the latest amount the buyer signed. | `tests/payment-flow-integration.test.ts` (that it settles, not the amount) |
| A request the seller bills reaches its provider only if it names one service, the one billed, and the seller sets `x-antseed-service` to it. | `tests/requested-service.test.ts`, `tests/seller-billed-service.test.ts`, `e2e/tests/seller-serves-billed-service.test.ts` |

Buyer requests may name one service with `service` and/or `model`, not a separate upstream model selection. The seller refuses top-level `models`, `route`, `fallbacks`, `default_fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`, `mock_testing_fallbacks`, `model_list`, `model_group` and `deployment_id`, including case, padding and bracketed variants, before payment. It refuses rather than silently dropping them: a buyer asking for different routing should see that this seller does not accept it. Nested tool/metadata fields and provider preferences that keep the same model are not model selectors. Seller-configured aliases and fallback upstreams remain the seller's responsibility; they must serve the advertised service.

**Ask first:** `src/p2p/identity.ts`, `identity-envelope.ts`, `secure-channel.ts`; a new migration; the plugin interfaces (every plugin implements them).
