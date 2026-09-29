---
sidebar_position: 8
slug: /guides/staking
title: ANTS Staking
hide_title: true
---

# ANTS Staking

`antseed ants` opens a local staking dashboard for the recognized-usage
protocol: stake ANTS into seller pools, manage locked positions, claim or
restake rewards, and handle seller-side verification. Every dashboard action is
also a CLI command, so the dashboard is optional. The protocol mechanics
(epochs, pools, power, slashing, reward buckets) are described in
[Recognized usage](/docs/recognized-usage); this guide covers the
tooling.

## Opening the dashboard

```bash
antseed ants                # start on http://127.0.0.1:3119 and open the browser
antseed ants --no-open      # print the URL only
antseed ants --port 4000    # use another port
antseed ants --address 0x…  # pin the dashboard to one account
```

The dashboard opens in your system browser. Browse pools before connecting, then
connect a wallet to approve transactions; the connected wallet is the account
whose positions and rewards you manage. The dashboard cannot sign transactions
with the local identity key. Terminal commands still use that local identity.
Buyer rewards follow the wallet too: a wallet that is a buyer account in its
own right sees its own usage and legacy buyer rewards. If the wallet is the
on-chain authorized operator of the local identity's buyer account, that buyer
account's rewards are shown instead. If no wallet is authorized for the local
buyer account, use the existing payments authorization flow.

`--address 0x...` pins the dashboard to an explicit account without loading or
using the local wallet. Seller and position actions then require that account's
wallet, buyer reward actions require its authorized operator, and switching
browser wallets does not change the pinned account. Pinned accounts must be
authorized separately.
The dashboard binds to localhost and the URL carries a per-session authorization token. Keep
that URL private: possession of the token allows access to the local API.
Read-only data refreshes on its own; any
action that sends transactions shows up as a pending indicator in the header,
with progress and transaction links in the **Activity** drawer and a toast when
it confirms. One signing action runs at a time. Activity is saved for 30 days
under `ants-activity` in the data directory. Run only one signing dashboard for a given wallet and data directory.
After a restart, interrupted actions are marked for manual review. Check the
recorded transaction links and wallet state before retrying; the dashboard
does not automatically resubmit them.

The header shows the chain and protocol phase:

| Phase | Meaning |
|---|---|
| Legacy | Only the legacy emissions contracts are live; the dashboard shows legacy claims only |
| Deployed | The recognized-usage contracts are deployed and can be staked into, but reward accounting starts at the cutover epoch shown in the banner |
| Active | Usage points, staker rewards, and usage rewards accrue every epoch |

## Stake tab

Four tiles summarise your wallet: ANTS balance (with whether transfers are
enabled for this wallet), total staked (including pending positions), your power, and claimable rewards.
Your positions appear first. A failed wallet read is shown as an error;
actions wait until wallet data is available. Staking controls explain when
insufficient gas or transfer restrictions prevent an action.

### Choosing a pool

The **Pools** table defaults to stakeable sellers. Clear **Only show pools ready
for staking** to include sellers that still need a binding, with the data needed to
decide where and for how long:

| Column | What it tells you |
|---|---|
| Pool | Seller name from the explorer, or the agent id; rows marked not stakeable have no seller binding yet |
| APY | One APY range for a 10,000 ANTS reference stake, from a 1-week lock to a 2-year lock, using the last completed epoch |
| Total active stake (ANTS) | Total principal active in this pool for the current epoch; stakes awaiting activation are excluded |
| Last epoch (USDC) | Settled volume in the last completed epoch |

Pool statistics, volume history, and closed positions come from the Antscan
indexer. Live wallet state and historical yield inputs are read from the chain. If the explorer is unreachable the table lists only the
pools you stake in and says so. Page sections load independently. The table shows
total active ANTS rather than fetching per-pool staker counts. While browsing
without a connected wallet, the Stake page skips account position and reward
requests. Initial wallet synchronization leaves in-flight reads intact when the
account has not changed. Pool summaries
are cached for up to one minute and invalidated after dashboard transactions.
Matching Antscan epoch snapshots supply network statistics and historical power;
settled indexed rewards can be reused, while unsettled rewards and missing or
mismatched historical inputs are read from contracts in batches.

Staker rewards for a pool scale with the pool's usage points, and your share of
them with your power in the pool. A pool with high volume and little power pays
more per unit of power; a longer lock gives more power per ANTS. Click a row to
open the provider-overview popup with volume per epoch against the network, the seller's
explorer profile, and pool yield details.

The table shows one range, **1-week APY – 2-year APY**, rather than
separate duration columns. Both endpoints use a 10,000 ANTS reference stake and
the same completed epoch's pool rewards and power:

