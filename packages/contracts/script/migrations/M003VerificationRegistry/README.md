# M003 — Verification contracts

Deploys the verification contracts, and nothing else outside them:

| Nonce | Contract | Constructor |
|---|---|---|
| N | `AntseedVerificationResults` | `(registry)` |
| N+1 | `AntseedKbfAudits` | `(results, sellerPools)` |
| N+2 | `AntseedVerificationPointsPolicy` | `(results, usageAccounting, bonusBps, owner)` |

N is `VERIFICATION_DEPLOYMENT_NONCE`, the deployer's next nonce. All three are deployed from
`VERIFICATION_OWNER`, which owns them. In the same broadcast the script then does the wiring the
verification owner can do on its own:

- `results.setSource(kbf, true)`: the KBF audit source may record verdicts and grant credits;
- `results.setSourceShareBps(kbf, 10_000)`: KBF gets the whole verification bucket until a second
  verification method is added. Share changes apply from the next epoch, so KBF's share starts the
  epoch after the deploy; the deploy epoch's bucket (if the results layer already controls it) goes
  to `settleEpochRemainder`.

It approves **no** auditors, does **not** register the policy in the `AntseedPointsPolicyRegistry`,
and does not touch the emissions gate, staking, or protocol registry pointers. M002 is not a
prerequisite.

## What the contracts do

Readers (the points policy, the node, dashboards) read **one** contract, the results layer, whatever
method produced a verdict. A verification method is a *source* contract approved on the results
layer, with its own consensus and its own share of the reward bucket; KBF (`AntseedKbfAudits`) is the
first. The owner approves KBF auditors on `AntseedKbfAudits` itself (`setAuditor`). A KBF source with
another admission rule (a council, a stake-based set) is a new source on the same results layer, so
readers and the reward bucket stay put.

- **Points change only through the rates.** Once registered, the policy scales seller points by
  `bonusBps` (from `VERIFICATION_BONUS_BPS`, default 0; e.g. 100 = +1% per verified service, capped
  at +50% in total) and `penaltyBps` (uncapped, per DIFF service; starts at 0). With both at 0 no
  seller's points change. A rate set with `setBonusBps` or `setPenaltyBps` applies from the next
  settlement on. A DIFF only affects its own service.
- **Verdicts expire by epoch.** A SAME or DIFF counts for `validityEpochs` emissions epochs
  including the one it was given in (default 2; owner-settable from 1 to 4), then drops out.
- **A DIFF needs a second auditor.** `kbf.requiredReports` sets how many distinct approved auditors
  must report a verdict before it is recorded: SAME 1, DIFF 2, UNDETERMINED 1
  (`setRequiredReports`). Until a second auditor confirms it, a DIFF only waits.
- **The latest verdict from any source wins.** The results layer does not judge what a source
  records. Within KBF, replacing a live DIFF (from any source) needs `kbf.diffReplacementReports` reports (default 1, so one SAME is enough; the owner can raise it with `setDiffReplacementReports`). A second
  source added later can overwrite KBF's verdicts, so it must bring its own rules for that. The owner
  can reset services with `results.clearServiceStatuses`; KBF then drops reports made before the
  clear.
- **Rewards stay off** until `results.setRewardsStartEpoch(kbf, epoch)`. Each model audit that covers
  a staked seller earns one credit (`kbf.maxCreditsPerModelPerEpoch`, default 1;
  `results.maxCreditsPerAuditorPerEpoch(kbf)`, default 100). A finished epoch's KBF share is split by
  credits; each auditor gets at most `maxAuditorShareBps(kbf)` of it (default 2,000 = 20%) and the
  rest of its reward goes to the emissions reserve in the same claim. Auditors claim with
  `results.claimRewards(kbf, epochs)` (`antseed verifier rewards --claim`).
- **Unclaimable budget is swept, not stranded.** Anyone can call `results.settleEpochRemainder(epoch)`
  for a finished epoch: budget no auditor can ever claim (no credits, no source, voided credits)
  goes through the gate's remainder route, burn up to the gate's cap and then the reserve, like the
  other emission controllers. The gate must have an emissions reserve configured.
- **Auditors can publish a profile.** `kbf.setAuditorProfile(name, iconUri, url)` (`antseed verifier
  profile`) stores a display name and `https://` / `ipfs://` links for UIs.
