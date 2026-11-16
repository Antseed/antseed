# Dashboard RPC efficiency

The dashboard batches position records, position status, and pool configuration
through Multicall3. Its shared provider also coalesces identical in-flight
`eth_call`, `eth_getCode`, and `eth_getBalance` requests. Results and errors are
removed from the in-flight map when they complete; this is not a persistent cache.
The complete RPC parameters, including caller, block and overrides, distinguish
requests. Transaction submissions are never coalesced.
Wallet/context invalidation clears shared in-flight reads. Dashboard actions
also clear them before execution, after confirmed steps, and on completion or
failure, so a post-action refresh does not join a pre-action transport request.

## Reproducible call-count comparison

`packages/node/src/payments/evm/seller-pools-batching.test.ts` compares the previous
individual-getter flow with the batched flow against the same deterministic ABI
fixture. It verifies identical position records, status values and configuration.
The counts include deployment probes, use the default 80-read chunk size, and
assume open positions whose withdrawal changes are no longer pending.

| Positions | Individual getter flow | Batched flow | Fewer requests |
| --- | ---: | ---: | ---: |
| 0 (configuration only) | 7 | 2 | 71.4% |
| 20 | 87 | 6 | 93.1% |
| 100 | 407 | 10 | 97.5% |

For 20 positions, the original flow performs 20 record reads, 60 status reads,
and seven configuration reads. The new flow makes three aggregate calls and
three deployment probes. For 100 positions, records use two aggregate calls,
statuses use four, and configuration uses one, plus three probes.

These are mocked RPC request counts, not whole-dashboard or production latency
benchmarks. They exclude position enumeration, reward computation, overview,
pool-yield enrichment, startup endpoint probes, and endpoint failover. Batching
reduces network overhead but still executes the underlying getters. The benefit
to node computation is therefore not the same as the request-count reduction.

The provider regression tests show three overlapping identical transport-level
reads sharing one request while retaining each caller's response ID. Existing
ethers caching can already collapse short-lived duplicates; the additional
benefit depends on the timing and overlap of actual view requests.

## Failure behavior

- Explorer REST reads keep the request pending through at most two attempts:
  eight seconds per attempt, a 750ms minimum delay, and an 18-second budget per
  resource read (not for the entire dashboard, which also performs chain reads).
  Network failures, timeouts, HTTP 408/429 and 5xx responses qualify for retry.
  `Retry-After` is honored when another full attempt fits within the budget;
  otherwise the failure is returned. Other 4xx responses and invalid JSON are
  not retried. Transaction submissions are unaffected.
- Cacheable identical explorer REST reads share an in-flight promise even past
  the cache TTL. Freshness begins at completion, and invalidated reads cannot
  repopulate the cache for another wallet.
- The seller list stays loading during active reads and automatic recovery.
  Existing rows remain visible as previously loaded data. Only after failure
  does the page offer **Try again** and explain whether the displayed list is
  stale or limited to the wallet's own pools. Temporary chain-only results are
  not cached as fresh by the API or any frontend pool consumer; returning to
  the page revalidates them. An intentionally unconfigured explorer remains a
  supported chain-only mode, without automatic recovery or a retry prompt.

- A failed Multicall deployment probe propagates its error; it does not trigger
  individual-call fallback. Only a successful empty-code response selects that
  fallback, whose concurrency is bounded.
- Aggregate failures split only for recognized gas or request/response size
  limits. Timeouts, throttling and other infrastructure failures propagate and
  stop further scheduling within that invocation. Calls already running may finish.
- An 80-read aggregate that persistently times out previously could split into
  159 attempts. It now makes one aggregate attempt before propagating the error,
  excluding deployment probes and any endpoint-level failover.
- Reverted or undecodable subcalls still yield missing values. Required position,
  status and configuration values throw instead of silently becoming zeros.
  A pending position's penalty is not required; its existing projected-penalty
  behavior is preserved.
- Claims, withdrawals, ownership checks, and reward formulas are unchanged.

## Validation

### Network snapshot

