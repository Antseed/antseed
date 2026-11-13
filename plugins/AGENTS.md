# plugins

This folder holds one plugin per upstream API. Each is a provider plugin (`AntseedProviderPlugin`) or a router plugin (`AntseedRouterPlugin`), both in `packages/node/src/interfaces/plugin.ts`. That file also defines `verifier` and `prover` plugins, which live in `packages/antseed-verifier`, not here. A routing service sold to buyers is a provider plugin, so `provider-irp-router` is not a router plugin. A provider plugin declares each service's protocol in `serviceApiProtocols` and owns only its upstream connection (auth, base URL, model rewrite, throttling). HTTP relays usually build on `BaseProvider` from `@antseed/provider-core`. The node does discovery, transport, metering and payment. Router plugins (`router-local`) build on `@antseed/router-core`. Templates: `docs/protocol/templates/`. First-party plugins are listed in `apps/cli/src/plugins/registry.ts`. A plugin must add value (TEE, skills, agents, fine-tunes, a managed product), not resell access.

| Rule | Enforced by |
| --- | --- |
| The relay keeps the upstream's standard. It may swap auth, rewrite the model id, strip Antseed headers and set the standard's own usage field. Anything else is a declared `injectJsonFields`. | `packages/provider-core/src/http-relay.test.ts` |

**Ask first:** a new protocol id; a change to the plugin interfaces; a plugin that needs a field inside a standard's body.
