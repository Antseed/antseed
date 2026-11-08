# Testing

This is the map of AntSeed's tests: what each kind proves, where it lives and when it runs. Which test a given change needs is decided by the `verify-antseed` skill (`.claude/skills/verify-antseed/SKILL.md`).

| Kind | Where it lives | What it proves | When it runs | Typical time |
| --- | --- | --- | --- | --- |
| Unit | each package's tests (`pnpm -r run test`), contracts in `packages/contracts` (`forge test`) | one package's behavior, contract logic | every PR | seconds to minutes per package |
| In-process e2e | `e2e/tests/*.test.ts` | protocol behavior between node pairs over a private DHT | every PR | about 10 minutes |
| Testbench functional, `sdk` mode | `e2e/testbench/scenarios/`: `chat-basic`, `routing-smoke`, `payment-flow`, `issue-1200-spendingauth-catchup` (their topologies default to `sdk`) | money and routing paths, using internal hooks into the buyer and seller | every PR, in the CI `testbench` job (with `--strict`) | 10 s to 1 min per scenario |
| Testbench functional, `cli` mode | `cli-buyer-commands`, `buyer-withdraw-and-exit`, `free-tier` and `issue-1050-stale-channel` (cli by default); the `sdk` scenarios above with `--mode cli`, except `issue-1200-spendingauth-catchup` | the same paths through the real `antseed` processes, with process lifecycle and plugin loading included | by hand; no CI job runs a functional scenario in `cli` mode yet | not measured yet |
| Testbench stress, `cli` mode | `e2e/testbench/scenarios/stress/` | exact payment under load, faults and restarts, with seeds; also speed: latency percentiles, throughput and settle times against `topology.budgets` with `--budgets`, and drift against the previous run | `stress-smoke` on every PR in the `testbench` job (`cli` mode, with `--strict`); the rest by hand until a nightly job exists | `stress-smoke` about 35 s, `stress-faults` about 1 min |
| Issue regressions | `e2e/testbench/scenarios/issues/` | a fixed bug stays fixed, red to green | every PR for `issue-1200-spendingauth-catchup`, in the `testbench` job. `issue-1050-stale-channel` runs by hand until a nightly job exists | 1 to 2 min per scenario |
| Desktop | `e2e/testbench/scenarios/desktop-*.mjs` under Playwright | the UI against a real buyer | on demand; on Linux under `xvfb-run`. Not in CI yet (the `testbench` job lists what it needs) | about 20 s |
| Mixed version | planned | this buyer against the last release's seller, and the reverse | planned weekly | not built yet |
| Live network | `e2e/testbench/scenarios/mainnet-smoke.mjs` | this worktree's buyer against live sellers, with real funds | weekly with a human yes | not measured: it has never run funded |
| Manual drivers | `scripts/gateway-console-smoke.mjs`, the ANTS browser scripts (`scripts/ants-browser-*.mjs`) | flows nothing else drives yet | by hand | varies |

The first `--chain local` run in a worktree also compiles `packages/contracts` (about 2.5 minutes).

## `sdk` mode or `cli` mode

- The test depends on process lifecycle, CLI output, plugin loading or two builds: use `cli` mode.
- It needs a hook into the buyer or seller object: use `sdk` mode.
- Everything else defaults to `cli` mode.

A scenario's topology picks its mode: `stressTopology()` and the CLI scenarios use `cli`, the others `sdk`. `--mode` overrides it, and `report.json` says which mode a run used.

A testbench whose `pnpm testbench run` was killed stops on its own within about 30 seconds (the supervisor's watchdog, `e2e/testbench/README.md` Isolation). One left up with `up` or `--keep` stops after `ANTSEED_TESTBENCH_IDLE_MINUTES` (default 120) without a control request.

## Seeds and reruns

Every `pnpm testbench run` and `up` has one run seed, an integer from 0 to 4294967295. It is random unless you pass `--seed N`. It is recorded in the manifest and in `report.json`, shown in `index.html` and `pnpm testbench status`, and printed at the end of each run.

Any result other than `passed` prints the line to copy:

```text
[testbench] rerun: pnpm testbench run stress-faults --chain local --seed 1234567
```

The seed fixes everything the testbench draws. `derive(seed, label)` in `e2e/testbench/lib/prng.mjs` turns it into one stream per label:

| Label | Stream |
| --- | --- |
| `mock:<sellerId>` | a seller mock's latencies, completion tokens and fault decisions, drawn per request tag |
| `load` | the tags and shapes of `tb.load` requests, drawn per request index |
| `warm-up` | the warm-up request's tag |
| `rpc:seller:<sellerId>`, `rpc:buyer` | the Base-like RPC proxies' slow, stale and rate-limit decisions |

Changing `derive` or a label changes what every recorded seed means, so a unit test pins them.

What a seed replays:

- Run `stress-smoke` or `stress-faults` twice with `--seed 7` and the mock ledgers match: the same tags, token counts, costs and injected faults in `metrics.json` (`deliveries`). The draws belong to a tag or an index, so they do not depend on the order concurrent requests arrive in.
- Wall-clock timing does not replay. The seed is not a deterministic scheduler: peers, chain blocks and the network still race, and the RPC proxies take their draws in call order. A failure that needs a particular race may take several reruns.
- A seed replays a run that started its own testbench. A running testbench keeps the seed it started with, and `run` warns if `--seed` asks for another. Later runs on it (`run --keep`, then `run`) report that seed and draw their own streams, because the mocks remember earlier tags. To replay one of those, start from a fresh testbench.

CI derives its seed from the commit: the first 8 hex digits of `github.sha` as a decimal.

## Result classes and exit codes

`report.json` has one `result`, and `pnpm testbench run` exits with its code:

| `result` | Exit | Meaning | What to do |
| --- | --- | --- | --- |
| `passed` | 0 | Every check held. | Nothing. |
| `failed` | 1 | A check failed (`tb.check`, an assertion, a known issue under `--strict`), including a failed check the scenario caught itself. | The change or the code under test is wrong. Read the check's `detail`. |
| `blocked` | 2 | `up` or a precondition refused before the scenario started: Node major, build, Foundry, ffmpeg, an unknown scenario or a scenario that does not support the chain, a missing RPC. | Fix the environment. It says nothing about the code. |
| `timeout` | 3 | The scenario ran past `--run-timeout` (default 1800 seconds). The report has a failed check named `run timeout`. | Look for a hang. |
| `error` | 4 | The scenario threw something else (a failed chat, a wait that ran out, the control API), or teardown failed after a pass (including a `down` that reported shutdown errors or left buyer reserve locked). | The run broke before it reached a verdict. Read `error` and the logs. |

Every result writes `report.json`, with `seed`, `mode`, `git: { sha, branch, dirty }`, `node` and `durationMs`. Any result but `passed` also has `phase` (`up`, `scenario` or `teardown`). A teardown failure after a failed scenario keeps the scenario's result and adds `teardownError`.

A command line the CLI rejects (a bad flag, for example) exits 1 with no report. Do not read exit codes through `pnpm -s`: its silent mode turns every nonzero exit into 1. Use `pnpm testbench`, or read `result` from `report.json`.

## Retiring `e2e/stress` and `e2e/scripts/full-payment-flow.mjs`

Both stay in CI as the non-regression baseline (the `payment-stress` and `e2e-payment` jobs). They retire when:

- the `cli`-mode stress set has passed nightly for a week with identical gates, and
- `payment-flow` in `cli` mode runs on every PR.
