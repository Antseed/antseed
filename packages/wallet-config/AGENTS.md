# @antseed/wallet-config

Browser wallet constants and pure helpers shared by the web apps: the WalletConnect project id, the public Base RPC list, USDC amount parsing, the EIP-681 payment link, contract ABI fragments and the RainbowKit theme options. Used by gateway-console, payments, ants and the desktop renderer. Private and source-only: `exports` point at `src/*.ts` and `build` only typechecks, so only Vite-bundled browser code can import it; the CLI and the desktop main process cannot.

## Inside

- `src/index.ts` (`@antseed/wallet-config`) — constants, `usdcAmountToBaseUnits`, `buildUsdcPaymentUri`, the RainbowKit themes.
- `src/abis.ts` (`@antseed/wallet-config/abis`) — `ERC20_ABI` and `DEPOSITS_ABI` via viem.
- `src/eip681.test.ts` — the payment link and the amount parser.

| Rule | Enforced by |
| --- | --- |
| Environment-free and browser-safe: `tsconfig.json` sets `lib: ["ES2022"]` and `types: []`, so DOM globals, Node globals and `node:` imports fail to typecheck. Constants and pure functions only, no side effects. | `typecheck` |
| The root entry has no runtime dependency. viem, an optional peer, is imported only by `abis.ts`. | review only |
| USDC amounts become `bigint` base units from the digits, never through a float. | `src/eip681.test.ts` |
| Consumers list it in `devDependencies`: a private package in a published app's `dependencies` breaks `npm install` of that app, and the desktop packs every dependency into its asar. | review only |

## Connections

- No internal dependencies. Build tier 0 (typecheck only). Private, so it ships only when the apps that bundle it are bumped.
- Kept in sync by hand: `BASE_PUBLIC_RPC_URLS` with the base-mainnet RPC list in `packages/node/src/payments/chain-config.ts`; the EIP-681 link with `buildPaymentUri` in `apps/cli/src/cli/commands/buyer/deposit.ts`; the ABI strings with `packages/contracts/payments/AntseedDeposits.sol`. Change both sides in one PR.
- `ANTSEED_RAINBOWKIT_NEUTRAL` reads `--as-accent` and `--as-accent-contrast` from `@antseed/ui`.

## Traps

- The desktop does not depend on viem; desktop code imports only the root entry, never `/abis`.
- The vitest file imports `./index` without `.js`, which works only under `moduleResolution: "Bundler"`. Do not copy that into a tsc-built package.
- Contract addresses do not belong here; their source of truth is `packages/node/src/payments/chain-config.ts`.
- `withdraw(address buyer, uint256 amount)` pays the operator, never the buyer's hot wallet. A new call in `DEPOSITS_ABI` keeps to that.

**Ask first:** the WalletConnect project id; a new runtime dependency.

**Prove it:** `pnpm --filter @antseed/wallet-config test` and `typecheck`, then `typecheck` in every importer you touched (`typecheck:renderer` in desktop).
