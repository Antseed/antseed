---
slug: /model-verification
title: Model verification
description: How Antseed checks that sellers serve the model they advertise, how results reach the chain, and how anyone can repeat the check.
hide_title: true
---

# Model verification

A seller says "this is Claude Opus 5.5". Model verification checks that claim. Without
it, a seller could advertise an expensive model, serve a cheaper one, and charge the
expensive price. Verification catches that, records the result on-chain, and lets
anyone repeat the check.

## The idea in one paragraph

Every model has a "knowledge boundary": a set of obscure facts it remembers in a
particular way, including the ones it gets slightly wrong. A different model, a
smaller sibling, or a heavily quantized copy has a different boundary. Antseed asks a
seller a batch of short questions with exact numeric answers (for example "the
melting point of tantalum carbide is ___°C") and compares the answers
with what the genuine model answers. This is called **Knowledge Boundary
Fingerprinting (KBF)**.

## How one check works

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
| **UNDETERMINED** | Some questions got no usable answer (errors, refusals, timeouts), so no verdict either way. |

A reference only goes into use if it has enough statistical power to tell the genuine
model apart from the look-alikes it was tested against.

## Who checks

**Auditors** are addresses approved by the verification contract's owner. An auditor
buys from sellers like any other buyer, through the normal network and payments,
with no special label on its requests. For each model, the auditor checks every
seller that advertises it.

Before an auditor reports a **DIFF**, it rechecks that seller on a second, fresh set of
questions the seller has never seen:

- the recheck says SAME → the result becomes UNDETERMINED, not DIFF
- the recheck says DIFF or UNDETERMINED → the DIFF stands
- the recheck cannot run → nothing is reported for that seller

So one unlucky run does not mark an honest seller.

## Public evidence

Every audit is published to IPFS: the questions asked, the seller's raw responses, the
statistics, and where the reference answers came from (which API, which model id and
which request settings), with the raw reference requests and responses. Its hash goes on-chain with the result. Anyone can download it and
re-run the same kind of check themselves (see [Check a model yourself](#check-a-model-yourself)).
An auditor that publishes wrong results can be caught from its own evidence and loses
its approval.

## What goes on-chain

```
seller audit ──► DIFF? ──► recheck ──► evidence on IPFS ──► AntseedVerification
```

`AntseedVerification` keeps one result per seller service (one model offer of one
seller):

- **The latest result wins.** A new SAME replaces an old DIFF and the other way round;
  an UNDETERMINED clears the earlier verdict.
- **Results expire on their own.** A verdict counts for the epoch it was given in and
  the next one (about two weeks), so sellers must keep being checked. A seller that fixes
  its model recovers at the next audit.
- **A DIFF only affects that one service.** A seller's other verified models are not
  touched.
- Auditors cannot audit sellers they own.

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
