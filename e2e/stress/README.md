# Payment stress

Runs the real CLI seller (`antseed seller start`) and buyer proxy (`antseed buyer start`) against the repo's contracts on anvil, under concurrent paid traffic, and checks that every delivered request is paid for exactly. It guards the payment-channel fixes in #1400, #1403, #1404 and #1405, and the stale-channel fix for #1050.

Each run starts fresh:
- an anvil chain with the contracts deployed, the seller registered and staked, and the buyer's deposit in place;
- the top-up threshold set to Base's 65% (`TOPUP_THRESHOLD_BPS` to change it);
- a mock OpenAI-compatible upstream that returns realistic token usage, with optional faults;
- a local DHT bootstrap node. The official bootstrap list is cleared, so nothing leaves the machine.

By default (`--rpc base`), each peer reaches the chain through its own proxy that behaves like a public Base RPC:
- 2 s blocks;
- 120–400 ms per call, with a 5% tail of 1–2.5 s;
- 12 calls/s per client with a burst of 25, answered with HTTP 429 above that;
- for 4 s after any transaction, 35% of reads come from the previous block and 40% of receipt lookups return nothing.

`--rpc anvil` talks to anvil directly instead.

## Checks

After the load, the harness closes every channel and compares the seller's and buyer's stores, the chain, and what the mock upstream actually delivered (`analysis.mjs`, unit-tested in `e2e/tests/stress-analysis.test.ts`). A run fails on any of these:

- delivered work that was not settled, or a buyer paying for more than was delivered;
- in every scenario, faults and restarts included, judged by the mock upstream rather than the seller's books: a response the client received in full that it did not deliver, settlement below the cost of what the client received, or settlement above the most it delivered (the full cost of every response that reached the wire; nothing for an upstream error or a request dropped before any byte);
- a buyer deposit change that differs from the sum settled, or seller plus fee income that differs from it;
- reserve left locked, or a channel left open after the close;
- a peer crashing, exiting unexpectedly, or needing SIGKILL to stop (mid-run restarts included);
- after #1050's scenario, a channel the seller closed still counted as active by the buyer's store, `/_antseed/buyer-usage`, `/_antseed/channels` or `antseed buyer status`, or one of them could not be read.

`ci.mjs` also requires a share of requests to succeed (see `GATES`), and for restart scenarios no failures outside the restart window.

## Scenarios

| Scenario | Load |
|---|---|
| `c32`, `c64` | 32 or 64 concurrent requests, half streamed |
| `smallreserve` | 32 concurrent with a small reserve and per-request cap, so channels rotate |
| `images` | 32 concurrent, 30% unit-billed image generations |
| `faults` | 32 concurrent with upstream 500s, mid-stream disconnects and client aborts |
| `restart-buyer`, `restart-seller` | 32 concurrent, the buyer or seller restarted 40% of the way through |
| `issue-1050` | pay, stop the buyer (the seller closes the channel), restart it, check every channel count, pay again |
| `smoke`, `seq`, `c8`, `mixed` | lighter loads for local debugging |

## Running

Needs Foundry (`anvil`, `forge`, `cast`) and a full build (`pnpm run build`, or tiers 0–3 plus `@antseed/cli`).

```bash
# Every gated scenario once, two at a time
node e2e/stress/ci.mjs --parallel 2

# What CI runs: the same, split over two jobs. Shards 1/N to N/N run each scenario exactly once
node e2e/stress/ci.mjs --parallel 2 --shard 1/2

# Some scenarios, or the gates against another built checkout's CLI
node e2e/stress/ci.mjs --scenarios c64,restart-buyer
node e2e/stress/ci.mjs --tree ../my-branch

# One scenario several times, or a seller and buyer from different checkouts
node e2e/stress/harness.mjs --scenario c64 --runs 3
node e2e/stress/harness.mjs --scenario c32 --seller-tree ../main --buyer-tree .
```

Output goes to `$TMPDIR/antseed-stress-ci` (`ci.mjs`) or `$TMPDIR/antseed-stress` (`harness.mjs`), or `--out <dir>`. Each run's directory holds the seller and buyer logs, their stores, `requests.json` and `result.json`. Parallel runs use separate ports through `--slot`.