`GET /api/network` reads a coherent block-pinned snapshot. The main Network page
and modern Overview share its in-flight request and 20-second result cache;
wallet reads remain separate. Epoch boundaries and context invalidation expire
live results. Immutable gate timing/schedule constants are cached separately by
context and chain configuration. Mutable configuration is read at the snapshot
block, including next-epoch settings and gate budgets. Budgets come from the
reward contracts, not a reimplementation of their dynamic formulas.

The snapshot verifies controller/gate/pool/accounting connections and registry
activation. Missing reads stay unavailable. Overview hides an incomplete network
summary instead of substituting mixed indexed and live numbers. The page retains
the previous snapshot with a stale warning on refresh errors. Visible Network
pages refresh every 60 seconds, at the estimated epoch boundary, on visibility
restoration, and after action invalidation; the countdown itself makes no RPCs.

Measured on the local Anvil fork (block 51,304,816, without endpoint failures):

| Read | Transport requests |
| --- | ---: |
| Previous uncached emissions service, including stack discovery and legacy details | 35 `eth_call` requests |
| New cold network snapshot | 1 block read + 1 code probe + 2 Multicalls = 4 |
| New expired/invalidated snapshot with immutable metadata cached | 1 block read + 1 code probe + 1 Multicall = 3 |
| Shared snapshot cache hit | 0 |

These are network/emissions-read counts, not whole-dashboard totals. Wallet
reads, startup endpoint selection, retry/fallback requests, and expanded history
are outside the new snapshot counts. Multicall still executes each underlying
getter; providers without Multicall fall back to bounded individual calls.
Legacy emissions, verification, and usage history mount only when expanded.

Regression checks:

```sh
pnpm --dir apps/ants exec vitest run src/service/network.test.ts src/service/overview-reads.test.ts web/src/network-page.test.ts
```

### Antscan display migration

Position status, personal pool totals, and staking rewards share Antscan's
paginated `include=rewards` response, cached for 15 seconds. Live status and
reward freshness are validated independently. With Antscan configured, failed
position reads surface an error rather than falling back to per-position RPC
calls; unavailable rewards remain `null`, not zero. Explicitly unconfigured local
setups retain chain reads. Transaction preparation and authorization remain live.

Post-transaction read barriers return HTTP 202 with `state: "syncing"` rather
than a display error. The dashboard retains the last successful snapshot with an
"Updating…" label and re-reads every three seconds while the tab is visible,
until Antscan catches up; no manual refresh is required.
Positions show an empty-wallet message only after a successful, current read.
Pool and seller-detail reads are not blocked by a wallet barrier: public
statistics still load (falling back to chain reads for network totals), while
the response sets `walletSyncing` and omits the wallet's own pool figures. The
dashboard labels those figures "Updating…", re-reads them on the same schedule,
and does not cache the response.

Pool statistics use a separate, wallet-independent GraphQL snapshot of current
and previous epochs, also cached for 15 seconds. It does not fetch wallet
positions again. Epoch and pool collections paginate in groups of 100, requesting
only unfinished collections. The snapshot must match the chain/current epoch
and be no older than 120 seconds. Duplicate records, broken pagination and
changing checkpoints are rejected. Each caller still checks its session's
post-transaction block marker before using the shared statistics.

Unavailable pool snapshots can fall back to live current network totals;
historical yields stay unknown without per-pool historical RPC fallback.
Modern Overview uses the separate live network snapshot described above.
These read reductions do not establish a whole-dashboard performance percentage.

### Commands

Use the repository's pinned Node.js version and install/build workspace dependencies.

```sh
pnpm --filter '@antseed/node^...' run build
pnpm --dir packages/node run build
pnpm --dir packages/node exec vitest run src/payments/evm/multicall.test.ts src/payments/evm/seller-pools-batching.test.ts
pnpm --dir apps/ants exec vitest run src/service/rpc-provider.test.ts src/service/positions.test.ts
pnpm --dir apps/ants exec vitest run src/service/display-snapshot.test.ts src/service/display-reads.test.ts
pnpm --dir apps/ants run typecheck
```

The regression tests also cover empty lists, ordering, duplicate IDs, pending and
closed positions, withdrawn and max-locked positions, required-read failures,
bounded fallback concurrency, block tags, gas-limit splitting, and fresh reads
after both successful and failed in-flight requests.