- Initial position power = reference stake × lock epochs.
- Estimated epoch reward = pool rewards × position power / (historical pool power + position power).
- Epoch return = estimated epoch reward / reference stake.
- APY = (1 + epoch return) ^ (365 days / epoch duration) − 1.

Lock durations use the nearest supported whole epoch. With weekly epochs, the
endpoints are 1 epoch (7 days) and 104 epochs (728 days, approximately 2 years).
An unsupported endpoint or missing historical data shows **—** rather than a
fabricated rate. A valid epoch with no rewards shows **0.00% – 0.00%**.

Rates are displayed as percentages. These annualize the initial earning rates
while holding the historical pool reward budget fixed. APY assumes each rate
repeats and compounds every epoch; compounding is not automatic or guaranteed.
If either endpoint exceeds 10,000%, the whole range shows **N/A**; ranges at or
below 10,000% remain visible. This display limit does not change reward accounting.
Power decreases as a normal lock runs down, activation delays are excluded, and
future activity changes returns. Unsettled rewards are marked **est.**; hover for
the source epoch, actual lock durations, and assumptions.

The provider popup lists separate second-row APY tiles for **1 day, 1 month,
1 year, and 2 years** of locking, using the same 10,000 ANTS reference stake and
historical-rate calculation. These are not returns over those periods. With
weekly epochs, a one-day lock is **Unsupported**; the other labels resolve to
4 epochs (28 days), 52 epochs (364 days), and 104 epochs (728 days). Hover a
supported estimate for its actual duration and source epoch. Missing rate data
shows **—**, and each rate above 10,000% is independently shown as **N/A**.

The staking form retains amount and lock selection, activation/unlock dates, and
early-exit disclosures without personalized reward projections. Click the APY
column to sort by the 1-week endpoint, or the last-epoch volume header to sort by
volume; click again to reverse
direction. Missing values stay last. Volume remains available independently of
whether the pool has yield data.

Click a seller to open an informational provider-overview popup rather than a
sidebar. It has no staking action; use the pool table's **Stake** button instead.
Summary tiles show active stake, APY estimates by lock duration, last-epoch
volume, and staking power share. One chart overlays completed-epoch seller
volume on the left USDC axis and the seller's percentage of total network
volume on a fixed 0–100% right axis, sharing the epoch X-axis. Missing
observations leave gaps; missing or zero network totals do not become 0% share.
Each chart point includes its exact value in its tooltip and accessible label.

Lifetime activity includes settled volume, request count, unique buyers, and
models served when Antscan provides them. **Models & usage** loads separately
when opening the popup. Observed usage comes first; the final section shows
advertised models as a single list of tags, with each model name shown once
across categories and provider offerings. Advertisements are not a guarantee
of current availability.

Observed per-model requests, input/output tokens, and settled USDC come from
`GET /api/sellers/:address/model-usage?from=<seconds>&to=<seconds>` for the
**last completed epoch**, using boundaries from Antscan's `/api/emissions`.
The seller and period are filtered before aggregating all indexed matching
records, without a network-wide sample limit. The popup shows the epoch label,
with models sorted by settled USDC volume. The API period uses an inclusive
start and exclusive end. These are settlement-time totals, not request-time or lifetime
totals; free usage is excluded, and the API does not certify indexer completeness.
The overview separately shows settled, model-attributed, and unattributed USDC;
unattributed volume has no matching model breakdown in the indexed totals.
Unavailable data is labeled and never replaced with the old sample. Usage and
catalog failures are independent and do not block pool statistics.

Model data uses the same `payments.crypto.explorerApiUrl` as pool statistics
(`https://antscan.co` by default on Base mainnet). The configured Antscan server
must include the model-usage endpoint; an older server returns an explicit
missing-endpoint message.

### Staking

**Stake ANTS** opens a modal; a seller row's **Stake** button preselects that
pool. Choose the terms, then select **Review stake** to check the summary
before **Confirm stake** submits the action. **Back** preserves your entries;
**Cancel**, the close button, or Escape dismisses the modal.

The form takes a pool, an amount (**Max** fills the balance),
and a lock length on a slider that defaults to the minimum lock. The unlock
date includes the contract's activation delay as well as the selected lock.
Early withdrawal can burn part of the principal; review the displayed terms.
Staking new ANTS requires transfers to be enabled for
your wallet; rewards can be restaked regardless because they mint straight into
the pool.

### Positions

