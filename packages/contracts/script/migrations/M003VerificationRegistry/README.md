# M003 — Verification registry

Deploys PR #969's registry-only `AntseedVerification` and optionally approves an
initial verifier list. It does not change emissions, rewards, points policies,
staking, or protocol registry pointers. M002 is not a prerequisite.

## Configuration

- Use the canonical network `current.json` registry and identity registry.
- The live protocol registry owner signs deployment and becomes the verification
  owner directly. Supply `--signer verificationOwner=<spec>` using the existing
  keystore, Ledger, or unlocked signer support. No ownership handoff is needed.
- Optionally set `VERIFICATION_VERIFIERS` to comma-separated, nonzero verifier
  addresses in `packages/contracts/.env`. Omit it for an empty initial allowlist.
  Duplicate addresses are rejected. Review the list in the decoded dry-run plan.
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

The existing checkpoint facility saves the original deployment nonce, predicted
CREATE address, owner, and verifier list before broadcast. Keep the checkpoint
and Foundry receipts until the history record is committed. Resume with the same
command: an existing deployment is checked against the local artifact, registry,
and owner; only missing approvals are sent. Confirmed receipts are merged into
the checkpoint even if a later transaction or source verification fails.

If the deployment is absent but its nonce has been consumed or is pending, the
migration stops instead of deploying at another address. Resolve the original
transaction first. Missing creation provenance also stops the migration: restore
the original checkpoint/receipts rather than deleting them to start over. Changes
to the initial verifier list during recovery are rejected.

Once deployment and approvals are confirmed, the runner appends
`history/003-verification-registry.json`, folds `contracts.verification` into
`current.json`, and generates `verificationContractAddress` for the SDK/CLI.
Undeployed networks keep that optional address absent. Existing explicit CLI
overrides still take precedence. No existing history files are edited.

M003 records the initial approvals, not all future governance changes. Manage
subsequent verifier additions/revocations separately; do not change and reapply
the deployment's initial list as an administration mechanism.
