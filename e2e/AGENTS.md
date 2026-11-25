# @antseed/e2e

End-to-end tests and the testbench. Private, Node only. Four kinds live here, and `docs/testing.md` maps what each proves and when it runs: the vitest suite (`tests/`), the payment stress harness (`stress/`), the payment flow scripts (`scripts/`) and the worktree testbench (`testbench/`, reference in `testbench/README.md`). The testbench is opt-in (root `AGENTS.md`): run it only when the user or the task asks. The `verify-antseed` skill decides which scenario a change needs.

## Inside

- `tests/*.test.ts` — pairs of `AntseedNode`s over a private DHT (`tests/helpers/local-bootstrap.ts`), with mock providers and a mock JSON-RPC chain (`tests/helpers/payment-network.ts`).
- `global-setup.ts` — builds `@antseed/node` and `@antseed/cli` once before any test file.
- `scripts/full-payment-flow.mjs` is the CI payment-flow job; `stress/ci.mjs` the CI stress job.
- Where to add: a protocol behavior between two nodes is a `tests/<name>.test.ts` on `createLocalBootstrap()`. A money, routing or CLI-process path is a testbench scenario with `meta` and `topology`. A fixed bug is `scenarios/issues/issue-<N>-<slug>.mjs`. Names are unique across folders.
- What needs Foundry or an RPC: `tests/` needs nothing (some tests skip without their env); the scripts, `stress/` and testbench `--chain local` need `anvil` and `forge`; testbench `--chain fork` (the default) needs `BASE_MAINNET_RPC_URL`.

| Rule | Enforced by |
| --- | --- |
| Test files never build `node` or the CLI. Only `global-setup.ts` builds, once, before the forks start. | review only (`global-setup.ts` comment) |
| Nothing writes `packages/node/dist` or `apps/cli/dist` while e2e runs. Root `pnpm test` runs e2e after every other package, and CI runs it in its own job with `ANTSEED_E2E_SKIP_BUILD=1`. | root `package.json` `test`; `.github/workflows/ci.yml` `test-e2e` |
| Tests and testbench never touch `~/.antseed`, the keychain, port 8377 or the official bootstrap nodes. | testbench: `testbench/test/identity-isolation.test.mjs`, `env-options.test.mjs`; vitest suite: review only |
| A scenario leaves no reserve locked: it restarts each seller it stopped or closes that seller's channel. | `down` fails the run in teardown |
| Randomness in a scenario comes from `tb.prng(label)`, never `Math.random`. Changing `derive` or a label in `lib/prng.mjs` changes what every recorded seed means. | `testbench/test/prng.test.mjs`, `determinism.test.mjs` |

## Connections

- Tests import CLI source (`buyer-proxy.ts`, `plugins/registry.ts`), which imports `@antseed/node` subpaths from `dist/`: `node` must be built before the suite runs.
- Local chains deploy `packages/contracts` at fixed nonces; the addresses reach code through `getChainConfig('base-local')`. A contract or deploy-script change can break `stress/chain.mjs`, `testbench/lib/local-deploy.mjs` and `scripts/full-payment-flow.mjs`.
- CI jobs in `.github/workflows/ci.yml`: `test-e2e`, `e2e-payment`, `payment-stress` and `testbench` (a fixed list of scenarios with `--chain local --strict --seed`).

## Traps

- "does not provide an export named …" or "Unexpected end of input" means something rebuilt `node` or CLI `dist/` under a running test. Do not run e2e beside another package's tests or a build; rerun it alone.
- The e2e `test` rebuilds `node` and the CLI first. `ANTSEED_E2E_SKIP_BUILD=1` skips that; a stale `dist/` then tests old code.
- Testbench `up` refuses a Node major other than 24: native modules would not load.
- `forge install foundry-rs/forge-std` ignores the pin and rewrites `packages/contracts/foundry.lock`. Restore it before you commit.
- Anvil-signed testbench sends state zero fees explicitly, and local deploys use `forge script --slow`; both work around Anvil bugs (`testbench/README.md`).
- Testbench state needs hard links: point `ANTSEED_TESTBENCH_HOME` at a local disk, never inside `~/.antseed`. One left up with `up` or `--keep` stays until idle: run `pnpm testbench down`.
- Do not read testbench exit codes through `pnpm -s` (every nonzero exit becomes 1). Read `result` in `report.json`.
- `stress/chain.mjs` names its Anvil `antseed-stress-chain`, so a `pkill -f anvil` meant for another chain does not kill it, and the reverse.
- There is no `typecheck` script, so nothing type-checks `tests/`; vitest strips types. `README.md`'s Dependencies section is stale; trust `package.json`.

**Ask first:** any run with `--live`, `--real-funds` or `--chain mainnet` (a yes each time); changing `lib/prng.mjs` labels or `derive`; removing a CI-run scenario or loosening `--strict`, a `GATES` value in `stress/ci.mjs` or a budget.

**Prove it:** `pnpm --filter @antseed/e2e run test` (alone, nothing else building). Testbench code: `pnpm test:testbench` at the root. A changed scenario: `pnpm testbench run <scenario> --chain local --strict`, and quote `result` and the seed from `report.json`.
