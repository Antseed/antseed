# plugins

This folder holds one plugin per upstream API. Each is a provider plugin (`AntseedProviderPlugin`) or a router plugin (`AntseedRouterPlugin`), both in `packages/node/src/interfaces/plugin.ts`. That file also defines `verifier` and `prover` plugins, which live in `packages/antseed-verifier`, not here. A routing service sold to buyers is a provider plugin, so `provider-irp-router` is not a router plugin. A provider plugin declares each service's protocol in `serviceApiProtocols` and owns only its upstream connection (auth, base URL, model rewrite, throttling). HTTP relays usually build on `BaseProvider` from `@antseed/provider-core`. The node does discovery, transport, metering and payment. Router plugins (`router-local`) build on `@antseed/router-core`. Templates: `docs/protocol/templates/`. First-party plugins are listed in `apps/cli/src/plugins/registry.ts`. A plugin must add value (TEE, skills, agents, fine-tunes, a managed product), not resell access.

Every plugin is a published npm package (`@antseed/<dir>`), Node only, ES modules, built with `tsc`. `src/index.ts` default-exports the plugin object; vitest tests sit next to it. Config keys and pricing units are in each plugin's README.

| Plugin (registry name) | Protocol id | Serves |
| --- | --- | --- |
| `provider-openai` (`openai`) | `openai-chat-completions`, `openai-images`, `openai-audio-speech` | OpenAI-compatible upstreams (OpenAI, Together, OpenRouter, Venice), with fallback upstreams |
| `provider-anthropic` (`anthropic`) | `anthropic-messages` | Anthropic Messages with an API key |
| `provider-local-llm` (`local-llm`) | `openai-chat-completions` | Ollama, llama.cpp or any local OpenAI-compatible server |
| `provider-typesafe` (`typesafe`) | `typesafe-systemone` | System One decision models. Not a chat API |
| `provider-fal-image` (`fal-image`) | `openai-images` | fal.ai image endpoints behind the OpenAI Images API |
| `provider-fal-video` (`fal-video`) | `fal-video` | fal.ai video endpoints through fal's queue API |
| `provider-venice-video` (`venice-video`) | `venice-video` | Venice's native video queue |
| `provider-alibaba-video` (`alibaba-video`) | `fal-video` | Alibaba Model Studio video (Wan, HappyHorse) |
| `provider-irp-router` (`irp-router`) | `irp-suggest` | Any upstream IRP router, as one routing service |
| `provider-free-model-router` (`free-model-router`) | `irp-suggest` | An in-process router that ranks free candidates |
| `provider-claude-code` (`claude-code`) | `anthropic-messages` | Anthropic via the local Claude Code keychain login. Testing only |
| `provider-claude-oauth` (`claude-oauth`) | `anthropic-messages` | Anthropic via a Claude OAuth token. Testing only |
| `provider-openai-responses` (`openai-responses`) | `openai-responses` | Responses via the Codex login (`~/.codex/auth.json`). Testing only |
| `router-local` (`local`, router) | none | The buyer's default router: reputation, price caps, failure cooldown |

| Rule | Enforced by |
| --- | --- |
| The relay keeps the upstream's standard. It may swap auth, rewrite the model id, strip Antseed headers and set the standard's own usage field. Anything else is declared in the relay config: `injectJsonFields`, or `omitJsonFields` and `defaultHeaders` for what the upstream's standard rejects or requires. | `packages/provider-core/src/http-relay.test.ts` |
| A protocol id is one of `WELL_KNOWN_SERVICE_API_PROTOCOLS` (`packages/protocol/src/service-api.ts`). The list is append-only: billing metadata encodes a protocol by its position. | `packages/protocol/src/billing.test.ts` |
| Upstreams sharing a provider name offer a shared service on the same terms. A native video service has one upstream per name. The seller refuses to start otherwise. | `packages/node/tests/seller-self-health-error.test.ts` (`assertSameNameUpstreamsAgree`) |
| A media request that would cost the upstream more than its billed price is refused in `checkRequest`, before payment and without calling the upstream. | each video plugin's `index.test.ts` ("before payment") |
| The seller key never goes to a result URL (fal media, Model Studio signed URLs, Venice download URLs). Only fal's media CDN is fetched for fal images. | `provider-fal-image`, `provider-fal-video`, `provider-alibaba-video` tests ("without the seller key") |
| Image and video services are never probed with a paid request. Their health comes from free calls in `checkServiceHealth` and `checkUpstreamAccount`. | `provider-fal-video` and `provider-venice-video` tests (`checkServiceHealth and checkUpstreamAccount`) |

## Add a plugin end to end

1. Copy `docs/protocol/templates/provider-plugin` (or `router-plugin`) to `plugins/<name>/` and match an existing plugin's `package.json` (scripts, `workspace:*` core, peer `@antseed/node`).
2. Use an existing protocol id. A new one is Ask first and goes at the end of its list.
3. List every key the plugin reads in `configSchema`, including the unit-billing and fallback-upstream keys when supported.
4. Register it in `TRUSTED_PROVIDER_PLUGINS` (`registry.ts`). Add its env prefix to `PROVIDER_ENV_PREFIXES` (`seller/start.ts`), a hint to `getSellerSetupCredentialHint` (`seller/setup.ts`), and a one-service plugin to `SINGLE_SERVICE_PLUGINS` (`apps/cli/src/seller-monitor/settings.ts`).
5. Add it to the root `package.json` `clean` and `clean:all` scripts.
6. Docs: its `README.md`, the plugin table in `apps/website/docs/provide/config.md` (and `media.md` for media), the plugin lists in the root `README.md`, `docs/protocol/README.md` and `.agents/skills/publish/SKILL.md`, and a `CHANGELOG.md` entry.
7. Say in the PR description that the plugin is new, so the release publishes it. Until then `antseed plugin add` cannot install it.

