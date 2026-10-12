---
slug: claude-code-pricing-breakeven
title: "Claude Code Pricing: When $20 Stops Being Cheap"
authors: [antseed]
tags: [pricing, Claude, cost, AI infrastructure, P2P, API pricing]
description: Claude Code pricing breaks even near 351 requests a month. Here is the math, from Anthropic's published rates and 14 million real agent requests.
keywords: [claude code pricing, claude code cost, claude code pro vs api, claude api pricing, claude opus 5 price, cost per request, prompt caching cost]
image: /og-image.jpg
date: 2026-08-11
---

Claude Code pricing comes in two shapes: a $20 per month Pro subscription, or per-token API billing where you pay for exactly what you use. The switchover point is sharper than most people expect. At Anthropic's published Opus 5 rates and a realistic agent workload, the subscription stops being the cheaper option at roughly **351 requests a month**. That is about a dozen a day.

Below that, pay the $20 and stop reading. Above it, the arithmetic starts to matter, and it matters in a direction most cost comparisons get backwards. If you are on the $200 Max tier, the same maths puts your breakeven near 3,500 requests a month, and we work that one out further down.

<!-- truncate -->

## How does Claude Code pricing work?

Claude Code is billed two ways: a seat, or a meter.

The seat side is the subscription ladder. Every tier below includes Claude Code alongside the chat product, and what separates them is how much usage you get before you hit a limit.

| Plan | Price | Notes |
|---|---|---|
| Pro, monthly | $20 / month | The number most people mean by "Claude Code pricing" |
| Pro, annual | $17 / month | Billed $200 up front, so roughly 15% off for a year of commitment |
| Max 5x | $100 / month | Five times Pro's usage allowance |
| Max 20x | $200 / month | Twenty times Pro's usage allowance |

