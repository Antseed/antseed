---
slug: /model-verification
title: Model verification
description: How Antseed checks that sellers serve the model they advertise. The KBF audit is one of the first of many verification methods on the network, with results on-chain that anyone can repeat.
hide_title: true
---

# Model verification

This page is the technical description. For a plain introduction, see [Model verification](/docs/verify/overview), with guides [for buyers](/docs/verify/buyers) and [for providers](/docs/verify/providers).

A seller says "this is Claude Opus 5.5". Model verification checks that claim. Without
it, a seller could advertise an expensive model, serve a cheaper one, and charge the
expensive price.

## One method among many

There are many ways to check a seller and protect model integrity, and no single check
covers everything. **The KBF audit described here is one of the first verification
methods Antseed is launching, and more are coming.** Each new method will check a
different part of what a seller claims, and together they make it hard to cheat
without being caught.

## The idea in one paragraph

Every model has a "knowledge boundary": a set of obscure facts it remembers in a
particular way, including the ones it gets slightly wrong. A different model, a
smaller sibling, or a heavily quantized copy has a different boundary. The KBF audit asks a
seller a batch of short questions with exact numeric answers (for example "the
melting point of tantalum carbide is ___°C") and compares the answers
with what the genuine model answers. This is called **Knowledge Boundary
Fingerprinting (KBF)**.

## How one KBF check works

1. **A reference is built once per model.** The genuine model is queried through a
   trusted upstream: OpenRouter by default, or the model maker's own API (for example
   Anthropic or OpenAI) when an auditor sets one up. Questions it answers consistently are kept; questions
   where cheaper look-alikes give the same answers are dropped, because they cannot
   tell models apart. The reference also measures the genuine model's own
   error rate, since even the real model is not perfectly consistent.
2. **The seller is asked a fresh random subset.** Each check picks a new random set of
   about 100 questions from the reference, in a new order and with varied wording, so a
   seller cannot memorize a fixed test.
3. **A statistical test gives the verdict.** The seller's wrong answers are compared
   with the genuine model's own error rate:

| Verdict | Meaning |
|---|---|
| **SAME** | No evidence of substitution: the seller misses about as often as the genuine model does. This is strong evidence, not proof, that it is the advertised model. |
| **DIFF** | Significantly more misses than the genuine model makes. The seller very likely serves a different model. |
| **UNDETERMINED** | Too few usable answers to decide either way: fewer than half the questions were answered (errors, timeouts, empty or unreadable answers), or a seller looked different but answered fewer than 80% of the questions. |

A missing or unreadable answer is left out of the score, not counted as wrong, so a
flaky seller doesn't look like a substituted model.

A reference only goes into use if it has enough statistical power to tell the genuine
model apart from the look-alikes it was tested against.

## Who checks

**Auditors** are addresses approved by the verification contract's owner. An auditor
buys from sellers like any other buyer, through the normal network and payments,
with no special label on its requests.

