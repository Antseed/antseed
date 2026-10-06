---
sidebar_position: 1
slug: /overview
title: Protocol Overview
sidebar_label: Overview
hide_title: true
---

# Protocol Overview

Antseed is a fully decentralized protocol for buying and selling AI services directly between peers, without any central server, marketplace, or intermediary. Nodes discover each other, negotiate terms, stream results, meter token usage, settle payments, and build reputation — all through direct peer-to-peer communication.

## Architecture

```text title="protocol stack"
┌─────────────────────────────────┐
│       5. Reputation Layer       │
│   (trust scoring, attestations) │
├─────────────────────────────────┤
│       4. Payments Layer         │
│   (USDC deposits, settlement)   │
├─────────────────────────────────┤
│       3. Metering Layer         │
│   (token counting, receipts)    │
├─────────────────────────────────┤
│       2. Transport Layer        │
│ (encrypted TCP/WebRTC, framing) │
├─────────────────────────────────┤
│       1. Discovery Layer        │
│   (BitTorrent DHT, metadata)    │
└─────────────────────────────────┘
```

## Key Principles

**No central server** — discovery, negotiation, metering, payments, and reputation are all handled peer-to-peer. To block access to any service on the network, you would need to shut down every individual provider who serves it.

**Nodes ARE the network** — the network is defined by the set of active independent nodes. No single hosted service controls every node, provider, model, output, log, or data practice.

**Direct communication** — all interactions happen directly between the two parties involved. Communication is encrypted end-to-end. There is no intermediary server collecting requests.

**Skill-based discovery** — every seller declares Skills that define what they deliver. Buyers search by capability, sort by reputation, and get results. The protocol does not care what happens between request and response.

## Three Markets

**Commodity inference** — sellers provide model access through value-added services. Price set by open competition. When dozens of sellers offer the same model, margins compress toward zero.

**Differentiated AI services** — sellers equip models with Skills (domain expertise, workflows, tool integrations). Buyers don't care what's inside. They care about the result and the reputation.

**Agent-to-agent commerce** — autonomous agents hold credits, discover providers by capability, evaluate reputation, consume services, and settle payment without human involvement.

## Payments, rewards, and policies

[USDC payments](./payments.md) settle authorized service usage. [ANTS
rewards](./recognized-usage.md) use a separate accounting system based on usage
and seller-pool power. [Reward policies](./reward-policies.md) determine which
points count, including the historical wash-trading filter. A reward exclusion
does not itself reverse a payment or slash principal.

:::info Provider Compliance
Antseed is designed for providers who build differentiated services on top of AI APIs — not for raw resale of API keys or subscription credentials. Subscription-based provider plugins are for local testing only. Providers are independent operators and are solely responsible for their infrastructure, outputs, logs, privacy practices, data handling, security, sanctions/export compliance, tax obligations, applicable AI laws, and upstream API provider terms.
:::
