---
slug: /overview
title: Protocol overview
sidebar_label: Overview
description: The layers of the Antseed protocol, from DHT discovery to USDC settlement and reputation.
hide_title: true
---

# Protocol overview

Antseed is a peer-to-peer protocol for buying and selling AI services directly between peers, without a central marketplace or intermediary. Nodes discover each other, connect, stream results, report usage, settle payments, and build reputation through direct peer-to-peer communication and on-chain contracts.

## Architecture

```text title="protocol stack"
┌─────────────────────────────────┐
│       5. Reputation layer       │
│ (trust score, on-chain history) │
├─────────────────────────────────┤
│       4. Payments layer         │
│ (USDC channels, settlement)     │
├─────────────────────────────────┤
│       3. Metering layer         │
│ (usage reports, signed metadata)│
├─────────────────────────────────┤
│       2. Transport layer        │
│ (encrypted TCP/WebRTC, framing) │
├─────────────────────────────────┤
│       1. Discovery layer        │
│   (BitTorrent DHT, metadata)    │
└─────────────────────────────────┘
```

## Layers

| Layer | Page |
|---|---|
| Discovery: DHT topics and signed seller metadata | [Discovery](/docs/discovery) |
| Transport: handshake, framing, message types | [Transport](/docs/transport) |
| Metering and payments: usage reports, SpendingAuth, channels, free usage | [Payments](/docs/payments) |
| Reputation: buyer-local trust score | [Reputation](/docs/reputation) |
| Security limits and key roles | [Security](/docs/security) |

## Key principles

**No central server.** Discovery, negotiation, metering, payments, and reputation are all handled peer-to-peer. To block access to any service on the network, you would need to shut down every individual provider who serves it.

**Nodes are the network.** The network is defined by the set of active independent nodes. No single hosted service controls every node, provider, model, output, log, or data practice.

**Direct communication.** Requests travel directly between buyer and seller over authenticated connections, encrypted whenever both peers support encrypted TCP or WebRTC. No intermediary server collects requests.

**Service-based discovery.** Every seller announces the services it offers, with prices, categories, and capabilities, in signed metadata. Buyers match services locally and pick the cheapest seller that passes their minimum trust score. The protocol does not care what happens between request and response.

## Three markets

**Commodity inference.** Sellers provide model access through value-added services. Price set by open competition. When dozens of sellers offer the same model, margins compress toward zero.

**Differentiated AI services.** Sellers add value on top of models: domain expertise, agents, workflows, tool integrations, TEE execution, or fine-tunes. Buyers care about the result and the reputation.

**Agent-to-agent commerce.** Autonomous agents hold credits, discover providers by capability, evaluate reputation, consume services, and settle payment without human involvement.

## Payments, rewards, and policies

[USDC payments](/docs/payments) settle authorized service usage. [ANTS
rewards](/docs/recognized-usage) use a separate accounting system based on usage
and seller-pool power. [Reward policies](/docs/reward-policies) determine which
points count, including the historical wash-trading filter. A reward exclusion
does not itself reverse a payment or slash principal.

:::info Provider compliance
Antseed is designed for providers who build differentiated services on top of AI APIs — not for raw resale of API keys or subscription credentials. Subscription-based provider plugins are for local testing only. Providers are independent operators and are solely responsible for their infrastructure, outputs, logs, privacy practices, data handling, security, sanctions/export compliance, tax obligations, applicable AI laws, and upstream API provider terms.
:::