## Connections

- Build tier 2 (`pnpm run build:tier2`), after node, provider-core and router-core. The media plugins also use `@antseed/api-adapter`; the two IRP plugins import only `@antseed/node`.
- Sellers never run this folder: `apps/cli/src/plugins/loader.ts` imports from `~/.antseed/plugins`, installed from npm, so a fix reaches sellers only after a publish. `apps/cli/src/plugins/drift.ts` refreshes plugins whose pinned core no longer matches the CLI's.
- `seller/start.ts` turns `seller.providers.<name>` into `ANTSEED_*` and `<PREFIX>_*` keys; `buildPluginConfig` (`loader.ts`) passes env keys only if `configSchema` lists them.
- TEE sellers may run only the plugins in `packages/antseed-verifier/src/tee-provider-plugins.json`; `deploy/tee-seller/update-lock.mjs` pins their versions. The desktop installs `router-local` by default (`ensureDefaultPlugin` in `apps/desktop/src/main/main.ts`).
- e2e imports some plugin sources directly, and the testbench needs `provider-openai` and `router-local` built.

## Plugin traps

- All: a plugin missing from `PROVIDER_ENV_PREFIXES` gets `baseUrl` and `apiKeyEnv` as `OPENAI_*`, which only `provider-openai` reads. An env key not in `configSchema` never arrives.
- All: the `version` in the plugin object is not the package version; `package.json` is.
- All: the plugin lists (root `clean` scripts, publish skill, docs table) drift. Fix the list you touch.
- All: a dev CLI build refreshes the shared `~/.antseed/plugins`. Test with an isolated `HOME`.
- `claude-code`, `claude-oauth`, `openai-responses`: they resell a personal subscription. Never document or configure them for production; keep "testing only" in the registry.
- `provider-openai`: `OPENAI_PATH_REWRITE_JSON` matches whole paths, not prefixes. A service is classified by its alias target, so keep classifying after the rewrite.
- `provider-openai`: on OpenRouter, image and speech services are not announced.
- `provider-openai` / `provider-venice-video`: Venice text and images use `https://api.venice.ai/api`; Venice video uses no `/api`.
- `provider-anthropic`: no base URL key; the upstream is hard-coded.
- `provider-local-llm`: its default concurrency of 1 applies only outside the CLI; `seller start` always passes `seller.maxConcurrentBuyers`.
- `provider-typesafe`: default prices are input-only (0.05 per million in, 0 out).
- `provider-fal-image` / `provider-fal-video`: the balance check needs the key's `billing:usage:read`; without it the seller keeps advertising after credits run out.
- `provider-fal-video`: fal reports a refused job as `COMPLETED` and answers its result with a 4xx. Only 408, 429 and 5xx are temporary.
- `provider-fal-video`: status and result URLs use only `owner/alias` (`falAppId`), not the endpoint's sub-path.
- `provider-venice-video`: a private model's video exists only behind the create's `download_url`, saved under `ANTSEED_DATA_DIR`. Losing that file loses the video.
- `provider-venice-video`: refusal reasons can describe the buyer's prompt; log them only when `isContentFreeLogging()` is false.
- `provider-alibaba-video`: it announces `fal-video`; don't add an Alibaba protocol id. Keys belong to one region, and an out-of-credit account shows only as a rejected create.
- `provider-irp-router`: the price comes from `IRP_ROUTER_PRICE_USD` (env only), not `unitBillingModels`. IRP paths name no service, so one instance offers exactly one.
- `provider-free-model-router`: the score API is third-party; ranking must keep working when it is down. A `VARIANT_SUFFIX` change can merge distinct models.
- `provider-claude-code`: reads no per-service pricing or alias map.
- `provider-claude-oauth`: one process per credential file; `CredentialStore` takes no lock. The README's "How to Create a Plugin" walkthrough is stale.
- `provider-openai-responses`: the auth file is the Codex CLI's own, so a refresh rotates Codex's login too. Keep `max_output_tokens` off the strip list.
- `provider-openai-responses`: proxies drop the underscored `session_id` header, so it is rebuilt from `prompt_cache_key`.
- `router-local`: `parseMaxPricingJson` drops a cached-input cap. `TOOL_HINTS` is a module export, not on the plugin object, so `buyer start` prints generic hints.

**Ask first:** a new protocol id; a change to the plugin interfaces; a plugin that needs a field inside a standard's body; adding a plugin to `tee-provider-plugins.json`; anything that makes a testing-only plugin look production-ready; a passthrough or translated field that changes the upstream's price; sending a seller key or upstream URL anywhere new; a new `router-local` policy filter.

**Prove it:** `pnpm --filter @antseed/<plugin> test` and `typecheck`. A registry or env-mapping change also runs `pnpm --filter @antseed/cli test`. A plugin that e2e imports also runs the matching e2e file (`cd e2e && npx vitest run tests/<file>`), never in parallel with other package tests.

**Maintainers:** CI publishes every `plugins/*` package whose version is not on npm yet (`.github/workflows/npm-publish.yml`, plan in `scripts/npm-publish-plan.mjs`) after a version-bump PR (`publish` skill).
