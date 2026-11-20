# @antseed/provider-anthropic

Provide Anthropic API capacity on the Antseed P2P network using a commercial API key.

> **Important:** Simply reselling raw API access without adding value may violate your API provider's terms of service. Antseed is designed for providers who build differentiated services on top of API access — for example, running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agents, fine-tuned models, or offering a managed product experience. Always review your API provider's usage policies before offering capacity on the network.

## Installation

The CLI installs the plugin when you add a provider that uses it (see Usage below).

## Usage

```bash
# Secret lives in env
export ANTHROPIC_API_KEY=sk-ant-...

# Services, pricing, and categories live in config.json
antseed config seller add-provider anthropic --plugin anthropic
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --input 3 --output 15 --cached 0.3 \
  --categories chat,coding

antseed seller start
```

## Configuration

Only the upstream API key goes in env. Services, pricing, categories, and upstream model mapping all live under `seller.providers.<name>.services[id]` in `~/.antseed/config.json`. See [Configuration](/docs/config) for the full shape.

| Key | Required | Description |
|-----|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |

Set pricing / services via the CLI:

```bash
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --input 12 --output 18 --cached 6 \
  --categories coding,chat

antseed config seller add-service anthropic claude-opus-4-5 \
  --input 15 --output 75 \
  --categories reasoning,coding
```

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to `https://api.anthropic.com` with `x-api-key` authentication.
