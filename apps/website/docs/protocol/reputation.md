---
sidebar_position: 6
slug: /reputation
title: Reputation
hide_title: true
---

# Reputation

Buyers score sellers locally from data they can check themselves: settled service history, the seller pool's share of recognized usage and staking power, and wash-trading verdicts, all read from the chain, plus public history of identities the seller has proven it owns. There is no central reputation authority and no seller allowlist.

## Trust score

Every buyer computes one number per seller, 0-100, as a weighted sum of independent parts:

```
trust = washFlagged ? 0 : history + usage + power + identity
```

| Part | Weight | On-chain source | What it means |
|---|---|---|---|
| `history` | 50 | `AntseedChannels.getAgentStats` lifetime settled channel count and volume | Demonstrated service history. Channel count and settled USDC volume each use a bounded log curve, saturating at 100 settled sessions and 100 USDC, then contribute equally to this part. |
| `usage` | 20 | `AntseedUsageAccounting.sellerPointsByEpoch / totalPoolPointsByEpoch` for the last complete weekly epoch | The seller pool's share of all pools' recognized-usage points: what it actually delivered last week relative to the network. Points only accrue for sellers with a pool and have already passed the on-chain [reward policies](./reward-policies.md), so a proven wash trader's share is already zero. |
| `power` | 10 | `AntseedSellerPools.poolWeightAtEpoch / totalPowerWeightAtEpoch` for the current epoch (lock-weighted ANTS) | The pool's share of all pools' staking power this week, which is what decides what a buyer's spend with this seller earns. |
| `identity` | 20 | None (buyer-local lookups of verified GitHub accounts and domains, see below) | Public history of an identity the seller has proven it owns, so an established operator earns credit before it has a pool record. |
| `washFlagged` | true/false | `AntseedWashTradingRegistry.isProvenWashTrader` | A proven wash trader scores 0 whatever the other parts say. |

Each part is a 0-1 value times its weight. History averages `log10(1 + channelCount) / log10(101)` and `log10(1 + settledVolumeUsdc) / log10(101)`, with each term capped at 1. Both network shares are unitless and go through the same log curve, `log10(1 + 999 · share) / 3`: a 100% share maps to 1, 10% to 0.67, and 1% to 0.35, so shares self-normalize as the network grows or as more ANTS is staked. Identity maps its points (GitHub up to 70, domain up to 12, below) onto 0-1 over 70. The weights sum to 100 and live in one table (`TRUST_WEIGHTS`); a future model-verification part will take its weight from there.

The history part only needs the channels and seller-registry contracts already required for paid routing. The other on-chain parts need the recognized-usage stack: `sellerPoolsAddress`, `usageAccountingAddress`, and `washTradingRegistryAddress` in the [chain config](/docs/config), filled automatically for `base-mainnet`. On chains without the recognized-usage stack, service history and identity can still score a peer; in the first epoch after activation there is no previous-epoch usage share yet. Buyers read every on-chain input for a discovery pass in two Multicall3 round trips (chunked at 80 calls each) and refresh a seller at most every 120 seconds.

### Identity

The identity part is the strongest single verified identity; several accounts or domains owned by one operator never add up.