Plan prices checked against [Anthropic's plans page](https://claude.com/pricing) in August 2026. Subscription tiers get repriced and repackaged more often than API rates do, so treat the table as a snapshot and check the live page before you budget a year against it. The arithmetic below is what matters, and it works with whatever numbers are current: divide the monthly fee by your cost per request.

The meter side is the API, billed per million tokens, split into input and output, with a separate and much cheaper rate for cached input.

Here are the published API rates, taken from [Anthropic's pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing). Verified August 2026.

| Model | Input / MTok | Output / MTok | Cache read / MTok |
|---|---|---|---|
| Claude Opus 5 | $5.00 | $25.00 | $0.50 |
| Claude Sonnet 5 (through Aug 31) | $2.00 | $10.00 | $0.20 |
| Claude Sonnet 5 (from Sep 1) | $3.00 | $15.00 | $0.30 |
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 |
| Claude Fable 5 | $10.00 | $50.00 | $1.00 |

One pattern worth noticing before we go further: output is priced at exactly five times input on every single model. Opus, Sonnet, Haiku, Fable. That ratio never moves. Hold onto it, because it collides with something in the traffic data.

## The breakeven is 351 requests a month

To turn rates into a bill you need to know the shape of a real request, not a hypothetical one. We pulled ours from the [Antseed network stats endpoint](https://network.antseed.com/stats), which reports live totals across the peers currently online.

As of 11 August 2026, that endpoint reports 13,984,528 requests carrying 88.96 billion input tokens and 14.07 billion output tokens. The average request is **6,361 input tokens and 1,006 output tokens**.

One honest caveat: those totals cover all traffic on the network, not Claude Code specifically. Agent-shaped workloads dominate it, but treat the ratio as a good proxy rather than a measurement of Claude Code itself.

Run that shape through the published rates and you get cost per request:

| Model | Cost per average request | Requests to reach $20 | Requests to reach $200 |
|---|---|---|---|
| Claude Opus 5 | $0.0570 | 351 | 3,512 |
| Claude Sonnet 5 (intro) | $0.0228 | 878 | 8,779 |
| Claude Haiku 4.5 | $0.0114 | 1,756 | 17,558 |
| Claude Fable 5 | $0.1139 | 176 | 1,756 |

If you run Opus 5 for real work, a dozen requests a day puts you at the Pro price. A working session with a coding agent can burn that before lunch.

![Line chart of Claude Code pricing: the flat $20 per month Pro subscription against per-token API cost, crossing at 351 requests per month without caching and at 641 requests with a 90% cache hit rate](/img/blog/claude-code-pricing-breakeven.svg)

The chart is the whole argument. The flat line is what you pay Anthropic today. The steep line is what you pay per token. Where they cross is the only number in this post that matters, and caching moves it a long way to the right.

Max 20x is off the top of that chart. At $200 a month you would need about 3,512 Opus 5 requests before the API is cheaper, which is roughly 117 a day, every day. That is a genuinely heavy user, and we come back to what it means below.

## Why input tokens are 56% of your bill

Here is the collision. Output costs five times what input costs. But real agent traffic sends **6.32 input tokens for every output token**, because coding agents re-send the file, the diff, the tool schemas, and the whole conversation on every turn.

Six point three two against a five times price multiple means input wins. At the observed traffic shape, **input is 56% of the bill and output is 44%** -- and because both ratios are fixed, that split is identical for every model in the table above.

This is the part most Claude Code pricing comparisons get backwards. They benchmark on the output number, because it is the big scary one. The larger line item is the number nobody quotes.

### Does that change which model I should pick?

Not directly, since the split is the same everywhere. What it changes is where you spend optimization effort. Trimming what you send Claude, and caching what you must re-send, moves more money than switching to a model with a cheaper output rate.

## Does prompt caching change the answer?

Yes, substantially. Anthropic charges cache reads at 0.1x the base input rate, a flat ten times discount. Cache writes cost 1.25x for the five-minute window or 2x for the one-hour window, so caching pays for itself after a single read on the short window.

Apply a 90% cache hit rate to an Opus 5 workload and cost per request falls from $0.0570 to $0.0312. The Pro breakeven moves from 351 requests a month to **641**, and the Max 20x breakeven moves from 3,512 to about 6,412. Caching is the single biggest lever available before you change anything about where your requests go.

We will say the uncomfortable part plainly: on a cache-heavy workload under about 600 requests a month, the $20 subscription is the right answer and no marketplace is going to beat it. Buy the subscription.

## What an open market charges for the same models

Above that line, the question changes from "subscription or API" to "whose API". This is where an open market of independent providers gets interesting, and where the numbers stop being flattering in one direction only.

The table below compares Anthropic's list input price against what providers on the Antseed network were actually charging on 11 August 2026.

| Model | Providers | Official | Market median | Market low | Below list |
|---|---|---|---|---|---|
| claude-opus-5 | 9 | $5.00 | $3.00 | $0.28 | 8 of 9 |
| claude-opus-4-8 | 14 | $5.00 | $1.92 | $0.99 | 9 of 14 |
| claude-fable-5 | 13 | $10.00 | $4.95 | $1.70 | 11 of 13 |
| claude-haiku-4-5 | 5 | $1.00 | $0.35 | $0.07 | 4 of 5 |
| claude-sonnet-5 | 9 | $2.00 | **$2.09** | $0.12 | 4 of 9 |

Read the last row before the other four. Sonnet 5's market median sits *above* Anthropic's list price, and only four of nine providers beat it. That is not a bug in the market, it is a lag: Anthropic cut Sonnet 5 to $2 as introductory pricing through 31 August, and independent providers have not repriced against a temporary discount that expires in three weeks.

Caching tells a similar story. Of 201 Claude-family services quoting prices on the network, 162 publish a cached input rate, at a median discount of 7.7x. Anthropic's flat 10x is better. If your workload lives in the cache, first-party pricing is genuinely competitive and we are not going to pretend otherwise.

Where the market does win is the base input rate, which is the 56% of your bill we established earlier. A median of $3.00 against a list price of $5.00 on Opus 5 is a 40% cut on the largest line item.

## When you should just pay the $20

A short list, because a pricing post that finds no case for the incumbent is an advert.

- **Under a dozen Opus requests a day.** The subscription is cheaper and there is nothing to manage.
- **Cache-heavy workloads under roughly 600 requests a month.** Anthropic's 10x cache discount beats the market median.
- **You need first-party support, an SLA, or a procurement relationship.** An open network of independent providers does not offer any of those.
- **Your finance team wants one predictable line item.** Per-request billing is cheaper and less legible. That trade is real.

### What about the $200 Max tier?

Max 20x is the interesting case, because the breakeven runs both ways. At 3,512 Opus 5 requests a month you are paying $200 either way. Below that, Max is the more expensive choice and Pro or the API is cheaper. Above it, Max is a bargain and the flat fee is doing real work for you.

The catch is that Max sells a usage allowance, not unlimited usage. If you are the kind of user who genuinely clears 117 requests a day, you are also the kind of user most likely to hit the limit and stop working. Per-token billing has no ceiling to hit. That is the actual trade at the top of the ladder, and it is not really about price.

One boundary worth stating clearly, since it comes up whenever provider economics do: providers on an open network are expected to offer differentiated services on their own infrastructure. Reselling subscription credentials violates upstream terms and is not something the network is for.

## How to check your own numbers

Do not take our request shape. Take yours.

0. Check what your plan costs today on [Anthropic's plans page](https://claude.com/pricing). That is the numerator and it moves.
1. Pull your actual token counts from the `usage` block Anthropic returns on every response. You want `input_tokens`, `output_tokens`, and `cache_read_input_tokens` separately.
2. Compute your own input-to-output ratio. If it is far below 6.32:1 you are doing something unusual and the output rate matters more for you than it does for most.
3. Multiply by the published rates in the first table. That is your monthly bill at first-party pricing.
4. Compare against live market rates with `curl -s https://network.antseed.com/stats`, or the [Antseed pricing schema documentation](/docs/pricing) if you want the field definitions.

If you decide the numbers justify moving, [pointing Claude Code at a different backend](/integrations/claude-code) is a base URL change and takes about two minutes. If you want the broader argument for why routing through an open market beats routing through one company's gateway, we made it in our [comparison against OpenRouter](/vs/openrouter).

The number to remember is 351. Everything above that is arithmetic you should run on your own traffic, not ours.
