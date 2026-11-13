# @antseed/telemetry

The privacy boundary for the CLI process (buyer and gateway). The desktop does not import this package; its copy is `apps/desktop/src/main/telemetry/`, so a rule change here does not reach it. A host reports only its own UI (the desktop's screens, the gateway's setup funnel); all usage comes from the buyer, whichever host (desktop, gateway, `antseed buyer start`) runs it. It holds buckets, failure classifiers, a strict allowlist sanitizer, consent resolution and a bounded PostHog transport. Each product keeps its own event catalog (names and allowed properties). This package only enforces the rules. The public doc is `docs/telemetry.md`. Change it with every event or field.

Published to npm. Node only, no dependencies.

## Inside

- `src/sanitize.ts` — the allowlist sanitizer and shared validators. `src/consent.ts` — `resolveConsent()` and the PostHog config.
- `src/client.ts` — the event envelope and the env names a host sets on the buyer it spawns. `src/posthog.ts` — the bounded batch queue.
- `src/failure.ts`, `src/buckets.ts` — failure reasons and value buckets.
- Tests sit beside the code and run with `node --test` from `test-dist/`, not vitest.

| Rule | Enforced by |
| --- | --- |
| Values are enums, buckets, booleans or bounded integers, plus fields a catalog pins to a pattern (the buyer's `seller_id`, the public peer id of a seller a request was sent to, and the random `request_id`). The buyer's exact `input_tokens`, `cached_input_tokens` and `output_tokens`, its exact timings (`ttft_ms`, `seller_ttft_ms`, `duration_ms`, `failed_attempts_ms`; percentiles are computed in PostHog, never sent), and `estimated_cost_micro_usd` (a listed-price estimate, never a settled amount) are bounded integers. Raw errors, prompts, other peer IDs, exact amounts, paths and arguments never leave the device. | `sanitize.test.ts` |
| `DO_NOT_TRACK` and `ANTSEED_TELEMETRY=0` always win; CI and source builds without a baked project send nothing. | `consent.test.ts` |
| Telemetry never throws, never blocks a request, and a shutdown flush is bounded. | `client.test.ts` |
| Off by default: only an explicit persisted `true` sends. | `consent.test.ts` |
| An event with no wallet address, no consent or no catalog entry is dropped before it is queued; an opt-out mid-batch drops the rest of the queue. | `client.test.ts` |
| A key that declares values or a pattern takes only strings; a key with a range takes only integers inside it. | `sanitize.test.ts` |
| Every capture disables GeoIP and person profiles. | `client.test.ts` (envelope) |

## Connections

- Used by `apps/cli` only (`src/telemetry/catalog.ts` is the buyer and gateway catalog). The CLI pins it exactly, so a bump here needs a CLI bump.
- The desktop's copy (`apps/desktop/src/main/telemetry/`) redefines the host env names in `host-env.ts` and the schema version in `events.ts`. Change them on both sides.
- PostHog values are baked at release by `scripts/bake-desktop-telemetry-config.mjs` into `apps/cli/src/generated/baked-defaults.ts` and the desktop's twin, both committed with every value null. Never commit the baked values.

## Traps

- A new property is dropped until the product's catalog allows it. Add it to the catalog and `docs/telemetry.md`, not only to the capture call.
- A rule fixed here does not fix the desktop; check `apps/desktop/src/main/telemetry/sanitize.ts` and `classify.ts`.
- `classifyFailureReason` matches the buyer proxy's real error strings by regex. Rewording an error in `apps/cli/src/proxy/` can move it; `failure.test.ts` holds the strings it relies on.
- The distinct id is only a `0x` + 40-hex address. A buyer without a loaded wallet sends nothing, which is expected.

**Ask first:** adding an identifier of any kind (peer, key, member, workspace, end user), or any new data category.

**Prove it:** `pnpm --filter @antseed/telemetry test` and `typecheck`. A change that reaches the catalog or the buyer also runs `pnpm --filter @antseed/cli test`.