**Your positions** lists open lANTS positions with pool, amount, unlock epoch,
state, and pending reward. A position changed this epoch is marked pending and
cannot be withdrawn until next epoch. Split, merge, and move close the source
position and mint replacements; a closed position keeps the staker rewards it
earned up to its effective close epoch. The dashboard combines indexed history
with locally recorded, chain-verified position changes to keep those rewards
discoverable. Without an indexer, older closed positions unknown to this local
session may be missing.
The row menu offers:

- **Move allocation** to another pool; principal and lock are preserved, effective next epoch.
- **Split** an amount off into a second position with the same terms.
- **Merge** selected positions in the same pool with the same lock end.
- **Extend** the lock by extra epochs.
- **Max lock** on or off: constant maximum power instead of a countdown.

**Withdraw** shows the estimated principal burn for positions still under
lock and requires explicit consent before an early exit. Matured positions
withdraw without a penalty. A read-only dashboard can open the cost preview,
but cannot submit a withdrawal.

## Rewards tab

**Buyer rewards** shows rewards earned by the originating VPR/CLI account even
before a browser wallet connects. Separate **Current buyer rewards** and
**Legacy buyer rewards** rows show each amount and its own **Claim to wallet**
action. Each claim collects only that row's rewards and pays the authorized
deposits operator. Connect that wallet to claim or stake rewards; it can differ from the buyer account. If no
operator is configured, **Authorize wallet** opens the existing payments setup.
Returning to the dashboard refreshes authorization without clearing the page.
**Stake rewards** remains visible on the current buyer rewards row. It stakes
eligible current buyer rewards directly; when unavailable, the button tooltip explains why.
Each reward type has a short description of how it was earned. Eligibility
details and legacy-staking guidance appear in action tooltips and confirmations,
not in these descriptions.
The direct-staking amount is separate from legacy buyer rewards. Legacy rewards
have no direct staking function: after a successful claim to the authorized
wallet, they can be staked from **Stake → Stake ANTS → Wallet balance** only if
that wallet can transfer ANTS. Claiming does not bypass transfer restrictions.

**Seller & staking rewards** separately shows the connected wallet's staking,
current seller, legacy seller, and locked-pool rewards. These are unclaimed
rewards, not the wallet's ANTS balance. Each row has its own claim action;
the bulk **Stake rewards** action excludes buyer rewards. Staking rewards creates locked positions;
the confirmation lets you choose the destination pool and lock length. Rewards
restake into their source pools first, then move to the chosen pool in the same
job. Individual category actions remain available. Terminal reward commands
retain their existing defaults, including all-category compounding.

Claim confirmations show the amount and destination. Legacy seller eligibility
determines whether the action is **Claim to wallet** or **Claim to locked pool**.
If that destination cannot be verified, claiming is disabled until rewards are
refreshed. The service rechecks the reviewed destination before submitting;
contract policy can still change before execution. Claiming into the locked
pool does not pay the wallet or create a staking position.

Locked legacy rewards remain visible even when nothing is claimable. The
withdrawal tooltip explains when the M002 unlock policy is missing, and the dashboard distinguishes
the policy-released amount from the remaining locked balance. It does not
assume a release percentage or offer direct staking of locked rewards.
**Withdraw available amount** previews the recipient, available amount, and
remaining locked balance under the loaded release policy. Released
tokens can be staked after receipt only when the recipient wallet can transfer
ANTS. Existing-position rewards retain their direct **Stake rewards** action, even
while wallet transfers are restricted. If the indexer is unavailable or not
configured, rewards fall back to known on-chain and verified local positions.
A warning explains that closed-position rewards may be missing; the displayed
total is not presented as complete. Reward-preview failures still show an error.

## Seller tab

For seller wallets: agent id, ERC-8004 identity, seller-registry binding,
eligibility to serve, pool active stake against the minimum, and the starter
grant for legacy sellers. Identity ownership and seller-registry binding are
shown separately. **Register binding** reuses a known agent id, or creates an
ERC-8004 identity for a wallet that does not own one, then binds it in the seller
registry (required before anyone can stake into your pool). You can also supply
an existing agent id. If creation succeeds but binding fails, Activity records
the new id to use when retrying. Legacy stake is shown in USDC; starter grant
availability is a count, separate from the ANTS amount of each grant.

**Wash-trading status** shows the registry facts and this seller's proven wash
share. Proof artifacts produced by the `antseed-loop-proof` host are submitted
from the CLI; submission is permanent and permissionless.

## Network and addresses

**Network** shows the emission schedule, gate buckets and their budgets this
epoch, dynamic staker and usage shares, and network volume per epoch.
**Addresses** lists every contract in use. These views remain available at the
`#/network` and `#/addresses` routes; the bottom navigation strip is hidden.

