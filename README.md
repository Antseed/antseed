# Antseed

A peer-to-peer AI services network. Providers offer AI services, buyers discover providers via DHT and route requests through encrypted P2P connections.

**Live pricing:** see [PRICING.md](PRICING.md) or `https://network.antseed.com/stats` (public JSON, no auth).

## How It Works

**Providers** run a provider plugin that connects to an upstream LLM API (Anthropic, OpenAI-compatible APIs, local Ollama, etc.) and announce capacity on the DHT network.

**Buyers** run a router plugin that discovers providers, scores them on price/latency/reputation, and proxies requests through a local HTTP endpoint that drop-in replaces `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.

## Terms of Use

Antseed is infrastructure for building differentiated AI services — not for raw resale of API keys or subscription access. Providers are expected to add value through domain-specific skills, agent workflows, Trusted Execution Environments (TEEs), fine-tuned models, or other product differentiation. Reselling personal subscription credentials (e.g., Claude Pro/Team plans) violates the upstream provider's terms of service and is not permitted. Always review your API provider's usage policies before offering capacity on the network. Subscription-based provider plugins (e.g., `provider-claude-code`, `provider-claude-oauth`) are provided for local testing and development only.

## Quick Start

```bash
# Select the repository's Node 24 development runtime
nvm install
nvm use

# Install dependencies
pnpm install

# Build everything
pnpm run build

# Create config once
node apps/cli/dist/cli/index.js seller setup

# Start providing
node apps/cli/dist/cli/index.js seller start

# Start buying
node apps/cli/dist/cli/index.js buyer start
```

Or install globally:

```bash
npm install -g @antseed/cli
antseed seller setup  # Create ~/.antseed/config.json
antseed seller start  # Start providing
antseed buyer start   # Start buying
```

`~/.antseed/config.json` is the main source of truth for providers, services, pricing, categories, ports, and `baseUrl`. Environment variables are primarily for secrets such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `ANTSEED_IDENTITY_HEX`.

## Repository Structure

```
packages/             Core libraries
  node/               Protocol SDK -- P2P, discovery, metering, payments
  provider-core/      Shared provider infrastructure (HTTP relay, auth, token management)
  router-core/        Shared router infrastructure (peer scoring, metrics tracking)

plugins/              Provider and router plugins
  provider-anthropic/       Anthropic API key provider
  provider-claude-code/     Claude Code keychain provider
  provider-claude-oauth/    Claude OAuth provider
  provider-openai/          OpenAI-compatible provider (OpenAI, Together, OpenRouter)
  provider-local-llm/       Local LLM provider (Ollama, llama.cpp)
  provider-typesafe/        TypeSafe System One decision-model provider
  router-local/             Local router (Claude Code, Aider, Continue.dev)

apps/                 Applications
  cli/                CLI tool and plugin manager
  desktop/            Electron desktop app
  website/            Marketing website

e2e/                  End-to-end tests
docs/protocol/        Protocol specification
```

## Architecture

```
@antseed/node (core SDK)
  ├── provider-core
  │     └── provider-anthropic, provider-claude-code, provider-claude-oauth,
  │         provider-openai, provider-local-llm, provider-typesafe
  ├── router-core
  │     └── router-local
  ├── payments (peer: node)
  │     └── cli (depends: node + payments)
  │           └── desktop (Electron wrapper)
  └── website (standalone)
```

## Metrics and Monitoring

Antseed includes a native Prometheus-compatible exporter:

```bash
antseed metrics serve --role seller --host 0.0.0.0 --port 9108
antseed metrics serve --role buyer --host 127.0.0.1 --port 9108
```

See [Metrics](apps/website/docs/guides/metrics.md) for endpoint details, metric names, labels, and operational notes.

## Development

### Optional Nix dev shell

This repository includes a Nix flake for contributors who want a pinned local
toolchain. The flake provides Node.js, pnpm, Python, native build tools, Git, and
Linux keychain dependencies used by the workspace. It does not replace the
normal pnpm workflow.

```bash
nix develop
pnpm install
pnpm run build
```

If flakes are not enabled globally, run the shell with the required experimental
features for a single command:

```bash
nix --extra-experimental-features 'nix-command flakes' develop
```

```bash
pnpm install            # Install all dependencies
pnpm run build          # Build in dependency order
pnpm run test           # Run all tests
pnpm run typecheck      # Type-check all packages
pnpm run clean          # Remove all dist/ directories
pnpm run dev:website    # Start website dev server
pnpm run dev:desktop    # Build deps + start desktop in dev mode
```

## Building a Plugin

Providers and routers are npm packages that export a plugin manifest:

```bash
antseed plugin create my-provider --type provider
```

See [packages/node/README.md](packages/node/README.md) for the `Provider` and `Router` interfaces, and [plugins/provider-claude-oauth/README.md](plugins/provider-claude-oauth/README.md) for a full plugin walkthrough.

## Tech Stack

- **Development runtime**: Node.js 24 (pinned in `.nvmrc`), ES modules
- **Language**: TypeScript 5.x, strict mode
- **Package Manager**: pnpm workspaces
- **Build**: tsc for libraries, Vite for web apps
- **Test**: vitest
- **Desktop**: Electron
- **P2P**: BitTorrent DHT discovery + direct end-to-end encrypted TCP (preferred); WebRTC data channels for peers that cannot open TCP sockets
- **Payments**: On-chain USDC deposits and sessions (Base/Arbitrum)
