# Contract deployment records

This directory is the canonical ledger of official AntSeed contract deployments.

Each network contains:

- `current.json`: the complete active contract set used by applications.
- `history/`: append-only records for executed deployments and cutovers.

## Rules

1. Never edit an executed history record. Correct mistakes with a new record.
2. Every production broadcast must produce a history record containing its transaction hashes, deployment blocks, source commit, constructor arguments, owners, and runtime code hashes.
3. Update `current.json` only after the new state is active and post-deployment checks pass.
4. Represent unknown historical values as `null`; never infer or invent provenance.
5. Migration scripts must assert their expected starting state before broadcasting.
6. Validate records with `node scripts/validate-contract-deployments.mjs`.
7. Mark contracts created by that record with `deployedInRelease: true`; only reconstructed legacy provenance may remain `null`.
8. Release-specific guarantees live in the owning migration's `recordErrors`, not in the shared validator.
9. Later phases of a multi-phase migration read their inputs from the committed history record of the earlier phase, and refuse to broadcast unless the local `forge build` matches the code deployed on chain.
10. Deployment records are created atomically and may never be overwritten, including by a resumed run.
11. Non-fork deployment phases require `BASESCAN_API_KEY` (an Etherscan V2 key) and submit source verification during broadcast.

`packages/node/src/payments/generated-contract-addresses.ts` uses each network's
`current.json` for active routing addresses and M001's deployed history record
for the optional `recognizedUsage` address inventory and effective epoch.
That inventory is marked `active` only when both committed emissions/staking
aliases point to the new stack; deployment or passage of time is insufficient.
A successful canonical migration regenerates it
automatically; `pnpm contracts:check` reports any stale generated output.

`M001RecognizedUsage` has two records because deployment and activation happen in separate epochs:

- `001-recognized-usage-deployed.json`
- `001-recognized-usage-activated.json`

`pnpm contracts:deploy -- M001 --network <network> --broadcast` creates these
records from Foundry receipts and validates them automatically.

M001 permits Base Sepolia and Base mainnet dry runs and broadcasts. Treat the
pinned Base-mainnet `--fork-test` as a required rehearsal before generating and
reviewing the production dry-run plan.

Use `--dry-run` to simulate only the next safe phase. Before the M001 boundary,
the cutover simulation forks the selected live RPC at its latest block, advances
only that disposable fork beyond the boundary, and executes the unchanged
Solidity script there. Use `--fork-test` with `BASE_MAINNET_RPC_URL` to run the
full deployment, advance Anvil across the boundary, perform cutover, validate
records, and verify that a repeated apply is a no-op.

## Reviewing a rollout

`--dry-run` writes two artifacts under `<network>/pending/` instead of only
printing to the terminal:

- `<release>.plan.json` — every transaction the phase intends to send, with
  decoded function signatures, arguments, and calldata, plus the protocol
  pointer changes it will make.
- `<release>.VALIDATION.md` — the human-reviewable rendering of that plan, with
  a reviewer checklist.

Commit both and make them the thing a reviewer approves; prose in a PR
description is not a substitute for the decoded transaction list. A successful
broadcast deletes the pending artifacts for that release, because the history
record then becomes the authority — `pending/` always means "reviewed but not
yet executed".

## Bytecode provenance

`pnpm contracts:check` rebuilds the contracts locally and, for every network
with an RPC URL set, compares the code deployed at each `deployedInRelease`
address against the local artifact (immutable slots masked). This depends on
`bytecode_hash = "none"` and `cbor_metadata = false` in
`packages/contracts/foundry.toml`: the Solidity default embeds a metadata digest
derived from absolute source paths, so identical source would otherwise produce
different runtime code on different machines. Contracts deployed before that
setting (the legacy baseline) are not compared.

## Validation

`scripts/validate-contract-deployments.mjs` checks every record in two layers:

1. The shared record shape, as plain assertions in the script. `schema.json`
   documents the same shape for editor tooling.
2. Invariants that apply only to the releases one migration owns, declared as
   `recordErrors(record)` on the migration. M001 proves the verification bucket
remains editable at 10%, that exactly one wash-trading points policy is registered, and that both
   administrative contracts have recorded owners.

## Commands

- `pnpm contracts:deploy -- ...` runs one migration phase.
- `pnpm contracts:snapshot` deliberately regenerates gas snapshots.
- `pnpm contracts:check -- <base-commit>` runs Forge and deployment-runner
  tests, validates records and generated config, verifies bytecode, and checks
  append-only history. Omit the base commit only when the history comparison is
  not applicable.

## Adding a migration

Migration modules live in `scripts/deployments/mNNN.mjs` and are listed
explicitly in `scripts/deployments/index.mjs`. A module declares *what* the
rollout is and lets `scripts/deployments/runtime/` handle *how* it executes —
dotenv loading, live-state observation, signer resolution, typed confirmation,
clean-tree enforcement, Foundry receipt parsing, record writing, and artifact
validation are all shared.

```js
export const migration = {
  id: 'M002',
  networks: ['base-sepolia'],
  releases: ['002-example'],          // releases this migration may write
  phases: [                           // first phase whose guard passes is run
    { id: 'deploy', guard: (observation) => observation.state === 'ready', signers: () => ['deployer'], run },
  ],
  expectedSigner,                     // role -> live owner address, for dry runs
  expectedState,                      // pointers read from current.json
  observe,                            // live RPC reads -> { state, ... }
  recordErrors,                       // release-specific invariants
  run: (options, overrides) => runMigration(migration, options, overrides),
};
```

The registry rejects a migration that declares no phases, a phase without an
`id`/`guard`/`run`, no releases, or a release another migration already claims.

M001 keeps its production flow in ordinary phase `run` functions: deployment
runs Forge and records the result; cutover uses explicit `try/finally` to
retain confirmed partial receipts before recording a successful activation.
Recovery checks live state and bytecode before repairing local records.

Shared helpers perform small data operations, not lifecycle callbacks:
`buildReleaseRecord` supplies standard ledger metadata; `mergeBroadcast`
deduplicates transaction hashes while retaining creation provenance;
`writeActivationRecords` checks history and `current.json` independently.
Checkpoints retain their existing keys so interrupted M001 runs remain resumable.

M001-specific Anvil fixtures and rehearsal assertions live in the local-test
section at the bottom of `scripts/deployments/m001.mjs` and execute only for
`--fork-test`. They run the same production phases; the shared framework still
owns Anvil, temporary deployment records, and prerequisite ordering.
