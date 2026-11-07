# @antseed/router-local

Local router for AI coding tools. Drop-in replacement for `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` that routes requests through the Antseed P2P network.

## Installation

```bash
antseed plugin add @antseed/router-local
```

## Usage

```bash
antseed buyer start

# Then configure your tools:
export ANTHROPIC_BASE_URL=http://localhost:8377   # Anthropic clients, Claude Code
export OPENAI_BASE_URL=http://localhost:8377/v1   # OpenAI clients
```

Works with Claude Code, Aider, Continue.dev, OpenAI Codex, and any tool that supports custom base URLs.

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `ANTSEED_MIN_REPUTATION` | number | No | 50 | Minimum peer reputation (0-100) |
| `ANTSEED_MAX_PRICING_JSON` | string | No | -- | Max pricing config as JSON |
| `ANTSEED_MAX_FAILURES` | number | No | 3 | Max failures before cooldown |
| `ANTSEED_FAILURE_COOLDOWN_MS` | number | No | 30000 | Cooldown duration after failures (ms) |
| `ANTSEED_MAX_PEER_STALENESS_MS` | number | No | 300000 | Max age of peer info before deprioritizing |

## Max Pricing

Set maximum prices you're willing to pay:

```bash
export ANTSEED_MAX_PRICING_JSON='{"defaults":{"inputUsdPerMillion":20,"cachedInputUsdPerMillion":10,"outputUsdPerMillion":60}}'
```

Or with per-provider overrides:

```bash
export ANTSEED_MAX_PRICING_JSON='{"defaults":{"inputUsdPerMillion":20,"cachedInputUsdPerMillion":10,"outputUsdPerMillion":60},"providers":{"anthropic":{"services":{"claude-sonnet-4-5-20250929":{"inputUsdPerMillion":15,"cachedInputUsdPerMillion":8,"outputUsdPerMillion":75}}}}}'
```

## How It Works

Uses `scoreCandidates` and `PeerMetricsTracker` from `@antseed/router-core`. Scores peers on price, latency, capacity, reputation, freshness, and reliability. Enforces max pricing limits. Peers that exceed price limits or fail repeatedly are excluded.
