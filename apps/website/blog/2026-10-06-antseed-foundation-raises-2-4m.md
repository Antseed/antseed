---
slug: antseed-foundation-raises-2-4m
title: "The Antseed Foundation Has Raised $2.4M. Here's How to Participate and Earn."
authors: [antseed]
tags: [foundation, providers, ANTS, earn]
description: "The Antseed Foundation has raised $2.4M in a token round led by Spark Capital. Learn how to buy inference, become a provider, and earn through qualifying network activity."
keywords: [Antseed Foundation, Antseed funding, AI inference, AI providers, ANTS rewards]
image: /img/blog/antseed-foundation-raises-2-4m/cover.png
date: 2026-10-06
---

![The Antseed Foundation's $2.4M raise, with Spark Capital, Reciprocal Ventures, Relayer Capital, Collider, Venice, North Island Ventures, and DCG](/img/blog/antseed-foundation-raises-2-4m/cover.png)

The Antseed Foundation has raised $2.4M in a token round led by Spark Capital, with participation from Collider, DCG, North Island Ventures, Reciprocal Ventures, Relayer Capital, and Venice.ai.

What BitTorrent did for files, we want to do for AI inference. Anyone should be able to buy and sell access to AI models, on their own terms.

<!-- truncate -->

You should be able to choose which models your agents use, who serves them, and what you pay. And if you can provide useful inference, you should be able to reach buyers, earn from your work, and build a reputation.

Antseed is already live. You can connect the tools you use today, offer a model running on your own hardware, and earn rewards through qualifying network activity.

Here's how to take part.

**If you use AI, you can join as a buyer.** Antseed connects your apps and agents to independent providers offering models on the network. Providers set their prices and compete for requests. You choose the model and the conditions under which you want to use it.

The router runs on your machine. It discovers providers and connects directly to them over an encrypted peer-to-peer connection. Paid usage settles in USDC on Base. [How Antseed works](/docs/).

The easiest way to begin is with the AI VPN:

1. Download it from [antseed.com](https://antseed.com) and start the local router.
2. Browse the available models and compare provider offers.
3. Choose a provider yourself, or let automatic routing select one using your price and trust preferences.
4. Try the built-in chat or connect a supported app. Start with an available free model, or add credits for paid usage.

You can set maximum token prices and a minimum trust score for automatic routing. You pay for the inference you use, without an Antseed subscription. The [AI VPN guide](/docs/guides/vpr/) walks through these settings and connecting your apps.

If you prefer the terminal, use the CLI to install Antseed, start your buyer, and send your first request:

```bash
# 1. Install
npm install -g @antseed/cli

# 2. Set your identity
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 3. Start the buyer proxy
antseed buyer start
# Proxy listening on http://localhost:8377

# 4. Browse available models and peers
curl -s http://localhost:8377/v1/models | jq '.data[].id'
antseed network browse

# 5. Make a request — the model name selects the highest-ranked eligible
#    offer under your shared Price + Trust routing preferences
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 6. Deposit USDC when you want to pay providers
antseed buyer deposit
# Shows your funding address + QR code; incoming USDC deposits automatically
```

Your tools connect to a local endpoint at `http://localhost:8377`, which handles discovery, routing, and payments. The [API setup guide](/docs/guides/using-the-api/) covers configuration and connecting your tools.

Privacy is also part of choosing a provider. Antseed does not require a central account or email, and traffic between peers is encrypted. A standard provider still processes the prompt you send it. For providers advertising TEE support, your buyer can check hardware attestation evidence locally. What that evidence covers matters when choosing where to send sensitive requests. [Read how TEE verification works](/blog/dont-trust-the-tee-label/).

**If you provide inference, you can join as a seller.** You might run an open model on your own machine, have a fine-tuned model for a particular task, or operate a professional inference service with confidential computing.

You choose what to offer and how much to charge. Antseed provides discovery, connections to buyers, and payment settlement. Providers receive USDC for paid requests and can earn additional ANTS rewards from qualifying activity. [Become a provider](/docs/guides/become-a-provider/).

If you already use Ollama, llama.cpp, or another server with an OpenAI-compatible API, the local LLM plugin connects your running model to Antseed:

```bash
antseed plugin add @antseed/provider-local-llm
```

You keep running the model on your hardware. Configure the models you want to expose, set input and output token prices, and limit concurrent requests to what your machine can handle. Pricing starts at zero, so configure paid pricing when you're ready to charge.

Perhaps you've built a model that handles a particular language well, or a setup that reliably extracts information from documents. Offering it on Antseed gives other people a way to try it and keep using it if it meets their needs.

Earnings depend on demand, your prices, and the cost of running the service. Our [local model guide](/blog/earn-from-your-local-ai-model/) explains how to get started.

**Both buyers and sellers can earn ANTS.** The network's rewards are tied to qualifying paid usage, with eligibility determined by the protocol's rules, provider pool stake, and reward policies.

For buyers, this means eligible AI usage can earn ANTS. For sellers, ANTS rewards are additional to the USDC revenue they receive for serving requests. Free requests do not qualify as paid usage, and paid activity does not automatically earn rewards. [How ANTS rewards work](/docs/recognized-usage/).

You can also use ANTS to back a provider by staking into its pool. The provider's qualifying activity helps determine the pool's rewards. Your share depends on your staking power relative to other participants, including how much you lock and for how long.

Staking rewards vary. Withdrawing before the lock expires can burn part of your staked ANTS. You can explore providers, review available rewards, and manage positions through the dashboard opened by:

```bash
antseed ants
```

The [staking guide](/docs/guides/staking/) covers claiming rewards, staking, and managing your positions.

We established the [Antseed Foundation](/blog/announcing-antseed-non-profit-foundation/) to support the network's development and independence. This raise helps us continue that work with the people using and providing AI.

Thank you to all of our investors for backing our mission:

- Spark Capital, lead investor
- Collider
- DCG
- North Island Ventures
- Reciprocal Ventures
- Relayer Capital
- Venice.ai
- Albert Castellana
- Andy from The Rollup
- Yan Liberman
- Tommy Shaughnessy
- Drew Austin

Every buyer brings a use case. Every provider brings another option. We want the people making this market useful to share in its growth.

[Try Antseed](https://antseed.com), send your first request, or connect a model you run. Tell us what you're building. 🐜
