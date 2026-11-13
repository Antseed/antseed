# @antseed/ants

The ANTS staking dashboard and the service layer behind it. Published to npm. Three parts: the service (`src/service/`, Node, exported as `@antseed/ants/service`), a Fastify server (`src/server.ts`) that serves it as `/api/*` plus the built web app, and the React 18 web app (`web/src/`). Stakers and sellers reach it through `antseed ants`, the desktop's staking window and the gateway console (embedded). Every transaction is signed by the user's wallet in the browser; the server holds no key for writes.

## Inside

- `src/index.ts` — library entry; never starts a server. `src/bin.ts` — standalone entry.
- `src/routes.ts` — every `/api/*` route; writes go through the `action()` helper. `src/api-types.ts` is the API contract the web app imports by relative path.
- `src/service/` — one module per area over `AntsContext` (`context.ts`); lists and history come from the indexer (`indexer.ts`).
- `web/src/` — `App.tsx` (standalone), `embed.tsx` and `host.ts` (the console's entry and host contract), `pages.ts` (every page).
- Where to add: a read is a service function, a route with its type in `api-types.ts`, then a hook in `web/src`. A write is a service function registered with `action()`; the CLI's `commands/ants/` usually calls the same function. A page goes in `pages.ts`, so standalone and embedded both get it.
- Wallet testing: `MANUAL-WALLET-TESTING.md`. Read batching: `RPC-PERFORMANCE.md`.

| Rule | Enforced by |
| --- | --- |
| The server never signs a write. `browserWallet` defaults to true; off only in local test harnesses. | `src/browser-signer.test.ts`, `src/server.test.ts` |
| Every `/api/*` call carries the session's bearer token; other origins are refused by CORS. | `src/server.test.ts` |
| Lists and history come from the indexer, never from scanning RPC logs. New on-chain reads batch through Multicall. | review only (`indexer.ts`, `RPC-PERFORMANCE.md`); `packages/node/src/payments/evm/seller-pools-batching.test.ts` |
| Indexer reward candidates are hints: a position the chain says another wallet owns is skipped, not a reason to fail the claim or restake. | `src/service/rewards.test.ts` (restake) |
| Yield is shown as simple APR. | `web/src/pool-yield.test.ts` |

## Connections

- Depends on `@antseed/node` for chain config, identity and every contract client; an ABI change lands in node's clients and is used here.
- Imported by the CLI (`commands/ants/*`, seller and buyer commands, the gateway's staking handlers) and the desktop main process (a runtime `dependency`, packed in the asar). The CLI pins it exactly, so a release needs a CLI bump.
- The gateway console compiles `web/src` through the vite alias `@antseed/ants-web`. A `web/src` change changes the console bundle: say so in the PR so the release bumps `@antseed/gateway-console` too. `scripts/npm-publish-plan.mjs` cannot see this.

## Traps

- The console runs one server per member per workspace. State in module globals leaks across members; keep it on the server instance or keyed by `stateKey`.
- `build:server` alone ships a dashboard with no page: `dist/ants-web` must exist for the standalone page and the desktop window.
- Vitest runs `web/src` tests with no DOM. Test logic in plain modules (`pool-yield.ts`), not by rendering.
- Embedded, dialogs mount in the host's scoped root (`portalTarget`) and the host owns wallet providers. A page with its own wagmi provider or portals to `document.body` breaks in the console.
- React 18 here, React 19 types at the root: `vite.config.ts` dedupes React. Do not add a second copy.
- Coalesced reads are cleared before and after each action step. A new cache layer must be invalidated the same way, or a refresh shows the old state.

**Ask first:** the bearer-token or CORS checks, anything that would let the server sign; a change to `api-types.ts` that removes or renames a field (the CLI, desktop and console read it); `embed.tsx` or `host.ts` (the console depends on them).

**Prove it:** `pnpm --filter @antseed/ants test` and `pnpm --filter @antseed/ants typecheck` (server and web). After a `web/src` change, also `typecheck` and `test` in `@antseed/gateway-console`. Wallet flows by hand: `MANUAL-WALLET-TESTING.md`.
