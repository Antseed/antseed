# @antseed/provider-core

The seller's path from a plugin to its upstream: `HttpRelay`, `BaseProvider` around it, OAuth refresh, and the config parsers and video helpers plugins share. Installed plugins pin their own copy, so a fix reaches sellers only when their plugins refresh (`apps/cli/src/plugins/drift.ts`).

## Inside

- `src/http-relay.ts` — `HttpRelay`: auth swap, body and path rewrites, retries, fallback upstreams with cooldown, SSE or buffered delivery.
- `src/base-provider.ts` — `BaseProvider`, the node's `Provider` over one relay.
- `src/token-providers.ts` — static and OAuth tokens. `src/config-utils.ts` — parsers for the `ANTSEED_*_JSON` env vars the CLI writes for a plugin; a new plugin config parser goes here.
- `src/video-download.ts`, `src/fal.ts` — shared video and fal helpers.
- A new shared helper is exported from `src/index.ts`, or plugins can't import it.

| Rule | Enforced by |
| --- | --- |
| Failover happens only before anything reaches the buyer. A failed upstream is tried last during its cooldown, not skipped. | `src/http-relay.test.ts` |
| A dropped stream ends with `event: error`, then `done`. `StreamOutcome` in `packages/node` reads that frame. | `src/http-relay-timeout.test.ts` |
| Rotated OAuth credentials stay in memory after a failed save, and `getToken` throws until a save works. | `src/oauth-recovery.test.ts` |
| The relay adds `Bearer` only when `authHeaderName` is exactly `authorization`. Give it a raw key. | `src/http-relay.test.ts` (lowercase only) |
| A pin lives on the request object, so a copy of a pinned request loses it. | review only |
| `stripHeaderPrefixes` runs after auth and `extraHeaders`, so it also removes seller-set headers. | review only |
| `serviceRewriteMap` keys must be lowercase. Only `parseServiceAliasMap` normalizes them. | review only |
| The relay never follows an upstream redirect unless a plugin sets `redirect: 'follow'`. | `src/http-relay-timeout.test.ts` (307, 308) |
| Streaming chat completions get `stream_options.include_usage: true` unless the caller set it. Without usage the seller bills zero. | `src/http-relay.test.ts` |
| `injectJsonFields` never reaches `/v1/images/` or `/v1/audio/`. A buyer request error (400, 413, 422) is returned as-is and never fails over. | `src/http-relay.test.ts` |
| The idle timeout covers headers and each body read, not total stream length; a stalled body frees its capacity slot. | `src/http-relay-timeout.test.ts` |
| A config parser accepts only what the announce path accepts (`validateServiceCapabilityFields` in node). | `src/config-utils.test.ts` |
| A short stream is logged by size, model and URL, never its content. | `deploy/tee-seller/check-lock.mjs` |

## Connections

- Peer-depends on `@antseed/node`. Build tier 1. Every `plugins/provider-*` except the two routers pins it exactly, so a fix ships only when the plugins that need it are bumped and republished.
- `apps/cli/src/cli/commands/seller/start.ts` writes `ANTSEED_FALLBACK_UPSTREAMS_JSON`; `parseFallbackUpstreamsJson` reads it. Change both sides together.
- `deploy/tee-seller/check-lock.mjs` greps the installed `dist/http-relay.js` for the literal `this._config.redirect ?? 'error'` and for no `debugChunks`. Rewording that line fails the TEE image build.

## Traps

- The `include_usage` fix shipped, but sellers kept the old relay through their plugins' pin and kept billing zero. That is why `drift.ts` exists.
- `validateRequestService` reads JSON bodies only; the real gate is the node's service match in `seller-request-handler.ts`.
- A fallback's `authHeaderValue` is sent verbatim, with no `Bearer`. The 401 force-refresh runs only on the primary.
- `retryOn5xx` retries, then failover runs on the result. Retries and failover stack.
- `Expect` is stripped as hop-by-hop: curl's `Expect: 100-continue` on large bodies made Node's `fetch` fail every large request with 502.
- `BaseProvider.init` reads the relay's private `_config`; rename it in both places.
- `README.md` shows a `Bearer` token and a `serviceCategories` field that do not match the code. The code wins.

**Ask first:** `FAILOVER_STATUS_CODES` or the cooldowns; what the relay sends upstream; the OAuth save order; the `redirect` default or the logging of a stream.

**Prove it:** `pnpm --filter @antseed/provider-core test` and `typecheck`. Plugins read `dist`, so build this package, then run the tests of the plugins you touched and `apps/cli`. A change to `HttpRelay` or `BaseProvider` also runs the `verify-antseed` smoke run.
