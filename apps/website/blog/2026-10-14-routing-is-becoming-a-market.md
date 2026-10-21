---
slug: routing-is-becoming-a-market
title: "Introducing Routers on Antseed"
authors: [antseed]
tags: [routing, routers, open standard, buyers, sellers, Levanto]
description: "Choose a router you trust, and let it pick the model and seller for each request. Antseed is an open market for routers, with room for different approaches, protocols, and standards."
keywords: [ai model routing, llm router, inference routing protocol, open routing standard, antseed routing, levanto sage router, cost quality tradeoff, model router marketplace]
date: 2026-10-14
---

Using a powerful AI model for every request can waste money on simple tasks. A cheaper model may struggle with harder ones. Getting the balance right means knowing which model to use, and when.

We're introducing routers on Antseed to make those decisions for you.

<!-- truncate -->

## How routing works

There are two choices behind an AI request: which model should answer, and which seller should run it. A seller is a provider offering access to that model on the Antseed network.

Antseed already chooses between sellers for a selected model. A router can also choose the model itself. It ranks the available model and seller combinations, and Antseed uses that ranking to send your request.

Routers can take different approaches. Some evaluate the request to match it to a model's strengths. Others use benchmark scores or prioritize low prices.

### One agent, different tasks

Imagine a coding agent working through a feature. A router that evaluates each task could send difficult debugging work to a more capable model, then use a cheaper one to summarize the changes. You keep working with the same agent while the router handles those choices.

## What you choose

Start by selecting a router. Antseed remembers your choice and uses it for subsequent requests. You can switch routers or return to a specific model whenever you want.

You also set your preference for quality and cost:

- **Best quality:** prioritize answer quality.
- **Balanced:** balance quality and cost. This is the initial setting.
- **Lowest cost:** prioritize lower cost.

Each router applies these preferences through its own method, using the models available to it.

## The first routers

The initial lineup is planned to include:

- **Sage**, the router from [Levanto Labs](https://levanto.ai), aims to lower inference costs while preserving answer quality. Levanto reports 39% lower cost than Opus at the same accuracy in its benchmark.
- **A Jev-based router from [Decision Models](https://decisionmodels.io)**, with an [open-source implementation](https://github.com/fstandhartinger/auto-model-router) you can inspect and adapt to your own needs.
- **Antseed's free router** helps you choose among free models without paying a routing fee. Anyone can host it; it ranks models using benchmark scores, rather than evaluating each question's difficulty.

None is automatically selected for you. Routers may charge for their service; the cost of running the model is billed separately.

## Build a router people can use

Anyone can offer a router on Antseed, set a price for its service, and earn when people use it. Builders get access to the network's model providers and users, so they can focus on improving how requests are matched to models. Users can try different routers and choose based on the answers and costs they see in their own work.

Builders can integrate using their own protocol or an existing standard. The [Inference Routing Protocol](https://github.com/inference-routing/spec/blob/main/SPEC.md), developed with Levanto Labs, is one option. It defines how an app asks a router to rank candidates and how the router returns its recommendations. Antseed remains open to other protocols and standards as well.

## Better choices for your agents

Routing brings more of Antseed's value into each request. Your agents can access different models, sellers compete to serve them on price and reliability, and routers compete to choose the right combination for the work at hand.

Together, those choices create more opportunities to save: a less expensive model for a simple task, a better-priced seller for the same model, or a more capable model when the work needs it. You choose how to balance quality and cost, and your router handles the decisions request by request.

That's what we're building Antseed for: a place where your agents can get the capabilities they need at competitive prices, with the freedom to choose who provides them. Opening routing to more builders gives the whole network more ways to improve those decisions.

[Get started with Antseed](/docs/install).
