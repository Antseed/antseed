# M003 — Verification registry and points policy

Deploys `AntseedKbfVerification` and `AntseedKbfVerificationPointsPolicy`, and nothing else.
It approves **no** auditors and does **not** register the policy in the
`AntseedPointsPolicyRegistry`. Both are separate, manual owner steps after the deploy:
the verification owner approves each auditor with `setAuditor(auditor, true)`, and the
registry owner calls `registerPolicy(policy)`. Until then no audit can be submitted and
verdicts change no seller points. Approved auditors submit
one audit per model; each seller service gets `SAME`, `DIFF`, or `UNDETERMINED`.
It does not change emissions, staking, or
protocol registry pointers. M002 is not a prerequisite.

After M003:

- **Points change only through the rates.** Every settlement runs through the new
  policy. It scales seller points by `bonusBps` (from `VERIFICATION_BONUS_BPS`, default
  0; e.g. 100 = +1% per verified model, capped at +50% in total) and `penaltyBps`
  (uncapped, per DIFF model; starts at 0). With both at 0 no seller's points change.
  A rate set with `setBonusBps` or `setPenaltyBps` applies from the next settlement on;
  there is no separate start epoch, so announce rate changes to sellers before sending
  them. Setting both back to 0, or removing the policy from the registry, turns it off
  without a redeploy. A DIFF only affects its own model.
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
- Set `VERIFICATION_OWNER` to the address of the wallet that deploys. It becomes the owner of
  both new contracts and does not need to own the protocol or points policy registry. Supply
  the matching wallet with `--signer verificationOwner=<spec>` (keystore, Ledger, or unlocked
  signer). Both contracts use `Ownable2Step` if ownership should move later.
- Leave `VERIFICATION_AUDITORS` unset. M003 refuses to run when it is set: auditors are
  approved separately with `setAuditor` after the deploy.
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
  --signer verificationOwner=account:antseed-verification-deployer
```

After the broadcast, as separate manual steps:

- the verification owner approves each auditor: `setAuditor(<auditor>, true)`;
- the points policy registry owner registers the policy when points should start to count:
  `registerPolicy(<kbfVerificationPointsPolicy address>)`.

Base Sepolia also supports `--dry-run` and `--broadcast`. Review and commit
`pending/003-kbf-verification.plan.json` and its `.VALIDATION.md` before
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
pools, usage accounting, points policy registry, and per-model bonus before broadcast. Keep the checkpoint
and Foundry receipts until the history record is committed. Resume with the same
command: an existing deployment is checked against the local artifact, registry,
and owner; only the missing policy deployment is sent. Confirmed receipts are merged into
the checkpoint even if a later transaction or source verification fails.

If the deployment is absent but its nonce has been consumed or is pending, the
migration stops instead of deploying at another address. Resolve the original
transaction first. Missing creation provenance also stops the migration: restore
the original checkpoint/receipts rather than deleting them to start over.

Once both deployments are confirmed, the runner appends
`history/003-kbf-verification.json`, folds `contracts.kbfVerification` and
`contracts.kbfVerificationPointsPolicy` into `current.json`, and generates `verificationContractAddress` for the SDK/CLI.
Undeployed networks keep that optional address absent. Existing explicit CLI
overrides still take precedence. No existing history files are edited.

M003 records the deployment only, not auditor approvals, the policy registration or
later governance changes. Approve or revoke auditors with `setAuditor` and register or
remove the policy with the points policy registry owner directly.
