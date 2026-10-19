# Gateway (apps/cli/src/gateway)

Owns `antseed gateway`: API keys, members and workspaces, spend caps, x402 top-ups, and the console API that `apps/gateway-console` calls. It sits in front of a buyer process and forwards to it.

## Boundaries

- Talks to the buyer over `127.0.0.1` only. Money formatting lives in `money.ts`, limits in `limits.ts`, storage in `store.ts`.
- Its sqlite schema is the append-only list in `store-migrations.ts`, separate from `packages/node`'s migrations.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| Listens on `127.0.0.1` unless the operator passes `--host`. `exposure.ts` reports what a wider listen exposes. | `exposure.test.ts` |
| A request never spends past its key, member or workspace cap. | `gateway.test.ts` (caps, in-flight holds, 402 once a cap is reached) |
| Amounts are integer USDC base units, parsed and formatted only in `money.ts`. They are `number` here, not `bigint` as in buyer-core. | `Number.isSafeInteger` checks in `money.ts` |
| A shipped migration in `store-migrations.ts` is never edited. | review only |

## Ask first

- Auth, keys, caps, x402, or the listen and exposure defaults.
- Whether gateway money moves to `bigint` (open: it differs from buyer-core).

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/cli test` and `typecheck` always run.
