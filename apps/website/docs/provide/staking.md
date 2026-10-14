---
title: ANTS staking
slug: /provide/staking
sidebar_label: Staking
description: Stake ANTS into seller pools, manage positions and claim rewards from the local staking dashboard or the antseed ants commands.
---

# ANTS staking

`antseed ants` opens a local staking dashboard: stake ANTS into seller pools, manage locked positions, claim or restake rewards, and register your seller pool. Every dashboard action is also a CLI command, so the dashboard is optional. Staking is not required to sell; it adds ANTS rewards on top of USDC earnings. How epochs, pools, power, early-exit penalties and reward buckets work is described in [ANTS rewards](/docs/recognized-usage).

## Open the dashboard

```bash
antseed ants                 # serves http://127.0.0.1:3119 and opens your browser
antseed ants --no-open       # print the URL only
antseed ants --port 4000     # use another port
antseed ants --address 0x…   # pin the dashboard to one account
```

You can browse sellers before connecting a wallet. Connect a wallet to approve transactions: the connected wallet is the account whose positions and rewards you manage. The dashboard never signs with the local identity key; the terminal commands do.

The dashboard listens on localhost only, and its URL carries a per-session token. Keep the URL private, because the token grants access to the local API.

`--address` pins the dashboard to one account without loading the local wallet. Seller and position actions then need that account's wallet, and buyer reward actions need its authorized wallet.

Actions that send transactions show progress, transaction links and a final notification in the **Activity** drawer. One signing action runs at a time, and the history is kept under `ants-activity` in the data directory. Run only one signing dashboard per wallet and data directory. If the dashboard restarts mid-action, the action is marked for manual review: check its transaction links and your wallet before retrying, because the dashboard never resubmits on its own.

### From the desktop app

In the desktop app (AI VPN), open **Rewards** and choose **Manage staking ↗** or **Claim rewards ↗**. Both open this dashboard in your system browser, using the desktop app's network and buyer account.

## Choose a seller and stake

The **Sellers** page lists seller pools with their APY range, total active stake (**TVL**), last-epoch settled volume and your own stake. Click a seller for its volume history, share of network volume, models served and yield details.

The APY range estimates the initial yield of a 10,000 ANTS stake locked for the shortest to the longest supported lock, based on the last completed epoch's pool rewards and power. It assumes those rates repeat and compound every epoch, which is not guaranteed. Missing data shows **—**, and estimates above 10,000% show **N/A**.

To stake, click **Stake** on a seller's row, choose what to **Stake from** (**Wallet balance**, unclaimed buyer or seller rewards, or a position's staking rewards), an amount and a lock length, and review before confirming. The unlock date includes the contract's activation delay. **Wallet balance** is offered only when ANTS transfers are enabled for your wallet; rewards can be staked regardless, because they mint straight into the pool.

Pool statistics, volume history and closed positions come from the Antscan indexer (`payments.crypto.explorerApiUrl`). If it is unreachable, the dashboard lists only the pools you stake in and says so. Your live wallet state is always read from the chain.

## Manage positions

**My positions** lists your open positions with pool, amount, unlock epoch, state and pending rewards. A position changed in the current epoch is pending and can't be withdrawn until the next one. Each position's menu offers:

- **Split**: move part of the amount into a second position with the same terms.
- **Merge**: combine positions in the same pool with the same lock end.
- **Extend lock**: add epochs to the lock.
- **Enable max lock** / **Disable max lock**: keep constant maximum power instead of a countdown.
- **Move allocation**: move the position to another pool, keeping principal and remaining lock. Takes effect next epoch.
- **Withdraw**: matured positions withdraw without penalty. For a position still under lock, the preview shows the estimated principal burn and requires explicit consent.

Split, merge and move close the source position and create new ones. A closed position keeps the staker rewards it earned until it closed. Withdrawing does not claim rewards.

## Claim rewards

**Rewards** separates buyer rewards from seller and staking rewards:

- **Current buyer rewards** and **Legacy buyer rewards** each have their own claim action, which pays your buyer account's authorized wallet. Connect that wallet to claim. If no wallet is authorized, **Authorize wallet** opens the setup. Current buyer rewards can also be staked directly.
- Staking, current seller, legacy seller and locked-pool rewards each have their own claim. **Stake rewards** restakes them as new locked positions in the pool and lock length you choose; buyer rewards are not included.
- Locked legacy seller rewards stay visible even when nothing is claimable. **Withdraw available amount** releases what the release policy allows.

Claimed ANTS that remain transfer-restricted can't be staked from your wallet until transfers are enabled for it.

## Register your seller pool

The **Seller** page shows your agent ID, ERC-8004 identity, seller-registry binding, eligibility, active pool stake and any starter grant. **Register seller binding** creates an ERC-8004 identity if your wallet has none (or uses the agent ID you enter) and binds it in the seller registry. Nobody can stake into your pool until it is bound. `antseed seller register` does the same from the terminal.

The page also shows your **Wash-trading status**.

## Network and addresses

**Network** shows the emission schedule, this epoch's reward buckets and budgets, and network volume per epoch. **Addresses** lists every contract the dashboard uses.

## CLI equivalents

```bash
antseed ants status                                     # phase, epoch countdown, balances, claimable rewards
antseed ants pools                                      # the Sellers table
antseed ants pool <agentId>                             # one pool in detail
antseed ants stake 250 --agent <agentId> --epochs 12
antseed ants positions
antseed ants move <positionId> --to <agentId>
antseed ants split <positionId> 100
antseed ants merge <positionId> <positionId>
antseed ants extend <positionId> --epochs 4
antseed ants max-lock <positionId> [--off]
antseed ants withdraw <positionId> --preview            # estimate first
antseed ants withdraw <positionId> --accept-slashing    # early exit with consent
antseed ants rewards                                    # all buckets
antseed ants rewards claim [--staker|--seller|--buyer|--legacy|--locked]
antseed ants rewards compound --epochs 8 --to <agentId> # stake all eligible rewards
antseed ants rewards restake --epochs 8                 # staker rewards only
antseed ants rewards stake-usage --side seller --epochs 8
antseed ants seller [register|claim-starter]
antseed ants verify [seller]
antseed ants verify submit <artifact>
antseed ants verify proof <proofId>
antseed ants usage
antseed ants emissions
antseed ants addresses
```

Read commands accept `--json`. Seller-specific shortcuts also exist: `antseed seller stake <amount> --epochs <n>`, `antseed seller pool positions`, `antseed seller pool withdraw <ids...>` and `antseed seller rewards`. See [Commands](/docs/commands) for every option, and [Seller configuration](/docs/provide/config#ants-staking) for the explorer and contract-address settings.
