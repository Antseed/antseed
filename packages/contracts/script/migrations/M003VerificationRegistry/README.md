# M003 — Verification registry and points policy

Deploys `AntseedKbfVerification` and `AntseedKbfVerificationPointsPolicy`, and nothing else.
It sets **no** publisher, verifiers or audited models, and does **not** register the
policy in the `AntseedPointsPolicyRegistry`. These are separate, manual owner steps after
the deploy (see [Post-deploy setup](#post-deploy-setup)). Until they are done no round can
run and verdicts change no seller points. Approved verifiers run one KBF round per epoch;
each audited seller service gets `SAME`, `DIFF`, or `UNDETERMINED` once a majority of the
epoch's verifiers attest the same results root. It does not change emissions, staking, or
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
- **Verifier rewards stay off.** Rounds record status but earn nothing until the
  verification owner calls `setRewardsStartEpoch(epoch)`. To launch rewards:
  1. The emissions-gate owner hands the verification bucket to the contract:
     `gate.setMinterController(keccak256("antseed.emissions.verification.v1"), verification)`.
  2. The verification owner calls `setRewardsStartEpoch` with the launch epoch. Rounds
     from that epoch on earn rewards; earlier epochs never claim past budgets.
  An epoch's budget is split into an attester pool (`attestRewardBps`, default 2,000 =
  20%), shared equally by the verifiers that attested the finalized root, and a collector
  pool shared by the slices each verifier delivered. Each verifier can claim at most
  `maxVerifierShareBps` of an epoch's budget (default 2,000 = 20%, owner-settable from 1
  to 10,000). Both values are fixed per epoch when it is opened, so a later change never
  alters what an earlier epoch pays, and budget above the cap is never minted.
- **The publisher is not a single point of failure.** If no plan is committed
  `publisherGraceSeconds` into an epoch (default 6 hours, owner-settable), any approved
  verifier can take the epoch over with its own bank (`takeOverBank`); `verifier start`
  does this in turns. Before its plan is accepted, the epoch publisher must escrow the
  bank key with the epoch's verifiers (`commitKeyShares`, a Feldman-verifiable Shamir split
  with the finalization majority as threshold), and the plan only takes effect once a majority of
  the epoch's verifiers other than the epoch publisher checked the plan, their envelopes, the bank
  and their key shares and accepted it (`acceptPlan`); until then the epoch can be taken over
  again (at most twice per verifier, never by its own publisher). so if the key is not revealed at the backup deadline, verifiers post their
  shares (`revealKeyShare`) and rebuild and reveal it themselves. Backups need no
  publisher step either: the plan already seals each verifier's backed-up slices, and
  backup verifiers buy the undelivered ones after the commit deadline.
- **Clearing is final for past results.** `clearServiceStatuses` also moves the
  service's `serviceResultsFrom` past the current epoch, so a finalized but unapplied
  result of that epoch or an earlier one can no longer bring the cleared verdict back.
- **Verdicts expire by epoch.** A SAME or DIFF counts for `validityEpochs` emissions
  epochs including the one it was given in (default 2; owner-settable from 1 to 4), and
  then drops out on its own. The latest epoch's finalized result sets the verdict,
  including UNDETERMINED, which clears an earlier SAME or DIFF; a late apply never
  overwrites a newer epoch's verdict. A bad round can be voided with `voidEpoch(epoch)`
  and its applied verdicts cleared with `clearServiceStatuses`.
