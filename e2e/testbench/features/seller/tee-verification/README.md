# tee-verification

A seller started with the antseed-verifier and a fake attestation collector: /_antseed/verification shows the verdict and the display state follows it.

Status: planned, no scenario yet.

## What to test

- TEE verification (apps/cli/src/proxy/tee-control.ts, tee-verification.ts, packages/antseed-verifier)
- buyer flags --verifiers and --require-verifier; an unverified pin is refused without payment

## What the testbench needs first

- a fake TDX collector
- verifier flags in the topology

Targets: local, fork. Capabilities: mockControl.
