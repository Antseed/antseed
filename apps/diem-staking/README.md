# @antseed/diem-staking

Static web app for the DIEM Provider Capacity Program portal at
[`diemantseed.com`](https://diemantseed.com).

Users lock Venice's DIEM token (on Base) into the `DiemStakingProxy` contract
to participate in provider capacity. If connected provider infrastructure
processes paid inference requests, eligible participants may receive USDC
allocations and $ANTS incentives according to Program rules. Allocations are
variable, not guaranteed, and may be zero.

## Stack

- Vite + React 18 + TypeScript (strict)
- `wagmi` + `viem` for all chain I/O
- RainbowKit for wallet connection
- `@tanstack/react-query` for caching + polling

Uses the same WalletConnect project id and Base RPC fallback order as the
existing `apps/payments/web` portal — see `src/wagmi-config.ts`.

## Scripts

```bash
pnpm --filter=@antseed/diem-staking run dev        # vite dev server (:5180)
pnpm --filter=@antseed/diem-staking run typecheck  # strict tsc
pnpm --filter=@antseed/diem-staking run build      # typecheck + vite build → dist/
pnpm --filter=@antseed/diem-staking run preview    # serve built output
```

`dist/` and `node_modules/` are ignored by the repo-root `.gitignore`; this
app ships no per-app `.gitignore`, matching `apps/payments`.

## Configuration

The only required configuration is the deployed `DiemStakingProxy` address:

```bash
# .env.local (or environment at deploy time)
VITE_DIEM_STAKING_PROXY=0x…
```

If not set, every on-chain read short-circuits to `null`/`"—"` and write
actions are gated behind the connect-wallet CTA so the page still renders
cleanly pre-deploy.

## What's live vs. cached

Every display value is on-chain live except two:

| Source | What |
|---|---|
| **On-chain (wagmi `useReadContract` / `useReadContracts`, polled every ~12s)** | Program TVL (`totalStaked`), distinct participants (`stakerCount`), USDC allocated all-time (`totalUsdcDistributedEver`), Program cap (`maxTotalStake`), incentive baseline (`firstRewardEpoch` / `syncedRewardEpoch` / `finalizedRewardEpoch`), Venice cooldown (`DIEM.cooldownDuration`), user wallet DIEM, user locked DIEM, user claimable USDC (`earnedUsdc`), user pending ANTS (`pendingAntsForEpoch` summed), per-epoch claim flags (`userEpochClaimed`), withdrawal queue state (`currentUnstakeBatch` / `oldestUnclaimedUnstakeBatch` / `unstakeBatches(id)` / `unstakeBatchUserAmount`). |
| **Off-chain** | DIEM price from CoinGecko (`useDiemPrice`). Falls back to "—" on miss; the historical activity rate degrades to 0. The rate uses all-time allocated USDC divided by Program age in days, annualized by 365, then divided by live Program TVL; TVL is current locked $DIEM valued at the live $DIEM price. Program age is computed from the `POOL_GENESIS_UNIX` constant in `src/lib/hooks.ts` (the timestamp of the first `Staked` event on the deployed proxy) — no log query needed at runtime. Authoritative claimability still comes from `finalizedRewardEpoch()` on-chain. |

## Withdrawal UX

The proxy's withdrawal flow is three on-chain steps (`initiateUnstake` → `flush`
→ `claimUnstakeBatch`) but the UI presents one smart action button per user state:

- **Queued** — batch not yet flushed. Button: "Start cooldown" (calls
  `flush`). Disabled with an explanation when the prior batch is still
  unclaimed or when the minimum batch-open window has not elapsed.
- **Cooling down** — batch sent to Venice. No action; live countdown.
- **Claimable** — ready to withdraw. Button: "Withdraw N $DIEM" (calls
  `claimUnstakeBatch`, pays everyone in the batch).

Any user in the batch can advance each step, so users often find theirs already
moved. No keeper service required.

## ANTS incentive epochs

The proxy no longer relies on an operator tick to decide incentive boundaries.
Incentive epochs are aligned to `AntseedEmissions.currentEpoch()`:

- `firstRewardEpoch` pins the emissions epoch at proxy deployment.
- `syncedRewardEpoch` is the next incentive epoch that still needs a local
  `RewardEpochClosed` checkpoint.
- `finalizedRewardEpoch()` reads the emissions contract's current epoch; epochs
  below it are finalized and can be synced/claimed.
- `syncRewardEpochs(maxEpochs)` permissionlessly checkpoints finalized epochs in
  bounded chunks.
- `claimAnts(uint32[] rewardEpochs)` accepts explicit epoch ids, lazily syncs a
  bounded backlog, lazily funds each epoch's ANTS pot from `AntseedEmissions`,
  and marks zero-payout epochs processed so the user can advance to later
  epochs.

For ABI consumers migrating from the earlier proxy surface:

| Old | New |
|---|---|
| `currentEpoch` | `currentUnstakeBatch` |
| `oldestUnclaimed` | `oldestUnclaimedUnstakeBatch` |
| `epochs(id)` | `unstakeBatches(id)` |
| `epochUserAmount(id, user)` | `unstakeBatchUserAmount(id, user)` |
| `claimEpoch(id)` | `claimUnstakeBatch(id)` |
| `setMinEpochOpenSecs(secs)` | `setMinUnstakeBatchOpenSecs(secs)` |
| `operatorClaimEmissions(epoch)` | `syncRewardEpochs(maxEpochs)` + user `claimAnts(uint32[])` |

## Site metadata

`index.html` uses DIEM Provider Capacity Program specific metadata:

- `<title>`, `og:title`, and `twitter:title`: `DIEM Provider Capacity Program | Antseed`.
- `description`, `og:description`, and `twitter:description` describe DIEM locking,
  variable USDC allocations, and variable $ANTS incentives without APY/yield phrasing.
- `canonical` is `https://diemantseed.com/`.

Everything else — keywords, `og:type`, `og:image` / `twitter:image`,
`twitter:card`, favicon, fonts — is byte-for-byte what antseed.com emits.

Static assets copied from the website:

- **Favicon**: `public/logo.svg` — same Antseed ant as antseed.com. Copied
  verbatim from `apps/website/static/logo.svg`; keep the two in sync.
- **Fonts**: same Google Fonts stylesheet (Space Grotesk + JetBrains Mono).
- **`og:image` / `twitter:image`**: `https://antseed.com/og-image.jpg` — the
  parent site's card. If a dedicated DIEM capacity hero card is ever designed,
  drop it at `public/og-image.jpg` and update the two URLs here.
- **`robots.txt`**: copied from `apps/website/static/robots.txt` — same AI
  crawler allowlist, minus the parent-site sitemap directive.

### Not mirrored

The website also ships `google-site-verification` and a JSON-LD
`SoftwareApplication` schema. Neither is copied:

- `google-site-verification` is per-host; Search Console wants a separate
  token for the `diemantseed.com` subdomain. Add one to `index.html` when
  the subdomain is verified.
- The `SoftwareApplication` JSON-LD describes the VPR desktop app —
  wrong schema for this page. Avoid adding financial-product structured data
  unless reviewed for the Program's current legal and regulatory posture.

## Contract reference

Source of truth for all ABIs:
[`packages/contracts/DiemStakingProxy.sol`](../../packages/contracts/DiemStakingProxy.sol).
`src/lib/abi.ts` mirrors the subset this app calls — keep them in lockstep.
