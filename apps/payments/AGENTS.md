# @antseed/payments

The local payments portal: a Fastify server (`src/server.ts`, `src/routes.ts`) and one React 18 page (`web/src/`, the "pay page") for buyer actions that need a signature from an external wallet: deposit, withdraw, authorize an operator, claim, close a channel, share a free tier. Published to npm. The desktop starts it in its main process and the CLI starts it for the buyer, gateway and ants commands that need a wallet. Its second export, `@antseed/payments/card-link`, builds signed card-checkout links for the desktop and the gateway console. Card checkout and crypto funding both stay available.

## Inside

- `src/index.ts` — exports `createServer`; starts a server only when run as the entry.
- `src/routes.ts` — every `/api/*` route. `src/crypto-context.ts` — the buyer identity; `/api/operator/sign` is the only thing the buyer key signs here.
- `src/card-link.ts` — pure, no server imports; its link rules match the pay page's own parser.
- `web/src/App.tsx` reads `?page=pay&action=...`; `views/PayPage.tsx` renders one component per action.
- Where to add: a wallet-signed buyer action is a `PayPageAction` in `PayPage.tsx` and `PAY_ACTIONS` in `App.tsx`, its component, and any route. Views that need no external wallet belong in the desktop or the CLI.

| Rule | Enforced by |
| --- | --- |
| Every `/api/*` call except `GET /api/config` carries the session token. | review only (`src/server.ts`); `src/server.rewards.test.ts` covers the claim handoff |
| The buyer hot wallet never receives funds. Withdrawals and claims go to the operator or stay in `AntseedDeposits`. | root `AGENTS.md` invariant; `packages/contracts` tests |
| A card link is signed over exactly the bytes the pay page checks, and an amount it would reject is never signed. | `src/card-link.test.ts` |
| Emissions reads use the gate's schedule, never the legacy ABI at UsageAccounting. | `src/routes.emissions.test.ts` |
| A free-tier delegation is saved only with the staker's valid, unexpired signature, keeping the rest of the config. | `src/free-tier-delegations.test.ts` |

## Connections

- Depends on `@antseed/node`; a change to the deposits or channels EIP-712 domain or ABI there changes what this page signs.
- Imported by the desktop (a runtime dependency packed in the asar) and the CLI (wallet commands, and the console's `wallet-card-link.ts` for `card-link`). Both pin it exactly; a `@antseed/node` bump needs a republish here.

## Traps

- The desktop's `ensure:cli-dist` runs only `build:server` here, so desktop builds use whatever `dist/web` is on disk. A stale web bundle once shipped this way. Maintainers: run the full `build` and check the mtime of `dist/web/assets` before a desktop release.
- A missing `dist/web` is not an error: the server skips static files silently and the page 404s.
- Change the card link format only together with the pay page, and keep `card-link.ts` free of server imports so the gateway can load it alone.
- `typecheck` checks `src/` only and Vite does not typecheck, so a type error in `web/src` passes both; check it with `tsc --noEmit -p web/tsconfig.json`.
- The page runs in an external browser or an Electron popup (WalletConnect only). Both close themselves after a payment, and `onPaymentCompleted` tells the host to refresh.

**Ask first:** anything the buyer key signs (`/api/operator/sign`), the token and CORS checks, `card-link.ts` (it must match the deployed pay page), where withdrawals or claims send funds.

**Prove it:** `pnpm --filter @antseed/payments test` and `pnpm --filter @antseed/payments typecheck`. Maintainers: before a desktop release, `pnpm --filter @antseed/payments build` and confirm `dist/web/assets` is fresh.