## CLI equivalents

```bash
antseed ants status                                   # phase, epoch countdown, balances, claimable rewards
antseed ants pools                                    # the Pools table
antseed ants pool 84990                               # one pool in detail
antseed ants stake 250 --agent 84990 --epochs 12
antseed ants positions
antseed ants move 7 --to 84991
antseed ants split 7 100
antseed ants merge 8 9
antseed ants extend 7 --epochs 4
antseed ants max-lock 7 [--off]
antseed ants withdraw 7 --preview                     # estimate first
antseed ants withdraw 7 --accept-slashing             # early exit with consent
antseed ants rewards                                  # all buckets
antseed ants rewards claim [--staker|--seller|--buyer|--legacy|--locked]
antseed ants rewards compound --epochs 8 --to 59096   # bulk Stake rewards
antseed ants rewards restake --epochs 8               # staker pool rewards only
antseed ants rewards stake-usage --side seller --epochs 8
antseed ants seller [register|claim-starter]
antseed ants verify [seller]
antseed ants verify submit seller-proof.json          # resumable
antseed ants verify proof <proofId>
antseed ants usage | emissions | addresses
```

Every read command accepts `--json`. See the
[command reference](/docs/commands#ants-staking) for options.

## Configuration

Contract addresses are discovered from the deployment record for the
configured chain; `payments.crypto.explorerApiUrl` and the per-contract
`*Address` overrides are described in
[Configuration](/docs/config#ants-staking).


## Staking in VPR

In VPR, choose **Manage staking ↗** on the Rewards page. It opens the same localhost
dashboard in your system browser, using VPR's selected network and original buyer
account. There is no staking sidebar entry or separate Electron staking window.
**Claim rewards ↗** opens the Rewards tab of that same dashboard. Both shortcuts
reuse the server session and preserve their destination through authentication.
Opening a page never submits a transaction. Old payments claim links show an
**Open rewards dashboard** handoff instead of a separate claim form; standalone
payments sessions explain how to open `antseed ants` when no host launcher exists.

VPR keeps the local server alive while the browser is open. Reopening reuses its
session. Wallet/network switching cancels unsigned steps; transactions already
submitted, or awaiting a response from an open wallet approval, remain tracked.
Wait for running actions before changing VPR's identity/configuration or quitting.

## Move allocation and withdraw

Each eligible position has **Move allocation**; bulk move remains available. Moving
uses the contract's move operation, preserves principal and the remaining lock
window, and takes effect at the displayed epoch. The preview shows the configured
future-power reduction and source rewards that remain claimable separately.
Moves transfer whole selected positions in one transaction; partial amounts are
not supported. The separate Split action remains available. Maximum lock must be disabled first; pending
changes must become effective before another action can run.

Withdrawal has its own preview: principal returned, early-exit penalty sent to the
dead address, rewards still claimable separately, and whether received ANTS remain
transfer-restricted. It simulates the withdrawal before requesting approval.
Withdrawal does not claim rewards or make ANTS freely transferable. Recently closed
or moved source positions are recovered from confirmed local transactions while
the indexer catches up; without an indexer, older unknown closed positions may be missing.

## Local Anvil verification

From the worktree root, build and start a disposable restricted-transfer fork:

```bash
pnpm --filter @antseed/ants build
node scripts/ants-sandbox.mjs --restricted --browser --port 3136
```

The script prints its temporary directory and seeds an originating buyer with a
separate authorized wallet, existing positions, and claimable rewards. It changes
only local Anvil state. Global transfers remain disabled, and temporary setup
allowlisting is removed before the dashboard is exposed.

In another terminal, run the browser signing/API lifecycle checks:

```bash
node scripts/ants-browser-e2e.mjs /path/to/ants-sandbox-directory/scenario.json
```

These checks restore the original local chain state after each scenario. Do not
interact with that sandbox while the checks run. They cover separate buyer/signer
identity, rejection, claims, reward staking, compounding, position changes, penalties
and closed-position rewards. The new-stake scenario enables transfers only inside a
reverted snapshot. This protocol test does not substitute for wallet-extension UI QA.

The full run also includes the current/legacy reward matrix. To run only that matrix:

```bash
node scripts/ants-browser-e2e.mjs /path/to/ants-sandbox-directory/scenario.json legacy
```

| Anvil case | Checked outcome |
| --- | --- |
| Current-only / legacy-only buyer claim | Only the selected source is consumed; the authorized wallet receives ANTS; other rewards and positions stay unchanged |
| Combined buyer claim | Both buyer sources are collected; seller and position rewards stay untouched |
| Pre-migration V1 rewards claimed through V2 | Buyer payout remains source-specific; M002 includes old seller rewards in the cumulative release entitlement |
| Unauthorized wallet / rejected approval | No claim flags, balances, or transaction nonce change |
| Direct buyer, seller, and position reward staking | Only the selected current rewards become stake; legacy balances remain unclaimed |
| Compounding, with and without buyer rewards | Only eligible current sources become stake; legacy balances are excluded |
| Legacy buyer claim then wallet staking | Staking is blocked while transfers are restricted; wallet allowlisting or global enablement permits it |
| Legacy seller locked payout | Escrow funds the locked pool, not the wallet; no position is created |
| Legacy seller direct payout | Explicit unlock eligibility pays the wallet, but does not grant transfer permission or create a position |
| Changed / unreadable seller payout destination | The reviewed claim is blocked before approval; balances remain visible when the eligibility RPC fails |
| Reverting seller unlock policy | The preview and real claim both use the contract's locked-payout fallback |
| No M002 release policy | Locked rewards remain visible; withdrawal is unavailable |
| M002 release policy, pool transfers restricted | A release entitlement alone cannot make the pool transfer tokens |
| M002 release with pool allowlisted | The configured 10% cumulative entitlement releases once; the remainder stays locked; recipient staking still needs wallet transfer permission |
| Proven wash trader | The release policy permits no withdrawal and preserves the locked balance |
| Repeat claims and withdrawals | No additional payout or approval after the selected entitlement is exhausted |

The matrix seeds synthetic points into a finalized pre-cutover epoch for the
fresh sandbox identities. It derives storage slots from the Solidity compiler's
layout, checks them against fork getters, and verifies the seeded V1/V2 points before
testing the real deployed claims and escrow. The M002 cases deploy the actual
`AntseedLegacySellerClaimPolicy` locally with a controlled wash-status test
contract; they do not test production wash-proof verification. Every scenario
runs inside a reverted snapshot, including policy deployment and permission
changes. No production writes are made.

These fixtures require native Solidity **0.8.24** (Foundry's
`~/.svm/0.8.24/solc-0.8.24`, `solc` on PATH, or `SOLC_BIN`). Only the needed policy
bytecode and legacy storage layout are compiled; a full Foundry suite build is
not required. Reward-row labels, scoped request payloads, disabled states, and
confirmation contents are also covered by `pnpm --filter @antseed/ants test`.

For browser UI QA without a real wallet extension:

```bash
node scripts/ants-browser-qa.mjs /path/to/ants-sandbox-directory/scenario.json 3137
```

Open the sandbox dashboard URL with port **3137**, preserving its session token.
Connect **Anvil test wallet**. The **Anvil test controls** panel can switch between
the buyer and authorized accounts, simulate a wrong network, and reject the next
transaction. These controls exist only in the test proxy. It injects an ephemeral EIP-6963
provider; its transactions can only target the local Anvil chain. Do not publish
this proxy. Stop and rerun the sandbox for a fresh wallet and chain state.

On the **Stake** page, click **Stake ANTS** and choose **Stake from**:

- **Unclaimed buyer rewards**: select a pool and lock; the authorized wallet owns the new position.
- **Unclaimed seller rewards**: stake into the seller's own pool.
- **Staking rewards · position #…**: restake the selected position's rewards in its source pool. Indexing can require an approval before restaking.
- **Wallet balance**: disabled while the wallet cannot transfer ANTS.

Reward amounts use all eligible rewards from the selected source; legacy and
locked-pool rewards do not have a direct staking route. After confirmation,
check the new pending position and reduced rewards; the wallet ANTS balance
should remain unchanged. Sandbox yields and dates reflect seeded rewards and
simulated time, not production returns.

To run just the restricted-transfer source checks (including wrong wallet,
wrong network, rejection, and wallet-stake blocking):

```bash
node scripts/ants-browser-e2e.mjs /path/to/ants-sandbox-directory/scenario.json stake-sources
```

To verify VPR's browser launcher after building the desktop main process:

```bash
pnpm --filter @antseed/desktop build:main
pnpm --filter @antseed/desktop exec electron scripts/test-staking-window.mjs --data-dir /path/to/ants-sandbox-directory
```

The smoke test intercepts the system-browser launch, verifies that repeated launches
reuse one authenticated localhost session, and verifies no Electron staking window
or local transaction signer is created. Add `--open` to open the browser and keep
that test session alive, or `--bundle /path/to/AntSeed.app/Contents/Resources/app.asar`
to use packaged assets. Signed installer and real wallet-extension checks remain
separate release checks.
