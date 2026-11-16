# @antseed/network-stats

A standalone Node service that watches the network as an anonymous buyer and serves `GET /stats` and `GET /health`. It discovers sellers over the DHT and, when the chain has a stats contract, indexes its `MetadataRecorded` events into sqlite and adds per-seller and network on-chain totals to `/stats`. Published to npm (`@antseed/node` is a peer dependency). `README.md` describes an old response shape; trust `src/server.ts`.

## Inside

- `src/index.ts` — entry and env; turns the indexer on only when the chain config has a stats contract and deploy block.
- `src/poller.ts` — DHT snapshot; it observes every metadata version, it does not buy.
- `src/indexer.ts` and `src/store.ts` — event indexing into sqlite, with a reorg-safety lag.
- `src/server.ts` — the `/stats` shape. Tests sit beside the code and run from `dist/`.

| Rule | Enforced by |
| --- | --- |
| A failed tick leaves the checkpoint where it was; a batch and its checkpoint commit together or not at all. | `src/indexer.test.ts`, `src/store.test.ts` |
| Totals are BigInt-safe and returned as decimal strings. | `src/store.test.ts`, `src/server.test.ts` |
| A contract-backed seller's stats are looked up by its `sellerContract`, not the operator's peer id. | `src/server.test.ts` |
| An RPC failure resolving an agent id is not cached; the next request retries. | `src/server.test.ts` |
| Without a stats contract, `/stats` keeps the old snapshot shape. | `src/server.test.ts` (legacy path) |

## Connections

- The stats contract address and deploy block come from `packages/node/src/payments/chain-config.ts`, which also names this service's URL as `networkStatsUrl`.
- The desktop reads `/stats` as a fallback after the explorer API (`apps/desktop/src/main/runtime/fetch-network-stats.ts`). A field removed from `/stats` breaks older desktops.
- `apps/relay/src/seller-cache.ts` runs the same discovery flow. Not in any root `build:tier*` script; `test` and `npm-publish.yml` build it.

## Traps

- `tsconfig.json` compiles tests too and `files: ["dist"]` publishes them. Test-only imports end up in the package.
- Every table is `CREATE TABLE IF NOT EXISTS`, with no migrations. A new column or index never reaches an existing database: add a migration step.
- There is no `typecheck` script, so root `pnpm typecheck` skips this package. `test` runs `tsc` and is the type check.
- Until the first poll ends, `/stats` serves the last run's cached snapshot, or no peers on a fresh disk. `/health` answers `ok` regardless.

**Ask first:** removing or renaming a `/stats` field; the store schema; the reorg-safety depth.

**Prove it:** `pnpm --filter @antseed/network-stats test` (builds, then runs `node --test dist/*.test.js`). It needs `@antseed/node` built first.
