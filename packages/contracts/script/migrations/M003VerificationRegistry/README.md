# M003 — Verification registry and points policy

Deploys `AntseedVerification` and `AntseedVerificationPointsPolicy`, registers the
policy in the existing `AntseedPointsPolicyRegistry` (after the wash-trading
policy), and optionally approves an initial auditor list. Approved auditors submit
one audit per model; each seller service gets `SAME`, `DIFF`, or `UNDETERMINED`
(see `docs/protocol/verification.md`). It does not change emissions, staking, or
protocol registry pointers. M002 is not a prerequisite.

After M003:

- **Points policy starts off.** Every settlement runs through the new policy, but no
  seller's points change until the policy owner calls `setPointsStartEpoch(epoch)`
  (default `type(uint256).max` = off; setting it back to that turns it off again), so
  sellers have time to adjust. The epoch comes from the verification contract's pinned
  emissions gate. Tune it with `setBonusBps` (e.g. 100 = +1% per verified model, capped
  at +50% in total) and `setPenaltyBps` (uncapped, per DIFF model; starts at 0). A DIFF
  only affects its own model.
  Removing the policy from the registry also turns it off without a redeploy.
- **Auditor rewards stay off.** Audits record status but earn no credits until the
  verification owner calls `setRewardsStartEpoch(epoch)`. To launch rewards:
  1. The emissions-gate owner hands the verification bucket to the contract:
     `gate.setMinterController(keccak256("antseed.emissions.verification.v1"), verification)`.
  2. The verification owner calls `setRewardsStartEpoch` with the launch epoch. Audits
     from that epoch on earn credits; earlier audits never claim past budgets.
  Each auditor can claim at most `maxAuditorShareBps` of an epoch's verification budget
  (default 2,000 = 20%, owner-settable from 1 to 10,000). The cap in force at claim time
  applies, and budget above it is never minted.
- **Verdicts expire by epoch.** A SAME or DIFF counts for `validityEpochs` emissions
  epochs including the one it was given in (default 2; owner-settable from 1 to 4), and
  then drops out on its own. The latest result from a single auditor sets the verdict,
  including UNDETERMINED, which clears an earlier SAME or DIFF. Auditors double-check
  DIFF results off-chain before submitting.
- **The emissions gate is pinned.** The constructor reads the gate behind
  `registry.emissions()` (usage accounting's `emissionsGate()`) and keeps it for life,
  so verdict epochs never mix gates. A new gate needs a new verification deployment.

## Configuration

- Use the canonical network `current.json` registry, identity registry, seller pools,
  usage accounting, and points policy registry. The usage accounting contract must
  point at the seller pools, the points policy registry, and a deployed emissions gate,
  and `registry.emissions()` must be the usage accounting contract.
- The live protocol registry owner signs deployment and becomes the owner of both
  new contracts directly. It must also own the points policy registry, since it
  registers the policy. Supply `--signer verificationOwner=<spec>` using the existing
  keystore, Ledger, or unlocked signer support. No ownership handoff is needed.
- Optionally set `VERIFICATION_AUDITORS` to comma-separated, nonzero auditor
  addresses in `packages/contracts/.env`. Omit it for an empty initial allowlist.
  Duplicate addresses are rejected. Review the list in the decoded dry-run plan.
- Optionally set `VERIFICATION_BONUS_BPS` (0 to 5000, default 0).
  It is fixed in the checkpoint; change it later with `setBonusBps`.
- Set the network RPC environment variable and `BASESCAN_API_KEY` as for M001/M002.
  Non-fork broadcasts submit source verification through the existing runner.

## Rollout

```bash
cd packages/contracts && forge build && cd ../..
pnpm contracts:deploy -- M003 --network base-mainnet --fork-test
pnpm contracts:deploy -- M003 --network base-mainnet --dry-run
pnpm contracts:deploy -- M003 --network base-mainnet --broadcast \
  --signer verificationOwner=account:antseed-owner
```

Base Sepolia also supports `--dry-run` and `--broadcast`. Review and commit
`pending/003-verification-registry.plan.json` and its `.VALIDATION.md` before
broadcasting from a clean tree. These commands are instructions, not evidence of
a completed deployment.

The single phase is named `deploy` and runs `Deploy.s.sol`. Fork rehearsal uses
the existing M001 fixture to prepare a disposable chain and verifies a repeated
M003 apply is a no-op; this is not a live M001/M002 activation requirement.
M003 rehearsal broadcasts live under the temporary rehearsal receipt directory,
so they cannot overwrite production receipts or block the subsequent live run.

## Resume and records

The existing checkpoint facility saves the original deployment nonce, both predicted
CREATE addresses (verification at the nonce, policy at the nonce + 1), owner, seller
pools, usage accounting, points policy registry, per-model bonus, and auditor list
before broadcast. Keep the checkpoint
and Foundry receipts until the history record is committed. Resume with the same
command: an existing deployment is checked against the local artifact, registry,
and owner; only the missing policy deployment, approvals, and registration are sent. Confirmed receipts are merged into
the checkpoint even if a later transaction or source verification fails.

If the deployment is absent but its nonce has been consumed or is pending, the
migration stops instead of deploying at another address. Resolve the original
transaction first. Missing creation provenance also stops the migration: restore
the original checkpoint/receipts rather than deleting them to start over. Changes
to the initial auditor list during recovery are rejected.

Once deployment and approvals are confirmed, the runner appends
`history/003-verification-registry.json`, folds `contracts.verification` and
`contracts.verificationPointsPolicy` into `current.json`, and generates `verificationContractAddress` for the SDK/CLI.
Undeployed networks keep that optional address absent. Existing explicit CLI
overrides still take precedence. No existing history files are edited.

M003 records the initial approvals and registration, not all future governance
changes. Removing the policy from the registry after activation makes a re-run stop
instead of re-registering it. Manage
subsequent auditor additions/revocations separately; do not change and reapply
the deployment's initial list as an administration mechanism.