- **GitHub portfolio (max 70).** Original, non-fork repositories at least three months old with at least five stars, excluding the ownership-proof repository: `40 · min(1, Σ log2(1 + min(stars, 500)) / 40)` for stars, `+ 20 · min(1, projects / 8)` for breadth, `+ 10 · min(1, oldest project years / 3)` for age. Archived repositories count at 20%. An empty or zero-star account earns 0.
- **Domain registration age (max 12).** `12 · min(1, years / 5)`, read from the authoritative RDAP registry. The registration must match the exact domain, so `app.example.com` cannot inherit the age of `example.com`.
- **Collection.** Only identities whose [ownership proof](./discovery.md#domain-and-github-verification-claims) verified are looked up. GitHub: one account lookup plus up to four pages of 100 repositories, keyed by numeric account id so a reassigned username cannot inherit the previous owner's history. Domains: the cached IANA RDAP bootstrap plus one registry query. Requests go only to public HTTPS hosts, do not follow redirects, time out after 8 seconds, and are capped at 2 MB. Evidence is buyer-local, usable for seven days, and never part of signed seller metadata.
- Public history is a heuristic, not proof of service quality: stars can be bought, and accounts and domains change hands.

### Not in the score

These stay separate router rules and never change the number: the local sybil heuristic (a display-only warning in the CLI and desktop), ghost-channel count, settlement recency, failure streaks and cooldowns, price limits, and allow/block lists. A seller-reported `reputationScore` is used only when the buyer has not scored the peer.

## Routing

The buyer proxy and desktop share the route ranking exported by `@antseed/node/model-routing`, and `/v1/models/:id` returns peer offers in that same order. The default model routing preferences are:

```typescript
{
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
}
```

`minTrustScore` and the allow/block lists are hard eligibility rules. At the default `60`, unscored sellers are excluded. An established seller that has reached both history targets scores 50 before usage, power, or identity; a 10% power share adds about 6.7 points and a 1% share of last epoch's recognized usage about 7, so demonstrated service alone does not pass the default gate: it also takes recognized usage, pool participation, or a verified identity. Identity alone reaches at most 20. Buyers can lower `buyer.routingPreferences.minTrustScore`, or set it to `0` to consider unscored peers. `buyer.minPeerReputation` and hierarchical `maxPricing` remain separate hard policy checks applied before the ranking.

Eligible offers are ranked by trust, token or image price, cached-input pricing coverage, free-peer preference, recent failures, and cooldown state. If at least one seller for a model advertises cached-input pricing, offers that omit it receive a model-specific reputation reduction; if none advertise it, no seller is penalized. A recognized conversation softly prefers its previous successful seller while that offer remains healthy and eligible. Latency is tracked as an exponential moving average (alpha: 0.3), and peers with consecutive failures enter exponential backoff cooldown.

The lower-level `@antseed/router-core` package also exposes generic router weights for plugin authors; its reputation factor is the trust score when available:

| Factor | Weight |
|---|---|
| Price | 0.30 |
| Latency | 0.25 |
| Capacity | 0.20 |
| Reputation | 0.10 |
| Freshness | 0.10 |
| Reliability | 0.05 |

## On-Chain Stats

AntSeed derives core on-chain seller stats directly from `AntseedChannels`. Completed channels, ghost channels, and settled volume live in the Channels contract itself. An optional `AntseedStats` contract can additionally ingest buyer-signed metadata during settlement to aggregate token and request counters. Buyers still read these counters for display and for the local sybil warning; they are not part of the trust score.

Each seller's ERC-8004 agentId maintains the following core counters in `AntseedChannels`:

| Counter | Updated During | Description |
|---|---|---|
| `channelCount` | `close()` | Number of completed channels |
| `ghostCount` | `withdraw()` when nothing was settled | Timed-out channels with no proven spend |
| `totalVolumeUsdc` | `settle()` / `close()` | Cumulative USDC volume settled |
| `lastSettledAt` | `settle()` / `close()` | Timestamp of most recent settlement |

If the optional `AntseedStats` contract is configured, it can also track:

| Counter | Updated During | Description |
|---|---|---|
| `totalInputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative input tokens, delta-accounted per channel |
| `totalOutputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative output tokens, delta-accounted per channel |
| `totalRequestCount` | `settle()` / `topUp()` settle path | Buyer-signed cumulative request count, delta-accounted per channel |

No counter can be incremented without a corresponding on-chain state transition and buyer-signed metadata hash.

## Staking

From **September 10, 2026 at 09:54:21 UTC (epoch 22)**, seller eligibility is
resolved through AntseedSellerRegistry and ANTS pool positions contribute epoch
power. Legacy USDC stake can remain an eligibility fallback while enabled;
recognized-usage rewards require pool power, and the same pool power share is
the `power` part of the trust score. See [Recognized Usage](./recognized-usage.md)
and [legacy USDC staking](./legacy-emissions.md#legacy-usdc-staking).

## ERC-8004 Feedback

Buyers submit structured feedback via the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). Feedback signals:

| Signal | Type | Range |
|---|---|---|
| Quality | uint8 | 0-100 |
| Latency | uint8 | 0-100 |
| Accuracy | uint8 | 0-100 |
| Reliability | uint8 | 0-100 |

Feedback and the trust score do not automatically grant ANTS or apply a
fixed on-chain reward multiplier. Recognized-usage accounting applies the
configured [reward policies](./reward-policies.md); the registered historical wash-trading policy
can zero future rewards without changing settlement stats.

## ANTS Rewards

**Protocol start: September 10, 2026 at 09:54:21 UTC (epoch 22).**

The trust score helps a buyer choose a seller. ANTS reward accounting is
separate: it uses recognized usage, seller-pool power, and the configured policies.
A high trust score does not override a reward exclusion.

See [Recognized Usage and ANTS Rewards](./recognized-usage.md) for the standard
reward model. **Looking for pre-migration emissions?** The [legacy guide](./legacy-emissions.md)
covers the 65% seller / 5% buyer split and historical claims.
