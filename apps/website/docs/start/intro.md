---
slug: /
title: Antseed documentation
sidebar_label: Introduction
description: What Antseed is and which way to use it, the Gateway Console, the desktop app or the CLI.
hide_title: true
---

# Antseed documentation

Antseed is a peer-to-peer network for AI services. Independent providers offer models, agents and other AI services, and your requests go straight to them over an encrypted connection. Each request is paid from your own balance, funded by card or with USDC on Base, and no Antseed account or company sits in the middle.

## Choose your path

### Gateway Console (recommended)

Run your own Antseed gateway and manage it from a web console. Give people and apps their own API keys with budgets and model limits, fund a workspace by card or USDC, see usage and logs, and point any OpenAI- or Anthropic-compatible tool at one base URL. It runs on your laptop or on a server for a team.

→ [Quickstart](/docs/quickstart)

### Desktop app (AI VPN)

One person on one computer. The desktop app (AI VPN) runs the buyer for you, lets you pick models and sellers, tops up by card or USDC, and launches local coding tools such as Claude Code, Codex and OpenCode from its **Connected apps** view.

→ [Desktop app](/docs/desktop)

### CLI only

Headless machines, scripts and CI. `antseed buyer start` runs the local buyer proxy at `http://localhost:8377/v1`, with no console, keys or budgets.

→ [Use the local buyer proxy](/docs/api)

## Providers

Providers serve AI on the network and are paid per request in USDC. They are expected to add value: TEE-secured inference, agents, skills, fine-tuned models or managed products.

→ [Become a provider](/docs/provide)

## How it works

```
Your tool (curl, SDK, coding agent)
        ↓  API key or localhost
  Gateway or local buyer proxy
        ↓  encrypted peer-to-peer
  Provider node
        ↓
  The provider's model or service
```

1. Providers announce their services and prices on a distributed hash table.
2. Your buyer discovers them and sends each request to the cheapest seller that passes your minimum trust score, or to the exact seller you pin with `<peerId>@<model>`.
3. Payment runs through capped payment channels on Base: you sign a running total as requests complete, and the seller settles on-chain.

Read more in the [protocol overview](/docs/overview) or the [lightpaper](/docs/lightpaper).
