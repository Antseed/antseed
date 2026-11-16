# @antseed/diem-staking

The static web app for the DIEM Provider Capacity Program at diemantseed.com. Users lock the DIEM token on Base into the `DiemStakingProxy` contract, withdraw, and claim USDC allocations and ANTS incentives. Browser only: Vite, React 19, wagmi, RainbowKit. Private, never published, no `@antseed/*` dependencies. `README.md` holds the contract surface, the withdrawal states and the site metadata; its "React 18" line is stale.

## Inside

- `src/App.tsx` — the one page; `src/components/StakeCard.tsx` — lock, withdraw, claim.
- `src/lib/addresses.ts` (token and proxy; `VITE_DIEM_STAKING_PROXY` overrides), `abi.ts` (the subset the page calls), `hooks.ts` (every read), `actions.ts` (every write).
- `src/lib/vpr.ts` — desktop download links. `public/` — terms, robots, the audit report.

| Rule | Enforced by |
| --- | --- |
| Every write names Base (`chainId: DIEM_CHAIN_ID`) and switches the wallet first. A wallet left on another chain must never receive the transaction. | review only (`src/lib/actions.ts`) |
| Amounts stay `bigint` until display. Inputs are built from `bigint` (`formatDiemInput` in `StakeCard.tsx`), never from a rounded number, so "withdraw all" withdraws all. | review only |
| `src/lib/abi.ts` matches `DiemStakingProxy.sol`. Change both in one PR. | review only; `packages/contracts/test/DiemStakingProxy*.t.sol` cover the contract only |
| On-chain reads are the source of truth for claimability (`finalizedRewardEpoch()`); off-chain data (price, the historical rate) only decorates. | review only |

## Connections

- Contract: `packages/contracts/staking/DiemStakingProxy.sol`, with incentive epochs tied to the emissions contract.
- The proxy address is also in `apps/desktop/src/renderer/core/known-proxies.ts` (the "DIEM Pool" badge). A redeploy changes both files.
- DIEM rewards are claimed here, not in the payments portal. Root scripts `build:diem-staking`, `dev:diem-staking`, `typecheck:diem-staking`.

## Traps

- Program copy is legal wording: a capacity program with variable allocations that may be zero. No APY, yield or return phrasing, and no financial-product structured data. Never reword it; flag a concern instead.
- `vpr.ts` says it mirrors the website's `useLatestDesktopDownload.ts`, but the website now links download.antseed.com while `vpr.ts` reads the GitHub API. Asset-name rules can drift.
- `POOL_GENESIS_UNIX` (`hooks.ts`) is a constant, not a log query. A new proxy deployment needs a new value, or the historical rate is wrong.
- Wallet transactions once followed a wallet left on Ethereum mainnet. Keep `ensureDiemNetwork()` before every `writeContractAsync`.
- No tests. `build` runs `tsc --noEmit` first, so a type error fails it.

**Ask first:** the proxy or token address, ABI changes, any Program copy, terms or metadata in `index.html`, the WalletConnect project id or RPC list.

**Prove it:** `pnpm --filter @antseed/diem-staking typecheck` and `pnpm --filter @antseed/diem-staking build`. Wallet flows by hand against a fork or with a test wallet; there is no automated check.
