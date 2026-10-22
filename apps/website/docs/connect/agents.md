---
slug: /agents
title: Connect agents
description: Connect Hermes, OpenClaw and other agents to Antseed through a gateway API key, a tunnel endpoint, or the local buyer proxy.
---

# Connect agents

Agents such as Hermes and OpenClaw connect to Antseed like any OpenAI- or Anthropic-compatible provider: a base URL and an API key. Pick the endpoint that fits where the agent runs:

| Where the agent runs | Endpoint |
|---|---|
| Anywhere, with its own key and budget | A [gateway API key](#gateway-api-key) (recommended) |
| Another machine, reaching your desktop app or a CLI buyer | A [tunnel endpoint](#tunnel-endpoint) |
| The same computer as the buyer | The [local buyer proxy](#local-buyer-proxy) |

Maintained setup guides and skills:

- [Hermes integration](/integrations/hermes) and the [Hermes skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed)
- [OpenClaw integration](/integrations/openclaw) and the [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed)
- The [model verification skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model), to check that an API endpoint serves the model it claims ([how it works](/docs/model-verification))

## Gateway API key

A gateway gives each agent its own key, with spend limits, allowed models and usage logs. Create a key in the Gateway Console under **Keys**, or with the CLI, then use:

```bash
export ANTSEED_BASE_URL="https://gateway.example.com/v1"   # or http://localhost:8379/v1
export ANTSEED_API_KEY="<your gateway key>"
```

The gateway expects `Authorization: Bearer $ANTSEED_API_KEY`. See [Gateway API](/docs/gateway/api) for creating keys and the routes it serves.

## Tunnel endpoint

A tunnel endpoint is a public HTTPS URL for your desktop app or CLI buyer, protected by a generated key. In the desktop app, open **Agents** and set up an **Internet-accessible endpoint**. With the CLI, run `antseed tunnel start`. See [Tunnels](/docs/tunnels).

Use the base URL ending in `/v1` and the generated Antseed API key, sent as a bearer token.

## Local buyer proxy

When the agent runs on the same computer as the buyer, point it at `http://127.0.0.1:8377/v1`. The local proxy does not check API keys, but many agents require one, so use any placeholder:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
curl "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY"
```

The model `antseed` follows the model picked in the desktop app. See [Use the local buyer proxy](/docs/api).

## Hermes

Add Antseed under `providers:` in `~/.hermes/config.yaml`. This example uses the local buyer proxy:

```yaml
model:
  provider: antseed
  default: kimi-k2.6
  base_url: ""
  api_mode: chat_completions

providers:
  antseed:
    name: Antseed
    api: http://127.0.0.1:8377/v1
    api_key: antseed-p2p
    transport: chat_completions
    extra_headers:
      originator: hermes
    default_model: kimi-k2.6
    models:
      kimi-k2.6:
        context_length: 256000
      minimax-m2.7:
        context_length: 200000
```

Use model ids returned by `GET /v1/models`. A bare id uses automatic routing; `<peerId>@kimi-k2.6` pins one seller. The [Hermes skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) covers funding, systemd and auxiliary models.

## OpenClaw

Add Antseed under `models.providers` in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "antseed": {
        "baseUrl": "http://127.0.0.1:8377/v1",
        "apiKey": "antseed-p2p",
        "authHeader": true,
        "api": "anthropic-messages",
        "models": [
          {
            "id": "kimi-k2.6",
            "name": "Kimi K2.6 via Antseed",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 256000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Then run `openclaw models set "antseed/kimi-k2.6"` and `openclaw gateway restart`. `authHeader: true` sends the key as `Authorization: Bearer <key>`, which gateway keys and tunnel endpoints require.

## Switch an agent to a gateway key or tunnel endpoint

Replace the local values with the base URL ending in `/v1` and the key:

| Agent | Base URL field | API key field |
|---|---|---|
| Hermes | `providers.antseed.api` | `providers.antseed.api_key` |
| OpenClaw | `models.providers.antseed.baseUrl` | `models.providers.antseed.apiKey` |

For other agents, use their custom OpenAI- or Anthropic-compatible provider settings with the same two values.
