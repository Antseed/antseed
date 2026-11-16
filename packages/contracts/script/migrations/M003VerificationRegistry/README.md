# M003 — Verification contracts

Deploys the verification contracts, and nothing else outside them:

| Nonce | Contract | Constructor |
|---|---|---|
| N | `AntseedVerificationResults` | `(emissionsGate)` |
| N+1 | `AntseedKbfAudits` | `(results, sellerPools, identityRegistry)` |
| N+2 | `AntseedVerificationPointsPolicy` | `(results, usageAccounting, bonusBps, owner)` |

N is `VERIFICATION_DEPLOYMENT_NONCE`, the deployer's next nonce. All three are deployed from
`VERIFICATION_OWNER`, which owns them. The results layer takes the emissions gate directly (read
from usage accounting's `emissionsGate()`, which must be the gate behind `registry.emissions()`); it
has no protocol registry dependency. In the same broadcast the script then does the wiring the
verification owner can do on its own:

- `results.setAudit(kbf, true)`: the KBF audit may record verdicts and grant credits;
- `results.setAuditShareBps(kbf, 10_000)`: KBF gets the whole verification bucket until a second
  verification method is added. Share changes apply from the next epoch, so KBF's share starts the
  epoch after the deploy; the deploy epoch's bucket (if the results layer already controls it) is
  never minted.

It approves **no** auditors, does **not** register the policy in the `AntseedPointsPolicyRegistry`,
and does not touch the emissions gate, staking, or protocol registry pointers. M002 is not a
prerequisite. After the broadcast it checks the deployed wiring, including that KBF's
`validityEpochs` is the default 2.

## What the contracts do

Readers (the points policy, the node, dashboards) read **one** contract, the results layer, whatever
method produced a verdict. A verification method is an *audit* contract approved on the results
layer, with its own consensus, its own share of the reward bucket and its own say over how long its
verdicts count; KBF (`AntseedKbfAudits`) is the first. The owner approves KBF auditors on
`AntseedKbfAudits` itself (`setAuditor`). A KBF audit with another admission rule (a council, a
stake-based set) is a new audit on the same results layer, so readers and the reward bucket stay
put.

- **Points change only through the rates.** Once registered, the policy scales seller and buyer points
  by `bonusBps` (from `VERIFICATION_BONUS_BPS`, default 0; e.g. 100 = +1% per verified service, capped
  at +50% in total) and `penaltyBps` (uncapped, times the square of the DIFF services; starts at 0; e.g. 400 = -4% for one
  DIFF, -16% for two, -100% for five). With both at 0 no
  points change. A rate set with `setBonusBps` or `setPenaltyBps` applies from the next
  settlement on. A DIFF only affects its own service. The multiplier comes from the seller's verdicts,
  and a buyer's points on that seller's settlements get the same one.
- **Verdicts expire by epoch, as the audit decides.** Every recorded verdict carries the epoch it
  stops counting in (`validUntilEpoch`, at most `MAX_VERDICT_EPOCHS` = 52 ahead), and the results
  layer counts it while `currentEpoch < validUntilEpoch`. KBF sets it from its own
  `kbf.validityEpochs` (default 2, including the epoch the verdict is given in; owner-settable from
  1 to 4 with `setValidityEpochs`). A change applies to verdicts recorded afterwards; recorded
  verdicts keep their expiry.
- **A DIFF needs a second auditor.** `kbf.requiredReports` sets how many distinct approved auditors
  must report a verdict before it is recorded: SAME 1, DIFF 2, UNDETERMINED 1
  (`setRequiredReports`). Until a second auditor confirms it, a DIFF only waits.
- **The latest verdict from any audit wins.** The results layer does not judge what an audit
  records. Within KBF, replacing a live DIFF (from any audit) needs `kbf.diffReplacementReports`
  reports (default 1, so one SAME is enough; the owner can raise it with
  `setDiffReplacementReports`). A second audit added later can overwrite KBF's verdicts, so it must
  bring its own rules for that. The owner can reset services with `results.clearServiceStatuses`;
  KBF then drops reports made before the clear.
- **Rewards stay off** until `results.setRewardsStartEpoch(kbf, epoch)`. Each model audit that covers
  a staked seller earns `kbf.creditsFor(modelHash)` credits: `kbf.creditsPerAudit` (default 1,
  `setCreditsPerAudit`) unless the model has its own amount (`setModelCreditsPerAudit(modelHash,
  n)`; 0 = the default), for at most `kbf.maxCreditsPerModelPerEpoch` audits per model (default 1)
  and `results.maxCreditsPerAuditorPerEpoch(kbf)` credits per auditor and epoch (default 100). A
  finished epoch's KBF share is split by credits; each auditor gets at most
  `maxAuditorShareBps(kbf)` of it (default 2,000 = 20%) and the rest of its reward goes to the
  emissions reserve in the same claim. Auditors claim one epoch per call with
  `results.claimAuditorReward(kbf, epoch)` (`antseed verifier rewards --claim` sends one
  transaction per epoch), after `results.pendingAuditorReward(kbf, auditor, epoch)`. The owner can
  `pause` / `unpause` claims.
- **Unclaimed budget stays unminted.** There is no remainder settlement and no credit voiding:
  budget no auditor claims (an epoch without credits, share assigned to no audit, a claim never
  made) is simply never minted from the gate.
- **Auditors can publish a profile.** `kbf.setAuditorProfile(name, iconUri, url)` (`antseed verifier
  profile`) stores a display name and `https://` / `ipfs://` links for UIs.
- **The emissions gate is pinned.** The results constructor takes the gate and keeps it for life.

## Replacing the earlier M003 deployments

M003 first deployed a single `AntseedKbfVerification` (Base mainnet
`0x4BdAfcc48cc61Aaf1ed2f5EbaCc05Ee305C80916`, deploy block 53,419,391, policy
`0xB252c8c9F5d74114ac525Ca8DBdBc5F028ec8C12`; release `003-kbf-verification`), then the split
results layer and KBF audit as release `003-verification-split` (source commit `9152657b3`, blocks
53,490,135–53,490,139): `AntseedVerificationResults` `0xF2C8482aD2A348854698E93f41FE3cc32307687c`,
`AntseedKbfAudits` `0xe57aB03423A3835571F7d68AC1E23CF8a2763343`, `AntseedVerificationPointsPolicy`
`0x5d677f5eDd69E69c664E3f7FA80f1D3DD61A2212`, with KBF wired at 10,000 bps and two auditors
approved. Its minter controller never moved, its policy was never registered and its rewards were
never turned on.

The contracts in this tree are **not compatible** with that deployment (new constructors, audit
setters, `record` with `validUntilEpoch`, one-epoch claims, no remainder settlement, changed
events), so M003 deploys them again as a new release, `003-verification-audits`. Deployment history
is append-only: the earlier records (`history/003-kbf-verification.json`,
`history/003-verification-split.json`) stay as they are and no migration owns them any more; on
activation the new release's contracts replace `contracts.verificationResults`,
`contracts.kbfAudits` and `contracts.verificationPointsPolicy` in `current.json` (the earlier
addresses keep `deployedInRelease: false`), and `verificationConfiguration` is replaced. The SDK and
CLI default to the new release's `kbfAudits` and `verificationResults`. On Base mainnet the
`003-verification-audits` release is deployed and active (source commit `c05e364c9`, deployer
nonces 10,356–10,360, blocks 53,514,466–53,514,470): `AntseedVerificationResults`
`0x139ab1722a62a23371f491220902c460E9fAeAb2`, `AntseedKbfAudits`
`0x86B92DC48EF7c5a12de6e44409E83C8EF36657Ff`, `AntseedVerificationPointsPolicy`
`0x4B586d4361783e9798881DC32c78Cf595a923095`, with KBF wired at 10,000 bps and auditors 1 and 2
approved again on the new KBF contract. The old contracts stay
on-chain unused. That release's policy was never registered: release `003-verification-policy`
replaced it with `0xD58393a752b3b7bdBea6231E0e24C11403e9f32f` (see
[Replacing only the points policy](#replacing-only-the-points-policy)), set `penaltyBps` 400 and
`bonusBps` 200, and registered it.

**Nothing carries over.** Verdicts, report tallies, credits and auditor approvals live in the old
contracts. Their verdicts expire within 2 epochs; readers of the old results layer keep seeing them
until then. Auditors are approved again on the new KBF contract (step 2). Until the new deployment
is recorded, the SDK and CLI still default to the `003-verification-split` addresses, which this
client can't fully read (set `payments.crypto.verificationContractAddress` to the new
`AntseedKbfAudits` to use it earlier).

## Manual owner steps after the broadcast, in order

The script does none of these. Until they are done no audit can be submitted (no approved
verifiers), verdicts change no points (the policy is not registered), and audits earn no credits
(rewards are off).

1. **Emissions gate owner:** hand the verification bucket to the new results layer. M001 registered
   the bucket as minter `keccak256("antseed.emissions.verification.v1")` (`setMinter(id,
   VERIFICATION_WALLET, 10_000, true)`, editable); its controller is whoever holds it now
   (`VERIFICATION_WALLET` on Base mainnet at the time of writing: it was never moved to the
   `003-verification-split` results layer):

   ```solidity
   gate.setMinterController(keccak256("antseed.emissions.verification.v1"), results);
   ```

   `gate.claim` then accepts claims from `results` only, for every epoch. If the controller was
   moved to an earlier verification contract whose rewards were ever on, set its
   `rewardsStartEpoch` off first, wait until its last credited epoch has ended and its auditors
   have claimed it. Credits left on an old contract can't be paid afterwards; the new results layer
   never mints that budget.
2. **Verification owner:** approve every auditor that is approved on the old KBF contract. Read
   them by replaying its `AuditorSet(address indexed auditor, bool approved, uint256 revocations)`
   events from block 53,490,136 (`0xe57aB03423A3835571F7d68AC1E23CF8a2763343`) and keeping the
   last value per address; then for each approved one:

   ```solidity
   kbf.setAuditor(auditor, true);
   ```

   They can submit in the epoch they are approved.
3. **Points policy registry owner:** register the policy (and remove an earlier verification policy
   first if one is registered; none of the earlier M003 policies was on Base mainnet at the time of
   writing):

   ```solidity
   pointsPolicyRegistry.removePolicy(oldPolicy);                 // only if registered
   pointsPolicyRegistry.registerPolicy(verificationPointsPolicy); // new policy
   ```

   Then set the new policy's rates (`setBonusBps`, `setPenaltyBps`) as intended.
4. **Verification owner:** turn rewards on from the launch epoch (at least the epoch after the
   deploy, when KBF's share applies):

   ```solidity
   results.setRewardsStartEpoch(kbf, epoch);
   ```

Optionally, the verification owner tunes KBF afterwards: `kbf.setValidityEpochs`,
`kbf.setCreditsPerAudit`, `kbf.setModelCreditsPerAudit`, `kbf.setRequiredReports`,
`kbf.setDiffReplacementReports`.

## Replacing only the points policy

M003 deploys its three contracts together, so a policy change that leaves the results layer and the
KBF audit in place uses `script/DeployVerificationPointsPolicy.s.sol` instead. It deploys one
`AntseedVerificationPointsPolicy`, owned directly by `POLICY_OWNER` (no `acceptOwnership`), with
`penaltyBps` 0 and nothing registered; verdicts change no points until the registry owner registers it.

```bash
cd packages/contracts
export EXPECTED_CHAIN_ID=8453 POLICY_OWNER=<owner> \
  VERIFICATION_RESULTS=<current.json verificationResults> KBF_AUDITS=<current.json kbfAudits> \
  USAGE_ACCOUNTING=<current.json usageAccounting> POINTS_POLICY_REGISTRY=<current.json pointsPolicyRegistry>
forge script script/DeployVerificationPointsPolicy.s.sol --rpc-url "$RPC_URL" --sender "$POLICY_OWNER"
# then add: --broadcast --verify --account <name>
```

Then, in order: set the new policy's rates with `setPenaltyBps` / `setBonusBps`, remove any earlier
verification policy from the registry, and register the new one. Set the rates first, so no settlement
sees the policy without them.

Record the deployment by hand: add a new append-only history record for the release, replace
`contracts.verificationPointsPolicy` and `verificationConfiguration.verificationRegistry.policyAddress`
in `current.json`, and run `node scripts/validate-contract-deployments.mjs`. Clients don't read the
policy address, so no package release depends on it.

## Configuration

- Use the canonical network `current.json` registry, identity registry, seller pools, usage
  accounting, points policy registry and emissions gate. Usage accounting must point at the seller
  pools, the points policy registry, and the emissions gate; `registry.emissions()` must be the
  usage accounting contract and `registry.identityRegistry()` the identity registry.
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
KBF audits, policy at N to N+2), owner, registry, identity registry, seller pools, usage accounting,
points policy registry, emissions gate and bonus before broadcast, in
`.deployments/m003-verification-audits-<network>.json` (not the earlier releases'
`m003-<network>.json` or `m003-verification-split-<network>.json`, which this release never reads; a
checkpoint without this release's addresses stops the run). Keep the checkpoint and Foundry receipts
until the history record is committed. Resume with the same command: existing deployments are
checked against the local artifacts and their wiring (gate, results, seller pools, identity
registry, usage accounting, `isAudit`, the KBF share); only the missing deployments and wiring are
sent.

If a deployment is absent but its nonce has been consumed or is pending, the migration stops instead
of deploying at another address. Resolve the original transaction first.

Once all three deployments and the wiring are confirmed, the runner appends
`history/003-verification-audits.json`, folds `contracts.verificationResults`,
`contracts.kbfAudits` and `contracts.verificationPointsPolicy` into
`current.json`, and generates `verificationContractAddress` (the KBF audits contract),
`verificationResultsAddress` and `verificationDeployBlock` for the SDK/CLI.
Explicit CLI overrides still take precedence.

M003 records the deployment and its own wiring only, not auditor approvals, the policy
registration, the minter controller or later governance changes.
