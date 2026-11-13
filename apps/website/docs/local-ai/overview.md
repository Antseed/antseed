---
title: Local AI on Antseed
slug: /local-ai
sidebar_label: Overview
description: Earn from models running on your own hardware, either as your own seller or as a worker in a colony pool that serves buyers from many Macs.
---

# Local AI on Antseed

A model running on your own machine can serve Antseed buyers and earn USDC for every answer. There are two ways to do it:

| | Run your own seller | Join a colony pool |
|---|---|---|
| **Who it suits** | One machine you keep online, with a public address | Macs and desktops that come and go, behind any home network |
| **What you run** | The Antseed CLI with the `local-llm` plugin, in front of Ollama, llama.cpp or another OpenAI-compatible server | Antseed Colony, or `antseed-pool-worker` in front of a local model server |
| **Who stakes, settles and sets prices** | You | The pool's operator |
| **How you're paid** | Settlements go to your seller | The pool contract splits each settlement between its workers; you claim to your own wallet |
| **Guide** | [Earn from your local AI model](/blog/earn-from-your-local-ai-model) and [Become a provider](/docs/provide) | [Earn with your Mac](/docs/local-ai/mac), [Other machines](/docs/local-ai/worker) |

The rest of this section covers colony pools.

## Colony pools

A colony pool is one Antseed seller that serves buyers from many worker machines. Workers dial out to the pool, so a Mac behind a home router needs no open port. The pool stakes, holds the buyers' payment channels and settles on-chain; buyers see one seller.

```
buyer ──encrypted request──▶ pool seller ──▶ worker (your Mac)
buyer ◀─encrypted answer──── pool seller ◀── worker
```

Three things keep the split honest without trusting the pool operator:

1. **End-to-end encryption.** The buyer encrypts each request for the worker that will answer it, and the worker encrypts its answer back. The pool routes ciphertext: it can't read prompts or claim that another worker answered. See [Privacy and verification](/docs/local-ai/privacy).
2. **Buyer-signed attribution.** Every payment the buyer signs names how much it has paid each worker on that channel.
3. **On-chain split.** The `AntseedColonyPool` contract settles like any seller, reads that attribution, and credits each worker its share of the USDC and of the pool's ANTS emissions. Workers, or the wallets they link, claim directly from the contract.

### How a worker gets paid

- The pool tells each worker its prices when it joins. A worker serves a paid service only.
- Each request carries the buyer's latest signed payment on its channel. A worker serves a channel only while that payment covers its earlier answers there, at most one answer behind, so nobody, the pool operator included, gets more than two unpaid answers out of it.
- An answer cut off after the buyer started receiving it (cancelled, or the connection dropped) isn't paid, since the buyer can't verify an answer without its end. A worker serves a channel at most two such answers in 30 minutes, so cancelling every answer gets almost no work.
- Before it counts a payment, the worker reads the pool contract to see what the pool has already settled and paid it on that channel. When a settlement credited the worker less than the buyer signed, the answers that payment covered are owed again until a later payment or settlement pays for them.
- Each settlement pays the worker its share after the 2% protocol fee and the pool's operator fee (10% by default, 20% at most). Attribution a settlement couldn't cover stays owed and is paid first from the next one. A settlement's unattributed part waits one settlement before it goes to the pool, so a worker the buyer attributes it to just after is still paid.
- Workers keep their account of each channel across restarts.

### What still takes trust

- The operator decides routing. It can stop sending work to a worker, which then leaves for another pool.
- The machine that answers decrypts the prompt. The Mac app keeps the machine's owner out of the app itself, but this is weaker than a TEE. See [Limits](/docs/local-ai/privacy#limits).

## In this section

- [Earn with your Mac](/docs/local-ai/mac): run Antseed Colony, link your wallet and claim.
- [Other machines](/docs/local-ai/worker): serve a pool from any OpenAI-compatible local server.
- [Run a pool](/docs/local-ai/run-a-pool): deploy the pool contract and run the seller workers connect to.
- [Privacy and verification](/docs/local-ai/privacy): what buyers can check about the Mac that answers them.

The full protocol is in the [colony pool specification](https://github.com/Antseed/antseed/blob/main/docs/protocol/colony-pool.md).
