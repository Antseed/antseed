# @antseed/telemetry

The privacy boundary the desktop app, the gateway and the buyer share. A host reports only its own UI (the desktop's screens, the gateway's setup funnel); all usage comes from the buyer, whichever host (desktop, gateway, `antseed buyer start`) runs it. It holds buckets, failure classifiers, a strict allowlist sanitizer, consent resolution and a bounded PostHog transport. Each product keeps its own event catalog (names and allowed properties). This package only enforces the rules. The public doc is `docs/telemetry.md`. Change it with every event or field.

| Rule | Enforced by |
| --- | --- |
| Values are enums, buckets, booleans or bounded integers, plus fields a catalog pins to a pattern (the buyer's `seller_id`, the public peer id of a seller a request was sent to, and the random `request_id`). The buyer's exact `input_tokens`, `cached_input_tokens` and `output_tokens`, its exact timings (`ttft_ms`, `seller_ttft_ms`, `duration_ms`, `failed_attempts_ms`; percentiles are computed in PostHog, never sent), and `estimated_cost_micro_usd` (a listed-price estimate, never a settled amount) are bounded integers. Raw errors, prompts, other peer IDs, exact amounts, paths and arguments never leave the device. | `sanitize.test.ts` |
| `DO_NOT_TRACK` and `ANTSEED_TELEMETRY=0` always win; CI and source builds without a baked project send nothing. | `consent.test.ts` |
| Telemetry never throws, never blocks a request, and a shutdown flush is bounded. | `client.test.ts` |

**Ask first:** adding an identifier of any kind (peer, key, member, workspace, end user), or any new data category.
