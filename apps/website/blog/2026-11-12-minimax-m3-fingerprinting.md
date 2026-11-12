---
slug: minimax-m3-fingerprinting
title: "One Label, Two Behaviors: Fingerprinting MiniMax M3 Across 11 Providers"
authors: [antseed]
tags: [verification, models, research, KBF]
description: "A study of model integrity, and why fingerprinting finds what benchmarks can't. We fingerprinted MiniMax M3 across 11 providers on OpenRouter and found two distinct behaviors under one label."
keywords: [model verification, model fingerprinting, Knowledge Boundary Fingerprinting, KBF, MiniMax M3, open weights, OpenRouter, model integrity]
image: /og-image-open-market.png
date: 2026-11-12
---

**A study of model integrity, and why fingerprinting finds what benchmarks can't**

*Antseed Research · data by Alex Ludwig*

Trust is the core of what a marketplace offers. Buyers need to know they get what they paid for, and honest sellers need to know everyone is held to the same standard. On Amazon that means you get the product you ordered, in the quality you expected. On a model marketplace like Antseed, one part of it is model verification: making sure the model matches the label. We believe that job belongs to a fully decentralized network, not to a single company. So we built a decentralized verification layer, and tested it on OpenRouter against the quality checks routers use today.

The model we tested was MiniMax M3. Every M3 endpoint there carries the same label, `minimax-m3-20260531`. The 11 providers we audited split into two groups that answer hard recall questions differently. On OpenRouter's quality benchmarks, the two groups sit within 1 point of each other. On a behavioral fingerprint, they sit more than 20 points apart.

Neither group is wrong. One matches the weights MiniMax published, the other matches MiniMax's API today. We measured how the endpoints answer, not what runs behind them.

<!-- truncate -->

## Why we looked

An audit is only as good as its reference. Before relying on our method for M3, we pointed it at an established marketplace and asked: which OpenRouter providers of M3 aren't serving the genuine model, taking MiniMax's own endpoint as the reference?

We expected a few outliers at most. Instead, the 11 providers split cleanly into two groups.

## How we tell models apart

To tell models apart, we look at the knowledge boundary: the line between what a model knows and what it doesn't. The method is called a knowledge boundary fingerprint, or KBF, and comes from a [2026 paper by Fang, Feng, Li and Zhou](https://arxiv.org/abs/2605.29524) ([code](https://github.com/Ooo0ption/KBF)).

Think of two people. Both know the capital of France. But ask for the name of the bakery on one street in a small town, and only the person who grew up there knows it. Everyone's knowledge runs out somewhere, and it runs out in a different place for each person.

Models work the same way. Each one was trained on different data and keeps different details in its weights. A large model may remember an obscure fact that a smaller, cheaper one never retained. And when a model reaches the edge of what it knows, it usually still gives a specific answer, often a wrong one, and tends to repeat it.

So we ask many very specific questions that sit right at that edge. Which ones a model gets, which it misses, and what it says instead form a pattern that another model is very unlikely to reproduce. That pattern is the fingerprint. KBF doesn't score whether answers are right. It scores whether they match the reference model's answers, which is why two models with the same benchmark score can still be told apart.

## What OpenRouter checks, and what that can't see

OpenRouter checks quality, not identity, and it doesn't claim otherwise. For live traffic it checks that tool calls are well-formed and fit their schema. It also runs GPQA Diamond and τ²-Bench Airline against each provider on a recurring schedule and deranks providers that fall well below their peers ([routing post](https://openrouter.ai/blog/announcements/how-we-rebuilt-provider-routing/), [Auto Exacto](https://openrouter.ai/blog/announcements/auto-exacto), [docs](https://openrouter.ai/docs/guides/routing/auto-exacto)). That catches broken parsers and degraded deployments. But a different model that performs equally well passes both checks.

That is the case a fingerprint is built for. In the paper's controlled tests, KBF caught all 155 economically relevant substitutions across 16 production endpoints, with no false alarms on 16 same-model controls. In our own audit, M3 passed all 15 positive controls, and M2.7, M2.5 and Gemini 2.5 Flash Lite substitutes were caught.

