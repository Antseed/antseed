# Antseed Network

Antseed is a peer-to-peer AI services network that enables direct connections between AI service providers and buyers. It eliminates intermediary platforms by providing protocol-level discovery, metering, and payment settlement.

## Repository Structure

- [spec/](spec/) — Protocol specification
  - [10-native-video.md](spec/10-native-video.md) — Native video relays, routing, and billing
  - [00-conventions.md](spec/00-conventions.md) — Data formats and conventions
  - [01-discovery.md](spec/01-discovery.md) — DHT-based peer discovery
  - [02-transport.md](spec/02-transport.md) — Binary framing and connection management
  - [03-metering.md](spec/03-metering.md) — Token estimation and usage receipts
  - [04-payments.md](spec/04-payments.md) — Settlement, deposits, sessions, and disputes
  - [05-reputation.md](spec/05-reputation.md) — Trust scoring and attestations
  - [06-security-overview.md](spec/06-security-overview.md) — End-to-end security model and hardening guidance
- [templates/provider-plugin/](templates/provider-plugin/) — Starter template for building a provider plugin (offer AI services)
- [templates/router-plugin/](templates/router-plugin/) — Starter template for building a router plugin (consume AI services)

## Getting Started

For protocol behavior from epoch 22, start with [Recognized Usage and ANTS
Rewards](../../apps/website/docs/protocol/recognized-usage.md), [Reward
Policies](../../apps/website/docs/protocol/reward-policies.md), and the separate
[legacy claims reference](../../apps/website/docs/protocol/legacy-emissions.md).
Deployment procedures belong in the contract migration runbooks; the model
verification and fingerprint-swarm specifications describe proposed work rather
than additional active reward policies.

Install the CLI globally:

```bash
npm install -g @antseed/cli
antseed seller setup      # create ~/.antseed/config.json
antseed seller start      # provide AI services
antseed buyer start       # consume via local router
```

`~/.antseed/config.json` is the main source of truth for provider definitions, services, pricing, categories, buyer settings, and `baseUrl`. Environment variables are mainly for secrets such as API keys and `ANTSEED_IDENTITY_HEX`.

## Plugin Ecosystem

Antseed is extensible. Any developer can publish a plugin to npm:

| Plugin type | Purpose | Command |
|---|---|---|
| Provider plugin | Connect an upstream AI API and offer services | `antseed seller start` |
| Router plugin | Select peers and proxy requests for a client tool | `antseed buyer start --router <name>` |

Use the templates in this directory as a starting point:

```bash
# Provider plugin (offer services)
cp -r templates/provider-plugin my-provider
cd my-provider && npm install && npm run verify

# Router plugin (proxy requests)
cp -r templates/router-plugin my-router
cd my-router && npm install && npm run verify
```

## Links

- [@antseed/node](https://npmjs.com/package/@antseed/node) — Protocol SDK
- [@antseed/cli](https://npmjs.com/package/@antseed/cli) — CLI tools
- [@antseed/provider-anthropic](https://npmjs.com/package/@antseed/provider-anthropic) — Anthropic provider (API key)
- [@antseed/provider-claude-code](https://npmjs.com/package/@antseed/provider-claude-code) — Claude Code provider (keychain, testing only)
- [@antseed/provider-openai](https://npmjs.com/package/@antseed/provider-openai) — OpenAI-compatible provider (OpenAI, Together, OpenRouter)
- [@antseed/provider-local-llm](https://npmjs.com/package/@antseed/provider-local-llm) — Local LLM provider
- [@antseed/provider-typesafe](https://npmjs.com/package/@antseed/provider-typesafe) — TypeSafe System One decision-model provider
- [@antseed/router-local](https://npmjs.com/package/@antseed/router-local) — Local router (Claude Code, Codex)
