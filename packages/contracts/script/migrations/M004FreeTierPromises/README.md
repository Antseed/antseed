# M004 — Staked free-tier promise board

Deploys one contract and wires nothing:

| Nonce | Contract | Constructor |
|---|---|---|
| N | `AntseedFreeTierTerms` (the board) | `(registry, emissionsGate, identityRegistry)` |

N is `FREE_TIER_DEPLOYMENT_NONCE`, the next nonce of `FREE_TIER_DEPLOYER`. The deployer gets no rights:
the board has no owner, holds no funds and changes no points.

## What the board does

A seller publishes, per agent, the free tier it promises to stakers (programs of tiers and models) and
the notice it gives before changing it (2 to 104 epochs).

- A first promise starts next epoch. A later change starts after the live notice (at least 2 epochs);
  a change with the same start as the last scheduled one replaces it. Terms for any epoch up to
  `promisedThrough(agentId)` never change.
- `setTerms(agentId, terms, maxFromEpoch)` reverts when the computed start is later than
  `maxFromEpoch`, the latest start the writer agreed to.
- Writers: the agent's registered seller (`registry.staking().getAgentId`), its ERC-8004 owner, or an
  operator of an owner contract (a gas-capped `isOperator` call that fails closed).
- Reads: `termsAt`, `programFor`, `nextChangeAfter`, `promisedThrough`, `scheduleLength`, `entryAt`.
  Nodes and apps rebuild everything from these, with no event indexer.

The board only records promises. Seller nodes follow it and apps show it in later changes.

## Configuration

Use the network's `current.json` registry, identity registry, seller registry, usage accounting and
emissions gate. The script checks before deploying that the registry's identity registry, staking
(the seller registry) and emissions (usage accounting) match, that the seller registry uses the same
identity registry, and that usage accounting's gate is the one given. Set `FREE_TIER_DEPLOYER` to the
deploying wallet and supply it with `--signer freeTierDeployer=<spec>`.

## Rollout

These commands are instructions, not evidence of a deployment. A broadcast needs an explicit go.

```bash
cd packages/contracts && forge build && cd ../..
pnpm contracts:deploy -- M004 --network base-mainnet --fork-test
pnpm contracts:deploy -- M004 --network base-mainnet --dry-run
pnpm contracts:deploy -- M004 --network base-mainnet --broadcast \
  --signer freeTierDeployer=account:<deployer>
```

The runner records `history/004-free-tier-promises.json`, adds `freeTierTerms` to `current.json` with
no owner, and keeps its configuration under `verificationConfiguration.freeTierPromises`. Clients get
the address only once the ledger is committed and a release carries it.

## Resume

The checkpoint `.deployments/m004-free-tier-promises-<network>.json` saves the nonce, the predicted
address and the baseline before the broadcast. Resume with the same command: a deployed board is
checked against the local artifact and its wiring. If the nonce was used by something else, the
migration stops instead of deploying elsewhere.
