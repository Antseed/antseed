---
sidebar_position: 7
slug: /reward-policies
title: Reward Policies
hide_title: true
---

# Reward Policies

Payment and rewards answer different questions. USDC settlement pays a seller
for authorized service usage. Reward policies decide how that usage contributes
to ANTS rewards. A paid request can settle successfully and earn no reward points.

The recognized-usage reward model starts at **epoch 22, September 10, 2026 at
09:54:21 UTC**, after the registry cutover. See [Recognized Usage and ANTS
Rewards](./recognized-usage.md) for staking, allocations, and contract addresses.

## Where policies apply

`AntseedUsageAccounting` checks that the seller has a pool with enough epoch
power, then sends the usage's raw points through its configured points policy.
The deployed policy is `AntseedPointsPolicyRegistry`, which runs a list of
modifiers. Accounting records the resulting buyer and seller points and derives
pool-weighted points; separate reward contracts calculate and pay ANTS.

A points modifier receives the channel, buyer, seller, and current point amounts.
It returns the next seller and buyer amounts. It does not receive custody of
USDC or staked ANTS, and changing points does not itself mint tokens, withdraw
stake, or rewrite channel settlement records.

## How policies compose

Both sides start with the raw usage points. Modifiers run in registration order,
and each sees the previous modifier's result. They can reduce or increase either
amount, or set it to zero; they are not limited to multiplying by a percentage.

For example, starting with 100 points, adding 10 and then halving produces 55.
Halving and then adding 10 produces 60. This is why order is part of the policy.

**Zero is final for each side.** Once seller points are zero, a later modifier
cannot restore them; the same holds for buyer points. Processing stops when both
are zero. With no registered modifiers, the raw points pass through unchanged.

The registry owner can register or remove modifiers, up to eight at a time.
Registration appends to the list; removal preserves the remaining order. The
accounting owner can also replace the configured points policy. Inspect
`policyCount()` and `policyAt(index)` for the configured list.

Changes apply when usage is recorded, not retroactively to existing points.
If a points policy reverts, accounting skips that usage record rather than
blocking USDC settlement. Policy code therefore needs review for both its reward
rules and its ability to execute reliably.

## Historical wash-trading policy

M001 registers `AntseedWashTradingPointsPolicy`. For each usage record, it asks
the pinned `AntseedWashTradingRegistry` whether the seller is a proven wash
trader. If yes, it returns zero buyer and seller points. Otherwise, it leaves
both amounts unchanged.

The evidence concerns conserved USDC loops, not high volume alone. Closed-loop
evidence links buyer funding, paid settlements, and value returning toward the
funder, with ordering, amount, and buyer-balance checks. Self-funded and reciprocal
bundles use the corresponding checks in the pinned seller program. The program
also rejects duplicate settlement IDs within the bundle.

The registry flags a seller when:

```text
finalized proven wash volume / authenticated total seller volume >= 25%
```

The denominator is the seller's period-end volume counter from
`AntseedChannels`, authenticated inside the proof. The configured historical
period starts at protocol genesis, so no opening counter is subtracted. Later
trading cannot dilute this fixed historical ratio. A replacement proof must
increase the proven wash volume and keep the same total; volumes from separate
proofs are not simply added together.

The **25% enforcement threshold** is different from the pinned guest's **30%
return-coverage requirement** for transfer-return closed loops. The latter is
part of deciding which evidence proves wash volume. Self-funded and reciprocal
evidence follow their own predicate checks. These proofs establish the configured
predicate, not that every possible form of wash trading has been detected; an
unflagged seller is not a certification of honest activity. The published proof
package also records unresolved funding-completeness and direct-USDC attribution
limitations. Successful verification is not a claim that those limitations have
been resolved.

### What a flag changes

- New usage involving that seller earns no buyer, seller, or pool-weighted points.
- Previously recorded points are not erased.
- USDC service payments can still settle.
- Starter-position eligibility and staked principal are unchanged.
- The flag does not ban the address from earning as a buyer of other sellers or
  as a staker in other pools.

This is a reward filter, not a principal-slashing mechanism. The separate
[legacy claim policy](./legacy-emissions.md#locked-seller-rewards-m002) controls
releases from the old locked-rewards pool.

Recording evidence and enabling enforcement are separate: accounting must use
the points registry with this modifier installed. Removing the modifier stops
that filter from running, but does not erase finalized evidence in the wash registry.

### What the proof establishes

The seller proof verifies transactions, receipts, and storage values against
supplied block headers and checks the pinned wash-trading predicate. That proves
consistency with those headers; it does not, by itself, establish that the headers
belong to the real Base chain.

The registry checks each committed block reference against Chainlink's public
`BlockhashStore` on Base. A missing or different hash rejects the check. Chainlink
supplies the historical block-hash reference, not a judgment about the seller.

Proof submission has three stages:

1. **Stage:** verify the SP1 proof and save its public journal, including a Merkle
   root committing the required block-reference chunks and their counts.
2. **Authenticate:** check each chunk's block hashes against the store and its
   Merkle path against that root. This binds the checks to the exact evidence
   list in the proof. Chunks cannot be substituted or counted twice.
3. **Finalize:** require every committed chunk and reference to be authenticated,
   then record the seller's result. Only a finalized result affects the flag.

Anyone can submit this evidence, but cannot choose another guest program,
verifier, historical period, or blockhash store: those are pinned by the registry.
Authentication is split into chunks to bound gas, and interrupted submissions
can resume. Backfilling a missing hash into Chainlink's store is a separate step;
neither staging a proof nor backfilling its hashes makes it finalized.

## Other policy interfaces

Not every contract called a policy belongs to the points list. A pool-weight
policy maps staking power to accounting weight. A legacy seller claim policy
controls how much of an existing locked balance can be released. Routing
preferences choose which seller receives a request. Each has a different input,
owner, and effect; none should be treated as an automatic extension of the
points registry.
