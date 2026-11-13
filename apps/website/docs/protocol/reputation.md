---
slug: /reputation
title: Reputation
description: How buyers compute a local 0-100 trust score for each seller from pool power, recognized usage, verified identity, and model checks.
hide_title: true
---

# Reputation

Buyers score sellers locally from data they can check themselves: the seller pool's share of staking power and recognized usage, model checks, and wash-trading verdicts, all read from the chain, plus public history of identities the seller has proven it owns. There is no central reputation authority and no seller allowlist.

## Trust score

Every buyer computes one number per seller, 0-100. It estimates what a buyer's spend with the seller earns and whether the seller carries real volume, plus credit for a proven identity and a free model:

```
sum   = min(100, power + usage + identity + freeModels)
trust = washFlagged ? 0 : min(100, sum * verification multiplier)
```

| Part | Weight | On-chain source | What it means |
|---|---|---|---|
| `power` | 70 | `AntseedSellerPools.poolWeightAtEpoch / totalPowerWeightAtEpoch` for the current epoch (lock-weighted ANTS) | The pool's share of all pools' staking power this week, which is what decides what a buyer's spend with this seller earns. |
| `usage` | 30 | `AntseedUsageAccounting.sellerPointsByEpoch / totalPoolPointsByEpoch` for the last complete weekly epoch | The seller pool's share of all pools' recognized-usage points: what it actually delivered last week relative to the network. Points only accrue for sellers with a pool and have already passed the on-chain [reward policies](/docs/reward-policies), so a proven wash trader's share is already zero. |
| `identity` | +20 | None (buyer-local lookups of verified GitHub accounts and domains, see below) | Public history of an identity the seller has proven it owns, added on top of the weights. |
| `freeModels` | +5 bonus | None (the seller's signed pricing metadata) | Added on top of the weights, with the total capped at 100, when the seller offers at least one model at $0 input and output (and $0 cached input, when it prices cached input). It only adds to a seller that is already scored: a free model alone does not make an unknown seller trusted. |
| `washFlagged` | true/false | `AntseedWashTradingRegistry.isProvenWashTrader` | A proven wash trader scores 0 whatever the other parts say. |
| `verification` | multiplier | `AntseedVerificationResults.agentStatus` and the rates of `AntseedVerificationPointsPolicy` | The seller's [model checks](/docs/verify/overview): the capped sum is multiplied by the points multiplier the verification policy gives the seller. That is what a buyer's volume with this seller would earn: each verified service adds 2%, up to 50%, one DIFF service costs 4%, two 16%, three 36%, four 64%, and five with no verified services take the score to 0. The result is capped at 100. |

Power and usage are unitless shares that go through the same log curve, `log10(1 + 999 · min(1, share / 50%)) / 3`: a share of 50% or more maps to 1, 5% to 0.67, and 0.5% to 0.35, so shares self-normalize as the network grows or as more ANTS is staked. Each is then multiplied by its weight (`TRUST_WEIGHTS`). Identity maps its points (GitHub up to 70, domain up to 12, below) onto 0-20 over 70. The free-model bonus is all or nothing: 5 points or 0. The verification multiplier is applied last; it is read with the DIFF verdicts (every two minutes per seller, the rates at most hourly), and a read older than 15 minutes counts for nothing.

Policies reach the score in three ways, and the Reputation page, provider panel and CLI say what each did. The wash-trading policy sets it to 0. The verification policy scales it by the seller's multiplier, shown as the points added or taken off. Both also shape `usage`, because usage points are counted after the on-chain reward policies, so a verification penalty lowers `usage` as well as the multiplier.

A seller with no pool has no power and no usage, so it scores only what identity and a free model add, which is below the default minimum. Buyers also earn no rewards on such a seller's volume. Settled service history is still read and shown next to the score, but it does not change the number.

Power and usage need the recognized-usage stack: `sellerPoolsAddress`, `usageAccountingAddress`, and `washTradingRegistryAddress` in the chain config (see [Buyer configuration](/docs/buyer-config)), filled automatically for `base-mainnet`. On chains without the recognized-usage stack, only identity and a free model can add to a peer's score; in the first epoch after activation there is no previous-epoch usage share yet. Buyers read every on-chain input for a discovery pass in two Multicall3 round trips (chunked at 80 calls each) and refresh a seller at most every 120 seconds.

### Identity

The identity part is the strongest single verified identity; several accounts or domains owned by one operator never add up.

- **GitHub portfolio (max 70).** Original, non-fork repositories at least three months old with at least five stars, excluding the ownership-proof repository: `40 · min(1, Σ log2(1 + min(stars, 500)) / 40)` for stars, `+ 20 · min(1, projects / 8)` for breadth, `+ 10 · min(1, oldest project years / 3)` for age. Archived repositories count at 20%. An empty or zero-star account earns 0.
- **Domain registration age (max 12).** `12 · min(1, years / 5)`, read from the authoritative RDAP registry. The registration must match the exact domain, so `app.example.com` cannot inherit the age of `example.com`.
- **Collection.** Only identities whose [ownership proof](/docs/provide/verified-identity) verified are looked up. GitHub: one account lookup plus up to four pages of 100 repositories, keyed by numeric account id so a reassigned username cannot inherit the previous owner's history. Domains: the cached IANA RDAP bootstrap plus one registry query. Requests go only to public HTTPS hosts, do not follow redirects, time out after 8 seconds, and are capped at 2 MB. Evidence is buyer-local, usable for seven days, and never part of signed seller metadata.
- Public history is a heuristic, not proof of service quality: stars can be bought, and accounts and domains change hands.

### Not in the score

These stay separate router rules or display-only figures and never change the number: settled service history, the local sybil heuristic (a display-only warning in the CLI and desktop), ghost-channel count, settlement recency, failure streaks and cooldowns, price limits, and allow/block lists. A seller-reported `reputationScore` is used only when the buyer has not scored the peer.

## How routing uses the score

The buyer proxy (which the gateway and the desktop app run) uses the trust score as a gate: automatic routing picks the cheapest seller at or above the buyer's minimum trust score, and trust only breaks price ties. The minimum trust score, routing defaults, and the router weight tables are documented in one place: the [router plugin API](/docs/router-api).

## On-chain stats

Antseed derives core on-chain seller stats directly from `AntseedChannels`. Completed channels, ghost channels, and settled volume live in the Channels contract itself. An optional `AntseedStats` contract can additionally ingest buyer-signed metadata during settlement to aggregate token and request counters. Buyers still read these counters for display and for the local sybil warning; they are not part of the trust score.

Each seller's ERC-8004 agentId maintains the following core counters in `AntseedChannels`:

| Counter | Updated during | Description |
|---|---|---|
| `channelCount` | `close()` | Number of completed channels |
| `ghostCount` | `withdraw()` when nothing was settled | Timed-out channels with no proven spend |
| `totalVolumeUsdc` | `settle()` / `close()` | Cumulative USDC volume settled |
| `lastSettledAt` | `settle()` / `close()` | Timestamp of most recent settlement |

If the optional `AntseedStats` contract is configured, it can also track:

| Counter | Updated during | Description |
|---|---|---|
| `totalInputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative input tokens, delta-accounted per channel |
| `totalOutputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative output tokens, delta-accounted per channel |
| `totalRequestCount` | `settle()` / `topUp()` settle path | Buyer-signed cumulative request count, delta-accounted per channel |

No counter can be incremented without a corresponding on-chain state transition and buyer-signed metadata hash.

## Staking and rewards

Seller eligibility is resolved through AntseedSellerRegistry, and ANTS pool positions contribute epoch power; that pool power share is the `power` part of the trust score. ANTS reward accounting is separate from the trust score: it uses recognized usage, seller-pool power, and the configured [reward policies](/docs/reward-policies), and a high trust score does not override a reward exclusion. See [Recognized usage and ANTS rewards](/docs/recognized-usage) for the reward model and [Legacy emissions](/docs/legacy-emissions) for rewards earned before the recognized-usage stack.