- **The emissions gate is pinned.** The results constructor reads the gate behind
  `registry.emissions()` (usage accounting's `emissionsGate()`) and keeps it for life.

## Replacing the earlier M003 deployment

M003 previously deployed a single `AntseedKbfVerification` and `AntseedKbfVerificationPointsPolicy`.
The last of those, on Base mainnet, is `AntseedKbfVerification`
`0x4BdAfcc48cc61Aaf1ed2f5EbaCc05Ee305C80916` (deploy block 53,419,391) with policy
`0xB252c8c9F5d74114ac525Ca8DBdBc5F028ec8C12`. M003 now deploys the contracts above as a new release,
`003-verification-split`. Deployment history is append-only, so the earlier record
(`history/003-kbf-verification.json`, release `003-kbf-verification`) stays as it is and no
migration owns it any more; on activation the new release's contracts are added to `current.json`,
the old `kbfVerification` / `kbfVerificationPointsPolicy` entries stay there with
`deployedInRelease: false`, and `verificationConfiguration.verificationRegistry` is replaced. The
address generator no longer reads `kbfVerification`, so the SDK and CLI have no built-in
verification address until the new release is recorded. The old contracts stay on-chain unused.

**Nothing carries over.** Verdicts, report tallies, credits and auditor approvals live in the old
contract. Its verdicts expire within 2 epochs; its policy keeps reading them while it is registered
(step 3 removes it). Auditors are approved again on the new KBF contract (step 2). Until the new deployment
is recorded, the SDK and CLI have no built-in verification address on Base mainnet (set
`payments.crypto.verificationContractAddress` to the new `AntseedKbfAudits` to use it earlier).

## Manual owner steps after the broadcast, in order

The script does none of these. Until they are done no audit can be submitted (no approved
verifiers), verdicts change no points (the policy is not registered), and audits earn no credits
(rewards are off).

1. **Emissions gate owner:** hand the verification bucket to the results layer. M001 registered the
   bucket as minter `keccak256("antseed.emissions.verification.v1")` (`setMinter(id,
   VERIFICATION_WALLET, 10_000, true)`, editable); its controller is whoever holds it now
   (`VERIFICATION_WALLET`, or the old `AntseedKbfVerification` if its rewards were launched):

   ```solidity
   gate.setMinterController(keccak256("antseed.emissions.verification.v1"), results);
   ```

   `gate.claim` then accepts claims from `results` only, for every epoch. Before moving it, make
   sure the old contract owes nothing: its `rewardsStartEpoch` must still be off
   (`type(uint256).max`, as on Base mainnet at the time of writing) or, if its rewards were ever
   on, set it off, wait until its last credited epoch has ended and its auditors have claimed it.
   Credits left on the old contract can't be paid afterwards, and the new results layer treats that
   budget as unclaimed.
2. **Verification owner:** approve every auditor that is approved on the old contract. Read them by
   replaying its `AuditorSet(address indexed auditor, bool approved)` events from block 53,419,391
   and keeping the last value per address; then for each approved one:

   ```solidity
   kbf.setAuditor(auditor, true);
   ```

   They can submit in the epoch they are approved.
3. **Points policy registry owner:** swap the policy (skip `removePolicy` if the old policy was never
   registered):

   ```solidity
   pointsPolicyRegistry.removePolicy(0xB252c8c9F5d74114ac525Ca8DBdBc5F028ec8C12); // old policy
   pointsPolicyRegistry.registerPolicy(verificationPointsPolicy);                // new policy
   ```

   Then set the new policy's rates (`setBonusBps`, `setPenaltyBps`) as they were on the old one.
4. **Verification owner:** turn rewards on from the launch epoch (at least the epoch after the
   deploy, when KBF's share applies):

   ```solidity
   results.setRewardsStartEpoch(kbf, epoch);
   ```

After a finished epoch, anyone can sweep its unclaimable part with `results.settleEpochRemainder(epoch)`.

## Configuration

- Use the canonical network `current.json` registry, identity registry, seller pools, usage
  accounting, and points policy registry. Usage accounting must point at the seller pools, the
  points policy registry, and a deployed emissions gate, and `registry.emissions()` must be the
  usage accounting contract.
- Set `VERIFICATION_OWNER` to the address of the wallet that deploys. It becomes the owner of all
  three contracts and does not need to own the protocol or points policy registry. Supply the
  matching wallet with `--signer verificationOwner=<spec>`. All three use `Ownable2Step`.
- Leave `VERIFICATION_AUDITORS` unset. M003 refuses to run when it is set: auditors are approved
  separately with `kbf.setAuditor` after the deploy.
- Optionally set `VERIFICATION_BONUS_BPS` (0 to 5000, default 0). It is fixed in the checkpoint;
  change it later with `setBonusBps`.
- Set the network RPC environment variable and `BASESCAN_API_KEY` as for M001/M002.

## Rollout

```bash
cd packages/contracts && forge build && cd ../..
pnpm contracts:deploy -- M003 --network base-mainnet --fork-test
pnpm contracts:deploy -- M003 --network base-mainnet --dry-run
pnpm contracts:deploy -- M003 --network base-mainnet --broadcast \
  --signer verificationOwner=account:antseed-verification-deployer
```

Then the manual steps above. Base Sepolia also supports `--dry-run` and `--broadcast`. These
commands are instructions, not evidence of a completed deployment.

The single phase is named `deploy` and runs `Deploy.s.sol`. Fork rehearsal uses the existing M001
fixture to prepare a disposable chain and verifies a repeated M003 apply is a no-op.

## Resume and records

The checkpoint saves the original deployment nonce, the three predicted CREATE addresses (results,
KBF audits, policy at N to N+2), owner, seller pools, usage accounting, points policy
registry, and bonus before broadcast, in `.deployments/m003-verification-split-<network>.json`
(not the earlier release's `m003-<network>.json`, which this release never reads; a checkpoint
without the split addresses stops the run). Keep the checkpoint and Foundry receipts until the history
record is committed. Resume with the same command: existing deployments are checked against the
local artifacts and their wiring; only the missing deployments and wiring are sent.

If a deployment is absent but its nonce has been consumed or is pending, the migration stops instead
of deploying at another address. Resolve the original transaction first.

Once all three deployments and the wiring are confirmed, the runner appends
`history/003-verification-split.json`, folds `contracts.verificationResults`,
`contracts.kbfAudits` and `contracts.verificationPointsPolicy` into
`current.json`, and generates `verificationContractAddress` (the KBF audits contract),
`verificationResultsAddress` and `verificationDeployBlock` for the SDK/CLI.
Explicit CLI overrides still take precedence.

M003 records the deployment and its own wiring only, not auditor approvals, the policy
registration, the minter controller or later governance changes.