The audited models are built into the CLI. Each epoch they are split across the
approved auditors, round robin, so every model is audited every epoch by one auditor,
and the models move to a different auditor the next epoch. For its models, the auditor
checks every seller that advertises them. See
[Which models you audit](/docs/verify/audits#which-models-you-audit).

A **DIFF** from one auditor is only a report. The contract records it once a second
approved auditor, the model's confirmer this epoch (the next auditor in the rotation),
audits the same seller with its own questions and also finds DIFF. A SAME is recorded
from one auditor, and so is the SAME or UNDETERMINED that clears a recorded DIFF on Base
mainnet (see below). So a seller is only marked DIFF when two independent auditors agree.

To run an auditor yourself, see [Become a verifier](/docs/verify). [How audits run](/docs/verify/audits)
covers each step, including where the genuine model's answers come from.

## Public evidence

Every audit is published to IPFS: the questions asked, the seller's raw responses, the
statistics, and where the reference answers came from (which API, which model id and
which request settings), with the raw reference requests and responses. Its hash goes on-chain with the result. Anyone can download it and
re-run the same kind of check themselves (see [Check a model yourself](#check-a-model-yourself)).
An auditor that publishes wrong results can be caught from its own evidence and loses
its approval.

## What goes on-chain

```
seller audit ──► evidence on IPFS ──► AntseedKbfAudits ◄── second auditor's audit (for a DIFF)
                                            │ once enough auditors agree
                                            ▼
                               AntseedVerificationResults ──► buyers, points policy
```

Two contracts share the work:

- **`AntseedKbfAudits`** takes the auditors' KBF submissions, counts the reports for each
  seller service and records a verdict once enough auditors agree (one for a SAME, two for
  a DIFF). The owner approves and revokes auditors on it with `setAuditor`. It earns each
  auditor credits per audited model: one by default, and the owner can set another default
  or a per-model amount (`creditsPerAudit`, `setModelCreditsPerAudit`). It also decides how
  long its verdicts count (`validityEpochs`, 2 by default, at most 4).
- **`AntseedVerificationResults`** holds the recorded verdicts, whatever verification
  method produced them, and pays verifiers from the verification emissions bucket. A
  verification method is an *audit* contract the owner approves on it. KBF is the first
  audit writing to it; each later method is its own contract next to `AntseedKbfAudits`,
  with its own share of the bucket.

Auditor rewards come from KBF's share of the verification bucket. After an epoch ends, each
auditor's share follows its credits, capped at 20% of KBF's share per auditor; the part above the
cap goes to the emissions reserve in the same claim, as with the other ANTS reward contracts.
Rewards are claimed one epoch at a time (`claimAuditorReward`), and budget nobody claims (for
example in an epoch without credits) stays unminted. Rewards stay off until the owner turns
them on. Auditors claim with `antseed verifier rewards --claim` and can publish a display name,
icon and link with `antseed verifier profile`.

These replace the single `AntseedKbfVerification` contract (migration M003) with the same
KBF rules. On Base mainnet the current contracts are `AntseedVerificationResults`
`0x139ab1722a62a23371f491220902c460E9fAeAb2` and `AntseedKbfAudits`
`0x86B92DC48EF7c5a12de6e44409E83C8EF36657Ff` (release `003-verification-audits`), which the
CLI and SDK default to. The points policy that reads them is `AntseedVerificationPointsPolicy`
`0xD58393a752b3b7bdBea6231E0e24C11403e9f32f` (release `003-verification-policy`). They replaced the earlier `0xF2C8482aD2A348854698E93f41FE3cc32307687c`
and `0xe57aB03423A3835571F7d68AC1E23CF8a2763343` pair, which they are not compatible with.
The old contracts stay on-chain but are no longer read.

`AntseedVerificationResults` keeps one result per seller service (one model offer of one
seller):

- **The latest result wins**, whichever approved auditor submitted it. A new SAME replaces
  an old DIFF and the other way round; an UNDETERMINED clears the earlier verdict.
- **Results expire on their own.** Each verdict is recorded with the epoch it stops
  counting in, chosen by the audit that recorded it. A KBF verdict counts for the epoch it
  was given in and the next one (about two weeks; the KBF owner can set up to four), so
  sellers must keep being checked. A seller that fixes its model recovers at the next audit.
- **For reputation, a DIFF only affects that one service.** A seller's other verified
  models keep their reputation. Rewards work per seller instead: see
  [How results affect rewards](#how-results-affect-rewards).
- **Replacing a DIFF takes one auditor by default.** Within KBF, a SAME or UNDETERMINED
  replaces a live DIFF once it has its own required reports (one each) and at least
  `diffReplacementReports` of them. That floor is 1 by default (and on Base mainnet); the owner
  can raise it, e.g. to 2 so one auditor alone cannot lift a DIFF. If the owner clears a wrong
  result, reports made before the clear stop counting.
- Auditors cannot audit sellers they own.

## How buyers use results

Buyers read each seller service's recorded result from `AntseedVerificationResults`. A
service with a live **DIFF** keeps 10% of its effective reputation, so automatic routing
skips it under the default minimum trust score, and the desktop app explains the cut
in the seller's reputation tooltip. Only a recorded DIFF counts: a DIFF from one auditor
that is still waiting for the second changes nothing, and the service keeps its earlier
result until then. SAME, UNDETERMINED, expired and missing results change nothing. The
penalty lifts on its own when the DIFF expires or a later result replaces it (one auditor's
SAME or UNDETERMINED under the default `diffReplacementReports` of 1). See [Routing](/docs/api/routing).

## How results affect rewards

Verdicts also change ANTS rewards, through `AntseedVerificationPointsPolicy`, a points
policy registered on Base mainnet. Where reputation looks at one service at a time, the
points policy looks at the whole seller agent: it counts the agent's live SAME and DIFF
services and gives every settlement with that seller one multiplier, for the seller's
points and the buyer's points alike.

- Each SAME service adds **2%**, up to +50% in total.
- DIFF services cost **4% × (DIFF count)²**: −4% for one, −16% for two, −36% for three,
  −64% for four, and all points from five on.

So a seller with 6 SAME services and no DIFF earns 112% of its points, and one with 6 SAME
and 1 DIFF earns 108%. As with reputation, only recorded, live verdicts count, and the
effect follows the verdicts: it applies from the next settlement after a verdict is
recorded and ends when the verdict expires or is replaced. Points already recorded do not
change. See [Reward policies](/docs/reward-policies#verification-policy) for how this
policy fits with the others.

## Check a model yourself

Anyone can re-run the latest published audit against a seller or any OpenAI- or
Anthropic-compatible endpoint, paying for the questions themselves:

- `antseed verifier check <model>` in the [CLI](/docs/commands) finds the latest
  on-chain audit and runs it, through your buyer proxy or against any URL.
- [`@antseed/model-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/model-verifier)
  (its `antseed-verify` command) does the same without the rest of Antseed.
- The [`antseed-verify-model` agent skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model)
  asks for an endpoint, has you set its API key, runs the check and explains the
  result.
