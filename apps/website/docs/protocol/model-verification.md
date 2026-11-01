---
slug: /model-verification
title: Model verification
description: How Antseed checks that sellers serve the model they advertise. The KBF audit is one of the first of many verification methods on the network, with results on-chain that anyone can repeat.
hide_title: true
---

# Model verification

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
| **UNDETERMINED** | Too few usable answers to decide either way: fewer than half the questions were answered (errors, timeouts, empty or unreadable answers), a seller looked different but answered fewer than 80% of the questions, or a DIFF wasn't confirmed by its recheck. |

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

Before an auditor reports a **DIFF**, it rechecks that seller on a second, fresh set of
questions the seller has never seen:

- the recheck says DIFF → the result is DIFF
- the recheck says SAME or UNDETERMINED → the result is UNDETERMINED, not DIFF
- the recheck cannot run → nothing is reported for that seller until a later run in the
  same epoch rechecks it

So a seller is only marked DIFF when two independent checks agree.

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
seller audit ──► DIFF? ──► recheck ──► evidence on IPFS ──► AntseedKbfVerification
```

`AntseedKbfVerification` keeps one result per seller service (one model offer of one
seller):

- **The latest result wins**, whichever approved auditor submitted it. A new SAME replaces
  an old DIFF and the other way round; an UNDETERMINED clears the earlier verdict.
- **Results expire on their own.** A verdict counts for the epoch it was given in and
  the next one (about two weeks), so sellers must keep being checked. A seller that fixes
  its model recovers at the next audit.
- **A DIFF only affects that one service.** A seller's other verified models are not
  touched.
- Auditors cannot audit sellers they own.

## How buyers use results

Buyers read each seller service's current result from `AntseedKbfVerification`. A
service with a live **DIFF** keeps 10% of its effective reputation, so automatic routing
skips it under the default minimum trust score, and the desktop app explains the cut
in the seller's reputation tooltip. SAME, UNDETERMINED, expired and missing results change
nothing. The penalty lifts on its own when the DIFF expires or a later audit replaces
it. See [Routing](/docs/api/routing).

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
