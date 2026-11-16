# @antseed/gateway-console

The web app the gateway serves at `/console/`: sign-in, workspaces, members, keys, routing policy, chat, logs, the workspace wallet, staking and the seller pages. Browser only, React 18, built with Vite. Published to npm only so the CLI can serve it (`index.js` exports `consoleDistDir`). All data comes from the console API in `apps/cli/src/gateway/console-api/` (see `apps/cli/src/gateway/AGENTS.md`). The UI is neutral and monochrome with one `<Button variant="brand">` main action per page; chat may use semantic labels. The workspace's buyer key stays in the gateway (no console route returns it); the member's connected wallet is a separate account. Card checkout and crypto deposits both stay available.

## Inside

- `src/app/App.tsx` — page loaders and shell. `src/lib/nav.ts` — `PageId` and `NAV_ITEMS` (who sees each page).
- `src/api/client.ts` — the one typed client. `src/lib/queries.ts` and `lib/mutations.ts` — React Query reads and writes.
- `src/wallet/` — wallet sign-in, deposits, funding, operator, statements. `src/staking/StakingDashboard.tsx` embeds the ants dashboard. `src/chat/` is the only folder with Tailwind.
- `src/mock/` — the fake API for `VITE_MOCK=1` (`dev` with it needs no gateway); use it for screenshots.
- Where to add a page: a `PageId` and `NAV_ITEMS` entry, a loader in `App.tsx`, the page in `src/pages/`, its route and types in the CLI's console API, and a mock handler in `src/mock/server.ts`.

| Rule | Enforced by |
| --- | --- |
| Every mutating request carries `x-antseed-console: 1`. The string is `CSRF_HEADER` in `src/api/client.ts` and `CONSOLE_CSRF_HEADER` in the CLI's `console-api/types.ts`; the mock checks a literal. Change all three together. | CLI `console-api/server.ts` rejects without it; `src/api/client.test.ts` |
| API types come only from `apps/cli/src/gateway/console-api/types.ts`, never redeclared here. | `tsconfig.json` `include`; `typecheck` |
| Imports from `@antseed/node` use browser-safe subpaths only. The root entry pulls Node-only modules into the bundle. | review only |
| Staking transactions are signed by the member's wallet in the browser. The gateway never signs for staking. | `apps/cli/src/gateway/console-api/handlers/staking.test.ts` (`browserWallet: true`) |
| A dialog with a form inside another form is portaled to `document.body`, and its form submits through `submitOnly` (`lib/forms.ts`). | `src/lib/forms.test.ts` (the helper only) |
| One React, wagmi, viem, RainbowKit and React Query copy, shared with the embedded staking pages, so there is one wallet connection. | `vite.config.ts` `resolve.dedupe` |

## Connections

- The CLI depends on it, pinned exactly, so a console release needs a CLI release; the desktop gets it through the bundled CLI.
- `@antseed/ants-web` is an alias to `apps/ants/web/src`, not a package. A change there changes this bundle: say so in the PR so the release bumps this package with `@antseed/ants`. `scripts/npm-publish-plan.mjs` does not see the alias.
- Compiles CLI source (`console-api/types.ts`, `routing-policy/policy.ts`, and `seller-monitor/card` in the mock). A CLI refactor of those files breaks this build.
- `apps/website/docs/gateway/*` describe these pages, and several components link to antseed.com/docs URLs. Change the doc and its slug together.

## Traps

- `@antseed/ui` Modal renders in place. Inside a `<form>` that nests forms, and a submit in the dialog submits the outer form. Portal it and use `submitOnly`.
- The workspace hoists React 19 types; `tsconfig.json` maps `react` to the local React 18 `@types`. Do not remove the mapping.
- Vitest runs with no DOM. Put logic in `src/lib` and test it there.
- Older gateways send fewer fields. Code that reads a newer field handles its absence.
- Roles gate pages (`NAV_ITEMS.access`), but the console API enforces access. Hiding a button is not access control.
- A routing-policy write invalidates every group in `POLICY_GROUPS`; a new view that depends on policy joins that list.
- Sensitive actions answer 403 `reauth_required`; `withReauth` (`lib/reauth.ts`) asks for a fresh sign-in and retries once.
- Gateway keys inherit the workspace and org routing policy. Never add a key-level policy by default.

**Ask first:** sign-in, session or CSRF handling (`pages/Auth.tsx`, `lib/reauth.ts`, `api/client.ts`); anything that signs or sends a wallet transaction (`src/wallet/`); removing a page or changing who can see it; `StakingDashboard.tsx`'s host contract.

**Prove it:** `pnpm --filter @antseed/gateway-console test` and `typecheck`. After a console API change also `pnpm --filter @antseed/cli test` and `node scripts/gateway-console-smoke.mjs` (needs a built CLI). UI changes: screenshots from mock mode, approved before merge.
