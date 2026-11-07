# verifier-kbf-audit

The mock answers audit probes wrong: the model verifier submits a DIFF verdict on-chain and routing cuts that seller to its penalty share.

Status: planned, no scenario yet.

## What to test

- KBF model audits, fingerprints, DIFF verdicts (apps/cli/src/verifier, packages/model-verifier, packages/fingerprints)
- verifier run, submit, check, rewards
- routing penalty after a DIFF

## What the testbench needs first

- verification contracts in the local chain setup
- reference answers and a probe set for the mock
- the verifier CLI driven from a scenario

Targets: local. Capabilities: mockControl, sourceContracts.
