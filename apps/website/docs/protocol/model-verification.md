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

1. **A fresh question bank is built every epoch.** The genuine model is queried through a
   trusted upstream: OpenRouter by default, or the model maker's own API (for example
   Anthropic or OpenAI). Questions it answers consistently are kept; questions
   where cheaper look-alikes give the same answers are dropped, because they cannot
   tell models apart. The bank also measures the genuine model's own
   error rate, since even the real model is not perfectly consistent. Questions used in
   recent epochs are left out.
2. **Each seller gets a random set.** About 100 questions from the bank, picked by the
   epoch's random seed, in batches with varied wording, so a seller cannot memorize a
   fixed test.
3. **A statistical test gives the verdict.** The seller's wrong answers are compared
   with the genuine model's own error rate:

| Verdict | Meaning |
|---|---|
| **SAME** | No evidence of substitution: the seller misses about as often as the genuine model does. This is strong evidence, not proof, that it is the advertised model. |
| **DIFF** | Significantly more misses than the genuine model makes. The seller very likely serves a different model. |
| **UNDETERMINED** | Too few usable answers to decide either way: fewer than 80% of the questions were answered (errors, timeouts, empty or unreadable answers), or part of the seller's questions were never delivered. |

A missing or unreadable answer is left out of the score, not counted as wrong, so a
flaky seller doesn't look like a substituted model. Requiring 80% of the questions
answered for either verdict means a seller can't earn a SAME by leaving out the
answers it would get wrong.

A bank only goes into use if it has enough statistical power to tell the genuine
model apart from the look-alikes it was tested against.

## Who checks

**Verifiers** are addresses approved by the verification contract's owner. A verifier
buys from sellers like any other buyer, through the normal network and payments,
with no special label on its requests.

KBF audits run as one round per epoch (one week), shared by every approved verifier:

1. **The bank is sealed.** Antseed's reference publisher builds the epoch's bank for
   every model on the contract's list of audited models, encrypts it and commits its
   hash on-chain. It decides no verdicts.
2. **The work is split at random.** Once the epoch opens, a seed taken from a future
   block hash decides which questions each seller gets and which verifier buys each
   part of them (a slice, 4 per seller service by default), plus a backup verifier for each slice. A seller never
   buys its own slices.
3. **Each verifier sees only its own questions.** The publisher sends each verifier an
   envelope encrypted to that verifier's key, with the questions of its slices and none
   of the answers. Verifiers buy the slices and commit the seller-signed responses;
   slices that weren't delivered go to the backups.
4. **The key is revealed after collection.** Then anyone can decrypt the bank and check
   every verdict.
5. **Everyone scores, a majority decides.** Each verifier scores the whole epoch from
   the public data and attests the root of its results. Scoring is deterministic, so
   honest verifiers agree. The first root a majority of the epoch's verifiers attest
   becomes final, and its results go on-chain.

To run a verifier yourself, see [Become a verifier](/docs/verify).
[How verification rounds run](/docs/verify/audits) covers each step.

## Public evidence

Everything a verdict depends on is public once the epoch's bank key is revealed: the
bank (questions, the genuine model's answers and where they came from), the plan, every
slice of seller-signed responses, and every verifier's results, each on IPFS with its
hash on-chain. Anyone can download them and recompute the epoch's results root. A seller
can't deny its answers, because each batch carries its signature.

## What goes on-chain

```
sealed bank ──► plan ──► slices bought ──► key revealed ──► majority attests root ──► results applied
```

`AntseedKbfVerification` keeps one result per seller service (one model offer of one
seller):

- **The latest epoch wins.** A new SAME replaces an old DIFF and the other way round;
  an UNDETERMINED clears the earlier verdict. A late result never overwrites a newer
  epoch's.
- **Results expire on their own.** A verdict counts for the epoch it was given in and
  the next one (about two weeks), so sellers must keep being checked. A seller that fixes
  its model recovers at the next round.
- **A DIFF only affects that one service.** A seller's other verified models are not
  touched.
- Verifiers earn a share of the verification part of ANTS emissions for attesting the
  final results and for the slices they delivered.

## Check a model yourself

Anyone can audit a seller or any OpenAI- or Anthropic-compatible endpoint against a
revealed bank, paying for the questions themselves:

- `antseed verifier check <model>` in the [CLI](/docs/commands) finds the newest
  revealed bank for the model and runs it, through your buyer proxy or against any URL.
- [`@antseed/model-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/model-verifier)
  (its `antseed-verify` command) checks against published audit evidence without the
  rest of Antseed.
- The [`antseed-verify-model` agent skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model)
  asks for an endpoint, has you set its API key, runs the check and explains the
  result.
