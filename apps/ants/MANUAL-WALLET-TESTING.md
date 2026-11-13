# Manual wallet-flow sandbox

This setup uses a disposable local Anvil fork, chain ID **31337**. Transactions
change only that fork. The QA proxy injects an **Anvil test wallet** and uses a
browser confirmation dialog as its wallet approval step. It does not exercise a
real MetaMask/Rabby extension popup, and no personal wallet or real funds are needed.

## Start a fresh session

Use the repository's pinned Node.js version, Anvil, and solc 0.8.24. Install
workspace dependencies, then build `@antseed/node` and `@antseed/ants`.

```sh
node scripts/ants-sandbox.mjs --restricted --browser --port 3123
```

Keep that terminal running. It prints a temporary directory containing
`scenario.json`. In another terminal, prepare the manual fixtures:

```sh
node scripts/ants-manual-setup.mjs /absolute/path/to/scenario.json
node scripts/ants-browser-qa.mjs /absolute/path/to/scenario.json 3135
```

Open the sandbox's printed dashboard URL, replacing port **3123** with **3135**
and retaining the `#token=...` fragment. Connect **Anvil test wallet**. The direct
3123 URL does not inject a wallet; use the proxy for the ready-made test experience.
Run the fixture seeder once per fresh sandbox, before starting the proxy.

## Prepared scenarios

`manual-fixtures.json`, beside `scenario.json`, records the actual position IDs.

| Fixture | What to try |
| --- | --- |
| 1,000 and 500 ANTS active positions in the first pool | Extend, move to the second pool, early withdrawal |
| 100 ANTS active position in the second pool | Move allocations between both pools |
| 125 ANTS max-locked position | Inspect its perpetual-lock state and withdrawal penalty |
| 75 ANTS matured position | Withdraw without an early-exit penalty |
| 200 ANTS pending position | Inspect pending state, advance an epoch to activate |
| Claimable staker, seller and buyer rewards | Claim or restake, check destination seller names, then repeat to check empty/repeated claims |
| Claimable legacy seller and buyer rewards | Claim legacy buyer rewards; verify locked-pool seller claims show “Claim not available yet” |
| Separate buyer and authorized-wallet addresses | Wrong-wallet handling and authorized buyer claims |

The signing wallet is funded and allowlisted initially. Global ANTS transfers
remain disabled, so restricted behavior can be restored without restarting.

Split, extend, max-lock toggles, move and withdraw live in each position's
action menu; select several positions with the row checkboxes to merge them
(same seller and unlock epoch, no max lock) or withdraw them together from the
bulk bar. Max-lock changes apply from the next epoch; the position's secondary
line shows "max lock from next epoch" / "max lock ends next epoch" until then.
Combined compounding is not exposed in the dashboard.

With transfers restricted, the stake dialog lists only reward sources (buyer,
seller, position rewards); the wallet balance is not offered until transfers
are enabled for the wallet.

When claiming or restaking, the wallet opens directly for newly started actions.
Rejecting approval must leave reward amounts unchanged. After a transaction
confirms, the amounts shimmer while fresh values load and reward actions remain
disabled; background refreshes alone should not trigger this animation.

## Wallet connection and transaction feedback

- Disconnect the browser wallet while the backend still remembers its address.
  Position previews remain available, but submission must be disabled and show
  **Connect wallet**. Switching to another chain must show **Switch network**.
- Open an action form, then disconnect or change accounts before submitting.
  The shared submission guard must block the old form from starting a job.
- For a new action, bottom-right toasts distinguish **Awaiting wallet approval**
  (no hash yet), **Submitted** (a hash exists), and **Confirmed**. The action and
  position IDs identify the current operation; each new phase replaces that
  operation's previous toast. There is no separate wallet-opening or tracking button.
- Reject an approval: the toast must identify rejection, not report a generic
  wallet failure. Disconnection, wrong network, and contract simulation failures
  have separate messages. Unknown failures explicitly advise checking wallet
  activity rather than claiming that nothing was submitted.
- Disconnect before wallet approval opens: the unsigned job must stop. Once
  approval has opened, or a hash has been returned, the existing request remains
  tracked without automatically resubmitting it. Test this with a delayed wallet;
  Anvil normally confirms too quickly to exercise the submitted phase manually.
- Reload: historical failed jobs must not reappear as failures of a new action.

## Anvil test controls

The controls are hidden by default. To show the **Anvil test controls** panel at
the bottom left, start the proxy with the optional flag:

```sh
node scripts/ants-browser-qa.mjs /absolute/path/to/scenario.json 3135 --controls
```

- **Use buyer account / Use authorized wallet:** exercise account mismatch and recovery.
- **Wrong network / Anvil network:** exercise chain mismatch and recovery.
- **Reject next transaction:** reject the next submitted wallet request.
- Pending positions (split parts, merge results, fresh stakes) appear under **My positions** in the left menu with a `pending` badge, and their amount is called out in amber as "pending activation" on the sellers table, the seller sheet and the positions page tiles.
- **Advance 1 epoch:** activate pending positions or clear next-epoch restrictions
  after move, split, merge, or extend.
- **Mature ordinary locks (+106 epochs):** test normal withdrawals. Perpetually
  max-locked positions do not mature through time advancement alone.
- **Allow wallet staking/transfers / Restrict wallet transfers:** toggle the
  test wallet's allowlist permission, not global transfer policy.
- **Reset test chain:** restore the chain snapshot taken when the proxy started,
  including the prepared balances, positions, permissions and rewards. Activity
  records from previous test attempts remain visible.

Finish or cancel any running wallet action before using chain controls. Every
control requires the sandbox token and a same-origin POST. The proxy binds only
to `127.0.0.1`; do not expose it through a public tunnel.

Stop the proxy and sandbox with Ctrl+C. Rerun all three commands for a completely
fresh session and activity history. Public fork reads can be slow on first use;
the setup retries transient read failures but never replays transaction requests.