- **The emissions gate is pinned.** The constructor reads the gate behind
  `registry.emissions()` (usage accounting's `emissionsGate()`) and keeps it for life,
  so verdict epochs never mix gates. A new gate needs a new verification deployment.

## M004 — the round contract on Base mainnet

Base mainnet already has release `003-kbf-verification`, which deployed the earlier
single-auditor contract (`submitModelAudit`). It doesn't have the round API, so the CLI
doesn't use its address as a default, and M003 can't redeploy over it: its resume check
compares the deployed code with the current artifact and refuses the mismatch.

M004 (`scripts/deployments/m004.mjs`) deploys the round contract and its points policy
under the new release `004-kbf-rounds`, with the same `Deploy.s.sol`, configuration and
signer as M003 (`M004` in place of `M003` in the [rollout](#rollout) commands). It then
becomes the current `kbfVerification`, and the `003-kbf-verification` history record is
kept as it was. M004 ignores the 003 receipts in `broadcast/`, but still refuses to
continue past a lost broadcast of its own. As with M003, it doesn't register the policy
in the points policy registry. After the deploy, regenerate the chain config so the CLI
picks up the new address, then do the [post-deploy setup](#post-deploy-setup) on the new
contract.

## Configuration

- Use the canonical network `current.json` registry, identity registry, seller pools,
  usage accounting, and points policy registry. The usage accounting contract must
  point at the seller pools, the points policy registry, and a deployed emissions gate,
  and `registry.emissions()` must be the usage accounting contract.
- Set `VERIFICATION_OWNER` to the address of the wallet that deploys. It becomes the owner of
  both new contracts and does not need to own the protocol or points policy registry. Supply
  the matching wallet with `--signer verificationOwner=<spec>` (keystore, Ledger, or unlocked
  signer). Both contracts use `Ownable2Step` if ownership should move later.
- Leave `VERIFICATION_AUDITORS` unset. M003 refuses to run when it is set: verifiers are
  approved separately with `setVerifier` after the deploy.
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

After the broadcast, finish the [post-deploy setup](#post-deploy-setup).

## Post-deploy setup

All calls are on `AntseedKbfVerification` from the verification owner, except the last.
`VERIFICATION` is its address.

1. **Publisher.** The address that runs `antseed verifier publish`:
   `setPublisher(address)`.
   ```bash
   cast send $VERIFICATION 'setPublisher(address)' <publisher> --account <owner>
   ```
2. **Verifiers.** Each address that runs `antseed verifier start`:
   `setVerifier(address verifier, bool approved)` (at most 64). An approval or removal
   takes effect from the next epoch opened; an open epoch keeps its snapshot. Each
   verifier then publishes its encryption key itself with `setEncryptionKey`, which
   `verifier start` does on first run.
   ```bash
   cast send $VERIFICATION 'setVerifier(address,bool)' <verifier> true --account <owner>
   ```
3. **Audited models.** The standing list each epoch audits:
   `setModels((bytes32 modelHash, string service)[])`, at most 64 entries, where
   `modelHash` must equal `keccak256(bytes(service))` and `service` is the lowercased
   audited model id (for example `claude-opus-5.5`). Each call replaces the list and bumps
   `modelsVersion`; an epoch audits the list in force when it opened.
   ```bash
   cast send $VERIFICATION 'setModels((bytes32,string)[])' \
     "[($(cast keccak claude-opus-5.5),claude-opus-5.5)]" --account <owner>
   ```
4. **Optional tuning.**
   - `setSchedule((uint32 collectSeconds, uint32 backupSeconds, uint32 attestSeconds, uint16 probesPerService, uint16 slicesPerService))`
     for epochs opened later. Defaults: 3 days collect, 1 day backup, 1 day attest, 100
     questions and 4 slices per seller service. The three windows together must fit in the
     emissions epoch, and `probesPerService` must be at least `slicesPerService`.
   - `setAttestRewardBps(uint16)` (default 2,000), `setMaxVerifierShareBps(uint16)`
     (default 2,000), both for epochs opened later; `setValidityEpochs(uint8)` (default 2,
     at most 4); `setPublisherGraceSeconds(uint32)` (default 6 hours), how long the
     publisher has to commit a plan before a verifier can take the epoch over.
   - `setRewardsStartEpoch(uint256)` once the verification bucket is handed over (see above).
5. **Points.** The points policy registry owner registers the policy when points should
   start to count: `registerPolicy(<kbfVerificationPointsPolicy address>)`.

The first round runs once the publisher has committed a bank for the current epoch and a
verifier opens it, before that epoch's collection window ends.

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

M003 records the deployment only, not the publisher, verifier approvals, the model list,
the policy registration or later governance changes. Make those calls directly, as in
[Post-deploy setup](#post-deploy-setup).
