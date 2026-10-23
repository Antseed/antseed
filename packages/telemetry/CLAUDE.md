# @antseed/telemetry

The privacy boundary every AntSeed product shares: the desktop app, the CLI, the buyer it runs and the gateway. It holds buckets, failure classifiers, a strict allowlist sanitizer, consent resolution and a bounded PostHog transport. Each product keeps its own event catalog (names and allowed properties). This package only enforces the rules. The public doc is `docs/telemetry.md`. Change it with every event or field.

| Rule | Enforced by |
| --- | --- |
| Values are enums, buckets, booleans or bounded integers. Raw errors, prompts, peer IDs, exact amounts, paths and arguments never leave the device. | `sanitize.test.ts` |
| `DO_NOT_TRACK` and `ANTSEED_TELEMETRY=0` always win; CI and source builds without a baked project send nothing. | `consent.test.ts` |
| Telemetry never throws, never blocks a request, and a shutdown flush is bounded. | `posthog.test.ts` |

**Ask first:** adding an identifier of any kind (peer, key, member, workspace, end user), or anything below country level for location.
