# @antseed/node

Owns the node: P2P connections and identity, discovery, metering, seller request handling, sqlite storage. Buyer payment logic lives in `@antseed/buyer-core`, and `src/payments/*` re-exports it.

## Boundaries

- Depends on `@antseed/protocol`, `@antseed/buyer-core`, `@antseed/api-adapter`. Plugins and apps depend on it, never the reverse.
- Provider and router plugins implement `AntseedProviderPlugin` and `AntseedRouterPlugin` from `src/interfaces/plugin.ts`.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| Identity keys are never logged, printed, sent to a peer, or written outside the identity store. | `tests/identity.test.ts` (persistence only) |
| Schema changes are new numbered migrations in `src/storage/migrations/<domain>/`. A shipped migration is never edited. | review only; use the `add-migration` skill |
| Settle-on-disconnect charges exactly the delivered work. | sandbox `payment-flow` |

## Ask first

- Changes to `src/p2p/identity.ts`, `identity-envelope.ts` or `secure-channel.ts`.
- A new migration, and any change to the plugin interfaces.

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/node test` and `typecheck` always run.
