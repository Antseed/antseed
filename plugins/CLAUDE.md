# plugins

One plugin per upstream. A provider plugin relays the upstream's own API and declares it per service in `serviceApiProtocols`. It owns only that connection (auth, base URL, model rewrite, throttling) through `@antseed/provider-core`'s `BaseProvider` and `HttpRelay`. The node does discovery, transport, metering and payment. Router plugins (`router-local`) build on `@antseed/router-core`. Templates: `docs/protocol/templates/`. First-party plugins are listed in `apps/cli/src/plugins/registry.ts`. A plugin must add value (TEE, skills, agents, fine-tunes, a managed product), not resell access.

| Rule | Enforced by |
| --- | --- |
| The relay keeps the upstream's standard. It may swap auth, rewrite the model id, strip AntSeed headers and set the standard's own usage field. Anything else is a declared `injectJsonFields`. | `packages/provider-core/src/http-relay.test.ts` |

**Ask first:** a new protocol id; a change to the plugin interfaces; a plugin that needs a field inside a standard's body.
