---
slug: antseed-verification-layer
title: "The Antseed Verification Layer is Live"
authors: [antseed]
tags: [verification, models, trust, KBF]
description: "Antseed's open-source verifier checks whether an AI API really serves the model it claims, with public evidence. Run it on any API you use."
keywords: [model verification, AI API verification, Knowledge Boundary Fingerprinting, KBF, Antseed Verification Layer, Antscan]
image: /img/blog/antseed-verification-layer/og.jpg
date: 2026-11-06
---

![Storybook ants at a leaf-roofed seed store. One carries a seed in, one checks a seed with a magnifying glass, and one pins a note to a public board.](/img/blog/antseed-verification-layer/cover.webp)

As more software runs on AI, knowing which model is doing the work becomes fundamental to trusting any of it. Today we're introducing the Antseed Verification Layer, an open way to check whether an AI API is really serving the model it claims, on Antseed or anywhere else.

In June we [laid out verification as a series of steps](https://antseed.com/blog/model-verification-fingerprint-swarm), starting with signed responses that a provider can't later deny serving. This release adds a public check on the model itself, and more steps will follow.

<!-- truncate -->

## You can't see which model answered

In June, Anthropic launched Claude Fable 5. Requests that touched certain sensitive areas, such as cybersecurity and biology, were sent to Opus 4.8, an older and less capable model. After a backlash over how hidden some of those safeguards were, Anthropic said it had "made the wrong trade-off" and promised to make them visible. In the months that followed, developers on GitHub still reported sessions that had switched from Fable to Opus without a notice, spotted only by digging through their own logs.

That was the model maker's own API, with a published policy. Most developers reach models through a router or another app, where there's even less to go on. When [researchers audited popular third-party APIs](https://arxiv.org/abs/2603.01919), 46% of their fingerprint identity tests failed, which is evidence consistent with a different model being served.

Asking the model doesn't settle it either. Its answer depends on the instructions the app gives it, so the same model can name itself differently in different apps.

The real gap is that the industry has no shared way to verify which model answered. Every AI product assumes the model on the label is the model doing the work. This is exactly the assumption we created the Antseed Verification Layer to check.

## An open check anyone can run

The Antseed Verification Layer has two parts. The first is an [open-source verifier](https://antseed.com/docs/verify/overview/) that tells you whether an endpoint's answers match the model it claims to serve. The second is a public record of results from Antseed's own market.

Antseed is an open market where anyone can become a provider and sell access to models. Providers compete on price, and buyers can reach models from many of them. In a market this open, no single company vouches for every provider, so trust has to come from checks anyone can run and results anyone can see. That's why we built verification into our network and open-sourced the tools for the whole industry.

## Every model has a fingerprint

Every model has a knowledge boundary. It's made of obscure facts the model remembers in its own way, including the ones it gets slightly wrong. A cheaper model, a smaller sibling or a compressed (quantized) copy has a different boundary.

Think of it as a pop quiz. Ask the genuine model how tall a little-known mountain is, and it gives its own particular answer, right or wrong, almost every time. A look-alike often answers differently. Over about 100 questions like that, the pattern becomes a fingerprint. The method is called [Knowledge Boundary Fingerprinting](https://arxiv.org/html/2605.29524v2) (KBF).

![A pop quiz. An examiner ant holds up a question card. One ant answers with a seed that matches the one pinned on the board, the other with a seed that doesn't.](/img/blog/antseed-verification-layer/pop-quiz.webp)

A check takes three steps:

1. **Learn the real model's answers.** The genuine model answers the questions through a trusted source, such as the model maker's own API. Questions that can't tell it apart from cheaper look-alikes are dropped. Its own error rate is measured too, because even the real model isn't perfectly consistent.
1. **Quiz the provider like a normal buyer.** An auditor buys from the provider through the normal network and payments, with nothing marking it as a test. Every check uses a fresh random set of about 100 questions, in a new order and with varied wording, so there's no fixed test to memorize.
1. **Compare the misses.** If the provider misses about as often as the real model, it's very likely the same model, and the verdict is SAME. If it misses clearly more often, it's most likely a different model, and the verdict is DIFF. If too few questions get a usable answer, because of errors, timeouts or empty replies, there's no verdict either way (UNDETERMINED).

![How a check works. Learn the real model's answers, quiz the provider like a normal buyer, then compare the misses for a SAME, DIFF or UNDETERMINED verdict.](/img/blog/antseed-verification-layer/how-a-check-works.webp)

## Every flag gets a second look, in public

One unlucky run shouldn't brand an honest provider. So when one auditor flags a provider, a second approved auditor checks it with its own questions, and the flag only counts if both agree.

Every audit is then published to IPFS, a public file network, with its full evidence:

- The questions asked
- The provider's raw answers
- The statistics
- Where the reference answers came from

A fingerprint of that evidence (its hash) goes onchain with the verdict, so anyone can tell if the evidence was changed afterwards. Anyone can also download it and re-run the same kind of check.

![Every flag gets a second look. One auditor's DIFF changes nothing on its own, a DIFF is only recorded when a second auditor also finds DIFF, and the evidence goes to IPFS, onchain and to Antscan.](/img/blog/antseed-verification-layer/second-look.webp)

Results are public on [Antscan](https://antscan.co/view/verifications). Each result covers one model from one provider, so a provider can pass on one model and get flagged on another.

Results don't last. Each one counts for one to two weeks, and providers are checked again every week, so they have to keep passing. A provider that fixes its model clears the flag at its next check.

Auditors have to be approved, and they can't check a provider they own. Every result comes with its evidence, so an auditor that posts a wrong one can be caught and lose its approval.

As of 5 November, auditors have recorded 22 audits onchain across 43 providers and 11 models, from Claude Fable 5.1 and GPT 6.1 Sol to GLM 5.3 and Kimi K3.1 Pro, with more than 34,000 answers checked.

## How verification keeps providers honest

When you pay for a model, you should get that model. On Antseed, a provider's reputation depends on it.

[Every buyer keeps its own trust score for each provider, from 0 to 100](https://antseed.com/docs/reputation). There's no central rating. Your app works out the score from public records it can check itself:

- How much paid service it has delivered and settled
- Its share of the network's recognized usage
- The ANTS staked behind it
- Identities it has proven, such as a GitHub account or a domain

The score decides who gets your requests. You set a minimum, and automatic routing sends each request to the cheapest provider at or above it.

Verification adds a check on the model itself. Once a flag is recorded, that model offer keeps only a tenth of its trust score, which puts it below the default minimum, so automatic routing stops sending it requests. The provider's other models keep their score, and the penalty lifts when the flag does.

Results also change ANTS rewards. Providers and buyers earn ANTS for paid usage, and a provider's results scale how much both of them get, across all of its models:

- Each model it passes on adds 2%, up to 50% more.
- Flags cut rewards on all of its traffic. One flag costs 4%, the cut grows quickly with each one, and five or more stop rewards entirely.
- People staking with the provider see the same change.

So backing a verified provider, as a buyer or a staker, earns more ANTS. Results never affect USDC payments, so a flagged provider is still paid for what it served. These are the current settings, which can change.

As a buyer, you don't need to set any of this up. Your app reads every result onchain and applies it on its own.

![Buyers pick by trust. Each buyer scores providers on service history, usage, stake and identity, and when two auditors agree on a DIFF that model offer keeps only 10% of its reputation.](/img/blog/antseed-verification-layer/buyers-pick-by-trust.webp)

## What's next

Audits use KBF today. We plan to add other verification methods alongside it, so a model claim can be checked in more than one way, and to make verification its own part of the trust score buyers use to choose providers. We also aim to publish research on which swaps KBF can and can't catch, and use it to choose what to add next.

## Check the model behind your API

Point the verifier at any OpenAI or Anthropic-compatible endpoint, including a router you already pay for. You only pay for the questions it asks.

![Check the model behind your API three ways. Ask your agent with the antseed-verify-model skill, run antseed verifier check, or use the model-verifier package on its own.](/img/blog/antseed-verification-layer/check-your-api.webp)

- **Ask your agent.** The [antseed-verify-model skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model) asks for an endpoint, has you set its API key, runs the check and explains the result.
- **Use the [command line](https://antseed.com/docs/commands).** `antseed verifier check <model>` finds the latest published audit for that model and runs it.
- **Run it on its own.** The [model-verifier package](https://github.com/AntSeed/antseed/tree/main/packages/model-verifier) runs the same check without the rest of Antseed.

Want to run audits for the Antseed network? [Become a verifier](https://antseed.com/docs/verify/). Once you're approved, you earn a share of ANTS rewards for each model you audit.
