---
slug: staked-free-tier
title: "#1: ANTS as a Liquid Token for AI Inference"
authors: [antseed]
tags: [ANTS, staking, free models, providers]
description: "Stake ANTS to get free AI from participating providers on Antseed. Your staking position remains tradable as lANTS."
keywords: [ANTS liquid inference, stake ANTS, free AI, staked free tier, Antseed providers, lANTS]
image: /img/blog/ants-liquid-inference-program/og.jpg
date: 2026-10-23
last_update:
  date: 2026-10-30
---


![Ants carry seeds into a leaf-roofed seed store while another ant works on a laptop at a tree stump.](/img/blog/ants-liquid-inference-program/cover.webp)

**Stake ANTS to get free AI from providers.**

We're taking the first step toward ANTS as a liquid inference token. You can now stake ANTS with participating providers on Antseed to unlock free usage of their models. Your staking position remains tradable as lANTS.

ANTS is becoming your way to access AI.

<!-- truncate -->

![Stake ANTS, get free AI: lock ANTS with a provider, reach a staking tier, and get free AI from that provider.](/img/blog/ants-liquid-inference-program/stake-ants-get-free-ai.webp)

## Why we're doing this

Antseed is an open market for AI that nobody controls. Anyone can run a provider, and you choose who serves you.

For that to work, a few things have to fit together. You need to know which providers you can trust. New providers need a fair way to earn that trust, because buyers can set a minimum trust score, and the providers that joined early already have service history, usage and stake behind them. And people who hold ANTS should be able to use it for AI.

Staking for free AI connects all three. You back a provider you like. The provider gets stake behind it, which counts toward its trust score. And you get free AI in return. If you pay for AI on Antseed, you earn ANTS every week through Antseed Points, and you could already stake it for rewards and trade that position as an lANTS NFT. Now the same stake can also get you free AI.

That's what we mean by a liquid token for inference. Your stake gets you AI, and because you can sell the position or move it to another provider, you're not tied to one provider.

## How it works

Pick a provider that offers free AI to stakers and lock ANTS in its pool. Each provider decides what its stakers get. It can run several tiers and different deals on different models.

Here's how it could look. Say you've been using Antseed and earning ANTS through Antseed Points, and you lock 10,000 ANTS for a year with a provider whose free models you already use. If that provider uses the default tiers and normally allows 100 free requests a day, your stake could raise that to 500. What you actually get depends on each provider's offer, and providers can change their offers. If you later want out, you can sell the position through your NFT or move it to another provider.

A provider can offer any of these:

| Offer | What you get when your stake qualifies |
| --- | --- |
| Free requests on a paid model | A set number of free requests on a model other buyers pay for. After that, you pay the normal price. |
| A model reserved for stakers | Free use of a model the provider keeps for stakers. Other buyers pay for it or can't use it. |
| Higher limits on free models | More free requests on models that are already free, rising with each tier. |
| Unlimited free usage | No request cap on the provider's participating models while your stake qualifies. |

What counts is your staking power: the ANTS you stake multiplied by the time left on your lock. Lock for longer and you need fewer tokens to reach the same tier. 10,000 ANTS locked for a year has the same staking power as 20,000 locked for six months.

![Lock longer, stake less: 10,000 ANTS for 1 year and 20,000 ANTS for 6 months both give 520,000 staking power. Example only; each provider sets its own tiers.](/img/blog/ants-liquid-inference-program/lock-longer-stake-less.webp)

As your lock runs down, your staking power drops, so your tier can drop too. Stakes are counted in weekly epochs, so a new stake starts counting from the next epoch, and it only counts with the provider you picked.

To see every provider's current offers, give your agent the [Antscan free-tier feed](https://antscan.co/api/free-tier).

## Your position stays liquid

Your stake is an lANTS NFT, an onchain record of your position. You don't spend the tokens. They stay yours, locked in that provider's pool, and earn staking rewards while they're there. You can also sell the position, and the buyer takes over its remaining lock.

If a provider stops being a good fit, you can move the position to another provider’s pool. It keeps the same amount and lock, and the move takes effect in the next epoch.

But be careful with the lock: withdrawing early burns part of your stake. The earlier you withdraw, the more is burned, from 50% at the start of the lock down to a minimum of 5%. Selling or moving the position doesn't burn anything. Only lock ANTS if you're comfortable with the lock terms.

![What you can do with your stake: keep it, move it, sell it, or withdraw early, which burns 5% to 50% of your stake.](/img/blog/ants-liquid-inference-program/what-you-can-do-with-your-stake.webp)

## Run a provider? Turn on staked free tiers

Free requests cost you real money, and they don't earn usage points. In return, you get stake in your pool. It counts toward your trust score, which buyers use to pick providers, and it adds to your pool weight, which boosts the points your paid usage earns.

Stake is one part of a bigger reputation system. Buyers score every provider from 0 to 100 with data they can check themselves: service history, recognized usage, staking power and verified identity, plus a bonus for offering a free model. Buyers can also set a minimum score. Offering free AI to stakers adds to the staking power part, and a model priced at $0 also earns the free model bonus.

This matters more as the network grows. We want Antseed to run on millions of computers, with anyone serving models from their own machine. If you run a model locally with Ollama or llama.cpp, you can already join as a provider, and the Antseed Foundation gives extra consideration to local AI infrastructure when it chooses providers to stake behind. Staked free tiers give those new providers a way to start building trust.

Staked tiers are on by default once you set up a free tier. Use the default tiers, set your own, or run different offers on different models. The setup is in the [staked tiers docs](/docs/provide/config/#staked-tiers).

Want help setting it up? Just send us a DM on X.

## What’s next

This is the first step. Today, your stake counts with the one provider you stake with. Next, we want to make this multi-provider, so one stake can get you free AI from more than one provider. More on that soon.

## Get started

Not every provider offers this yet. The quickest way to find the ones that do is to ask your agent:

> Check Antscan's free-tier feed (antscan.co/api/free-tier) for providers offering staking benefits, including free requests on normally paid models. Compare the models, free usage and required staking power, showing how different amounts and lock durations qualify. Then help me stake with the provider I choose. Show me the terms and ask for confirmation before submitting any transaction.

You can also look for the stake prompt next to free models in the [AI VPN desktop app](https://github.com/AntSeed/antseed/releases/latest) or the [Gateway](/docs/quickstart/) on [the Antseed website](/).
