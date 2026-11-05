---
title: Become a provider
slug: /provide
description: Install the CLI, create a seller identity, register on Base, add services and start serving buyers on the Antseed network.
---

# Become a provider

Providers earn USDC by serving AI requests to buyers on the Antseed network. This guide takes you from a fresh machine to a seller that buyers can reach.

:::warning Add value, don't resell access
Antseed is for providers who build differentiated services: TEE-secured inference, domain-specific skills or agents, fine-tuned models, or managed products. Reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms. The subscription-based plugins (`claude-code`, `claude-oauth`, `openai-responses`) are for testing only. You are responsible for complying with your upstream provider's terms.
:::

## Prerequisites

- Node.js 20 or newer.
- An upstream to serve from: an OpenAI-compatible API key, an Anthropic API key, or a local model server (Ollama or llama.cpp).
- A little ETH on Base for the gas your seller spends on registration and settlement.
- A machine with a public IP address, or a port you can forward to it.

## 1. Install the CLI

```bash
npm install -g @antseed/cli
```

See [Install](/docs/install) for other options.

## 2. Create your identity

Your identity is a secp256k1 private key. Its EVM address is both your peer ID on the network and the wallet that receives your USDC.

Run the setup wizard. It creates a key at `~/.antseed/identity.key` if you don't have one, then walks you through adding a provider and services:

```bash
antseed seller setup
```

To use a key you already manage (for example from a secrets manager), set it in the environment instead. It takes precedence over `identity.key`:

```bash
export ANTSEED_IDENTITY_HEX=<64-hex-char-private-key>
```

Use a dedicated key for your seller. To encrypt `identity.key` at rest, see [Protecting wallet keys](/docs/gateway/wallet-keys); an encrypted key needs `ANTSEED_PASSPHRASE` or `ANTSEED_PASSPHRASE_FILE` set whenever the seller starts.

## 3. Fund and register

Send a small amount of ETH on Base to your seller address, then register your identity on-chain:

```bash
antseed seller status     # shows your wallet address
antseed seller register
antseed seller status     # "Seller eligible" should now be true
```

Staking is optional for selling. To earn ANTS rewards on top of USDC, see [Staking](/docs/provide/staking).

For production, point the seller at your own Base RPC endpoint rather than the public default. See [Base RPC](/docs/buyer-config#base-rpc-url).

## 4. Add services

Everything you announce lives in `~/.antseed/config.json`. If you skipped the wizard, add a provider (which installs its plugin) and then one entry per service:

```bash
antseed config seller add-provider inference \
  --plugin openai \
  --base-url https://api.example-inference.com

antseed config seller add-service inference deepseek-v4-flash \
  --upstream "<upstream-model-id>" \
  --input 0.25 --cached 0.025 --output 1 \
  --categories coding

antseed config seller add-service inference kimi-k2.6 \
  --upstream "<upstream-model-id>" \
  --input 0.6 --cached 0.06 --output 2.5 \
  --categories coding
```

Prices are USD per million tokens. `--upstream` maps the service name buyers request to your upstream's model ID; omit it when they match. Set `--base-url` without the `/v1` suffix, because the plugin appends the request path.

For a local model, use the `local-llm` plugin:

```bash
antseed config seller add-provider ollama --plugin local-llm
antseed config seller add-service ollama gpt-oss-120b --input 0 --output 0
```

See [Seller configuration](/docs/provide/config) for capabilities, categories, free-tier limits and every other setting, and [Image and video services](/docs/provide/media) for per-image and per-video pricing.

## 5. Start the seller

Upstream credentials stay in environment variables; everything else comes from `config.json`:

```bash
export OPENAI_API_KEY=<your-upstream-key>
antseed seller start
```

`seller start` checks before it begins announcing: at least one service per provider, ETH for gas, and on-chain registration. It prints what is missing and the command that fixes it.

It also serves your seller dashboard on `127.0.0.1:3120`: status, model health, gas, earnings, request logs, prices against other sellers, settings and alerts. In a terminal, `seller start` prints the link. For a seller running as a service, `antseed seller dashboard` prints it. Pass `--no-dashboard` to turn it off. See [Monitoring](/docs/provide/monitoring).

## 6. Make sure buyers can reach you

The seller listens on UDP 6881 (DHT) and TCP 6882 (buyer connections). Allow both through your firewall, then tell buyers which address to dial:

```bash
antseed config seller set publicAddress "peer.example.com:6882"
antseed seller doctor
```

`seller doctor` checks that the announced address is public and opens a TCP connection to it. A successful local probe does not prove that the port is open from outside, so confirm from another network:

```bash
antseed network peer <peerId>
```

Your services, prices and categories should appear. Run `antseed network browse` to see where you sit among other providers.

## Next steps

- [Seller payments](/docs/provide/payments): how USDC reaches your wallet.
- [Verified identity](/docs/provide/verified-identity): prove you control a domain or GitHub account.
- [TEE seller](/docs/provide/tee): attest your node so privacy-sensitive buyers can choose you.
- [Model verification](/docs/model-verification): how auditors check that you serve the models you advertise.
- [Metrics](/docs/provide/metrics): monitor requests, tokens and earnings with Prometheus.
- [Provider plugin API](/docs/provider-api): build a plugin for an upstream the built-in plugins don't cover.
- [`join-provider` agent skill](https://github.com/AntSeed/antseed/tree/main/skills/join-provider): let a coding agent walk you through this setup.
