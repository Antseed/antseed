---
slug: routing-is-becoming-a-market
title: "Routing Is Becoming a Market"
authors: [antseed]
tags: [routing, routers, open standard, buyers, sellers, Levanto]
description: "You shouldn't have to pick a model before you ask. Now a router can choose the model and the seller for you, and anyone can offer to be that router. It's built on an open standard we wrote with Levanto Labs."
keywords: [ai model routing, llm router, inference routing protocol, open routing standard, antseed routing, levanto sage router, cost quality tradeoff, model router marketplace]
date: 2026-10-14
---

Until now, using Antseed started with a question you shouldn't have to answer: which model do you want?

Now you don't have to. Just ask, and a router picks the model and the seller for you. Anyone can offer to be that router, and you choose whose picks to trust.

<!-- truncate -->

## Before: you pick the model first

Before you've typed a word, you choose a model. A big, expensive one for the hard stuff, or a small, cheap one for quick questions.

But you don't know yet how hard your next message will be. Pick the strong model and you overpay for every easy question. Pick the cheap one and the hard question gets a weak answer. Then you switch models by hand, and do it all again.

Once you've chosen, Antseed looks at every seller on the network that offers that model. It drops the ones it doesn't trust enough and picks the cheapest of the rest. If that seller fails, it moves on to the next one. It's a good rule, and it stays as the default.

## Now: ask and get the best model for the task

A router takes over the first step. You send your message, and the router decides which model should answer and which seller should run it. It looks at what kind of task it is, so a coding question goes to a model that's strong at code, and a writing task goes to one that writes well. An easy question can go to a fast, cheap model. A hard one can go to a stronger model, without you touching anything.

That decision is more than "cheapest". A seller that already holds your whole conversation in its cache can cost less than one with a lower price tag, and a router can see that. You still decide what matters most, with three settings:

- **Best quality:** the strongest models, at the highest price.
- **Balanced:** good answers at a moderate price. This is the default.
- **Lowest cost:** the cheapest model that can handle the request.

## The power of an open market

Antseed is already an open market for models: anyone can sell one, and sellers compete on price and quality. Routing joins it. Anyone can offer a routing service, set a price per ranking, and compete to give the best one.

An open market also makes room for new ideas. Anyone can try their own approach to routing, put it on the network, and let users decide whether it's better. The best routers rise to the top, and you get to use them.

Here are the first routers:

- **[Levanto Labs](https://levanto.ai)** routes with Sage, their own decision model.
- **[Decision Models](https://decisionmodels.io)** offers a Jev-based router. It's [open source](https://github.com/fstandhartinger/auto-model-router).
- **Antseed's free router** is one we built ourselves. Anyone can host it, and it sends each request to the best free models on the network.

## An open standard, built with Levanto

Today, every routing product works differently, and most routers are built for one specific platform. A tool built for one router can't use another.

So we wrote the [Inference Routing Protocol](https://github.com/inference-routing/spec/blob/main/SPEC.md) with Levanto Labs: a common language for routers. Any router that speaks it works with any app that does, and you can swap one for another without changing anything else.

We want this to become the industry standard for routing.

## Try it, or build one

**Want better answers without picking a model?** [Install Antseed](/docs/install), choose a router, and just ask.

**Building a router?** Antseed is permissionless, so anyone can offer their router. Read the [spec](https://github.com/inference-routing/spec/blob/main/SPEC.md) and put yours on the network.