Benchmarks ask how good a model is. A fingerprint asks whether it's the same model.

## What we did

On Nov 5, 2026 we fingerprinted 11 M3 providers through OpenRouter, pinning each request to one provider and checking that provider answered. We compared each one with MiniMax's API today. On Nov 6 we repeated the comparison against MiniMax's direct API, ran cache tests, and read OpenRouter's benchmark scores for the same providers.

## Results: two groups under one label

![Fingerprint mismatch against MiniMax's API on the horizontal axis and τ²-Bench Airline score on the vertical axis. Five MiniMax-affiliated providers cluster at 17 to 23 percent mismatch and six released-weights providers cluster at 41 to 44 percent, both at about the same benchmark score.](/img/blog/minimax-m3-fingerprinting/fingerprint-vs-benchmark.webp)

*Each dot is one provider. The two groups sit far apart on the fingerprint (left to right) and at the same height on OpenRouter's benchmark.*

| Group | Providers | Mismatch vs MiniMax API today |
| --- | --- | --- |
| MiniMax-affiliated | 5 (two with a weak or inconclusive fingerprint) | 17–23% |
| Released weights | 6 | 41–44% |

*Mismatch = share of answers that disagree with the reference, so lower is closer. Fingerprints: Antseed audit, Nov 5, 2026. Scores: OpenRouter, read Nov 6, 2026.*

Measured against MiniMax's API today, the MiniMax-affiliated group is close and the released-weights group is far. Here is what characterizes each group, and why we describe them the way we do.

**The released-weights group (6 providers).** We think these providers serve the weights MiniMax published on Jun 12. Two things point that way. Their answers agree closely with one another, which is what you would expect from six hosts running the same public files. And three of them say so themselves: two name the public `MiniMaxAI/MiniMax-M3` repo and a third describes open weights in its docs. Against MiniMax's API today they differ by 41–44%. We can't read their weights, so this is our best reading, not proof.

**The MiniMax-affiliated group (5 providers).** We call it MiniMax-affiliated because these providers behave like MiniMax's own API. Their answers track it, differing by only 17–23%, and MiniMax's own route on OpenRouter is one of the five. We also suspect that some of these providers run on the same serving infrastructure: a unique prompt we sent to MiniMax's API came back already cached from another provider in this group. That points to a technical link, not to who forwards to whom. For two of the five the fingerprint is weak or inconclusive, so their place in this group is less certain. A plausible reading is that this group serves something that came after the released weights, under the same name. What exactly it serves is unproven, and only MiniMax can say.

We also ran quick checks on the usual explanations. Quantization doesn't account for the split: providers at different quantization levels land in the same group, and the same level shows up in both. Changing the prompt template left the split in place, and thinking mode and temperature moved answers by 2–9 points, well short of the gap between the groups.

- **Fingerprint:** hard numeric-recall questions through OpenRouter with the provider fixed, Nov 5. KBF is a statistical screen, not proof of what runs, and very close sibling models can pass.
- **September record:** relies on the KBF authors' provider pin having held during enrollment. The paper's method supports that, but no response-level log exists to confirm it.
- **Direct API and cache tests:** Nov 6, one MiniMax key, so one day only.
- **Benchmarks:** OpenRouter's own, unaudited, and may mix runs from before and after the likely API change. One provider's τ²-Bench score typically swings 3–4 points between runs, more than the gap between groups.
- **Weak results:** Novita's fingerprint is weak and AtlasCloud's is inconclusive, so their place in the first group is less certain. Hugging Face maps Novita to the public repo, yet it behaves like MiniMax's API today.

## Why marketplaces need verification

One label on OpenRouter, two behaviors behind it. The benchmarks put the two groups within 1 point of each other; the fingerprint told them apart. A marketplace that only checks quality can't see this.

We want Antseed to be the best marketplace for AI inference. That only works if buyers can trust they get the model they paid for, so decentralized verification is a core part of how we keep the marketplace's quality high. No single party decides whether a seller passes. In the [Antseed Verification Layer](https://antseed.com/docs/verify/overview), a swarm of auditors comes to a consensus. Benchmarks tell you whether a model is good. Verification tells you whether it's the model you paid for.
