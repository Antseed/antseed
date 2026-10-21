# Gateway (apps/cli/src/gateway)

A host for teams: API keys, members, workspaces, spend caps, x402 top-ups and the console API behind `apps/gateway-console`. It runs the CLI buyer as a child (`buyer-process.ts`), forwards requests to it and reads it through `/_antseed/*` (`buyer-control.ts`). A feature here exists for every workspace, member and key, and for both local and exposed listens. Layers: `console-api/handlers` and `services/`, storage in `store.ts` with append-only `store-migrations.ts`, money in `money.ts`, limits in `limits.ts`.

| Rule | Enforced by |
| --- | --- |
| Listens on `127.0.0.1` unless `--host`; `exposure.ts` reports what a wider listen exposes. | `exposure.test.ts` |
| No request spends past its key, member or workspace cap. | `gateway.test.ts` |
| A shipped migration is never edited. | review only |

**Ask first:** auth, keys, caps, x402, listen and exposure defaults.
