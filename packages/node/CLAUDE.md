# @antseed/node

The runtime around buyer-core and the plugins: P2P transport and identity, discovery, metering, seller request handling and sqlite. It is the plugin host. `src/interfaces/plugin.ts` and `seller-provider.ts` define what a plugin implements, including `serviceApiProtocols`, and the node does everything else. `seller-request-handler.ts` keeps the buyer's protocol when the provider supports it and translates otherwise. `src/payments/*` only re-exports buyer-core.

| Rule | Enforced by |
| --- | --- |
| A schema change is a new numbered migration in `src/storage/migrations/<domain>/`. A shipped one is never edited. | review only; `add-migration` skill |
| Settle-on-disconnect charges exactly the delivered work. | sandbox `payment-flow` |

**Ask first:** `src/p2p/identity.ts`, `identity-envelope.ts`, `secure-channel.ts`; a new migration; the plugin interfaces (every plugin implements them).
