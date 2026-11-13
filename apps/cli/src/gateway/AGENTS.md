# Gateway (apps/cli/src/gateway)

A host for teams: API keys, members, workspaces, spend caps, x402 top-ups and the console API behind `apps/gateway-console`. It runs the CLI buyer as a child (`buyer-process.ts`), forwards requests to it and reads it through `/_antseed/*` (`buyer-control.ts`). A feature here exists for every workspace, member and key, and for both local and exposed listens. Layers: `console-api/handlers` and `services/`, storage in `store.ts` with append-only `store-migrations.ts`, money in `money.ts`, limits in `limits.ts`.

Started by `antseed gateway start`, `antseed tunnel start` (which the desktop's public endpoint uses) and `antseed gateway service install`. Part of the published `@antseed/cli`; Node only.

## Inside

- `runtime.ts` — `startGatewayRuntime`, the entry both commands call.
- `server.ts` — the API front door. `ALLOWED_ROUTES` lists every forwarded path and whether it is paid; anything else is 404.
- `policy-resolver.ts` — the effective routing policy, level by level. `accounting.ts` and `video-jobs.ts` — admission holds and the ledger. `spend-feed.ts` — the buyer's spend feed, which gates capped keys.
- A console route is a `register…Routes` in `console-api/handlers/<area>.ts` (listed in `handlers/index.ts` or `console.ts`), its logic in `services/<area>.ts`, its types in `console-api/types.ts`. Services validate and audit; they never check who calls (`console-api/access.ts` does).
- A schema change is a new string at the end of `MIGRATIONS` in `store-migrations.ts`. A new paid API path goes in `ALLOWED_ROUTES` and in the buyer proxy's known paths.

| Rule | Enforced by |
| --- | --- |
| Listens on `127.0.0.1` unless `--host`; `exposure.ts` reports what a wider listen exposes. | `exposure.test.ts` |
| No request spends past its key, member or workspace cap. | `gateway.test.ts` |
| A shipped migration is never edited. | review only |
| Admission counts settled spend plus holds of requests in flight, in UTC calendar periods. A key's cap is the lower of the admins' and the owner's. | `gateway.test.ts` |
| A capped key fails closed while the buyer is not reporting spend or video commitments cannot be stored. | `gateway.test.ts` |
| Policies only narrow from the gateway default down to the preset; peer lists are references. | `policy-resolver.test.ts` |
| Key secrets are stored as SHA-256 only; the secret is shown once. The gateway directory is 0700 and its database files 0600. | `store-data.test.ts` (modes); review (hashing) |
| Concurrent processes opening an old database migrate it exactly once. | `store-data.test.ts` |
| Client credentials, `x-forwarded-*` and browser context headers are never forwarded to the buyer. | `gateway.test.ts` (credentials, verifier headers); review for the rest |
| Read-scope management tokens only read; key sessions reach only routes that allow `key`. | `console-api/server.test.ts` (read-only tokens); review |
| Statements are records of purchases, not invoices. | review only |

## Connections

- `apps/gateway-console` imports `console-api/types.ts` directly: a type change here needs its typecheck. The console ships inside `@antseed/gateway-console`, so a console change needs a gateway-console bump and a CLI bump.
- The gateway reads the buyer only through `/_antseed/*`; changing one of those routes in `proxy/buyer-proxy.ts` changes the gateway. The policy and control headers and the secret file name live in `../routing-policy/policy.ts`, shared with the buyer.
- Docs: `apps/website/docs/gateway/*.md` (troubleshooting lists the gateway's error codes).

## Traps

- Never add a key-level routing policy unless asked. Keys inherit the levels above; a key policy keeps narrowing after an admin widens a level above it.
- The control secret is shared through the data dir. A gateway and a buyer on different data dirs (or with `ANTSEED_GATEWAY_CONTROL_SECRET` set on one side only) leave the spend feed `unauthorized`, and every capped key is refused.
- `auth/db.ts` says v1 "has not shipped yet". It has. Treat auth migrations as append-only like `store-migrations.ts`.
- Video jobs are charged on delivery, so caps hold a commitment from create to delivery, stored before the create is sent. Read the `fix(gateway)` video commits before touching it.
- systemd expands `$` in `ExecStart` but not in `Environment=`, so only `ExecStart` words escape it (`service.ts`).
- Statements match settlements to peers by payment channel, not seller address (a delegated seller is paid at its seller contract). An issued month never changes.
- Workspace wallets come from the running buyer (`services/wallet-address.ts`), not the store. Passkeys are bound to the console's domain; after moving it, members need a recovery link.
- Money here is `number` in USDC base units with safe-integer checks (`money.ts`), unlike the repo's `bigint`. Parse input with `parseUsdToUsdc`, never `parseFloat`.

**Ask first:** auth, keys, caps, x402, listen and exposure defaults; the policy levels or their order; a field removed from `console-api/types.ts`; a new migration.

**Prove it:** `pnpm --filter @antseed/cli test` (includes every gateway test) and `pnpm --filter @antseed/gateway-console typecheck` after a `console-api/types.ts` change. One file: `pnpm --filter @antseed/cli build && node --test apps/cli/dist/gateway/<file>.test.js`.
