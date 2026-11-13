# @antseed/provider-core

The seller's path from a plugin to its upstream: `HttpRelay`, `BaseProvider` around it, OAuth refresh, and the config parsers and video helpers plugins share. Installed plugins pin their own copy, so a fix reaches sellers only when their plugins refresh (`apps/cli/src/plugins/drift.ts`).

| Rule | Enforced by |
| --- | --- |
| Failover happens only before anything reaches the buyer. A failed upstream is tried last during its cooldown, not skipped. | `src/http-relay.test.ts` |
| A dropped stream ends with `event: error`, then `done`. `StreamOutcome` in `packages/node` reads that frame. | `src/http-relay-timeout.test.ts` |
| Rotated OAuth credentials stay in memory after a failed save, and `getToken` throws until a save works. | `src/oauth-recovery.test.ts` |
| The relay adds `Bearer` only when `authHeaderName` is exactly `authorization`. Give it a raw key. | `src/http-relay.test.ts` (lowercase only) |
| A pin lives on the request object, so a copy of a pinned request loses it. | review only |
| `stripHeaderPrefixes` runs after auth and `extraHeaders`, so it also removes seller-set headers. | review only |
| `serviceRewriteMap` keys must be lowercase. Only `parseServiceAliasMap` normalizes them. | review only |

**Ask first:** `FAILOVER_STATUS_CODES` or the cooldowns; what the relay sends upstream; the OAuth save order.

**Prove it:** a change to `HttpRelay` or `BaseProvider` also runs the `verify-antseed` smoke run.
