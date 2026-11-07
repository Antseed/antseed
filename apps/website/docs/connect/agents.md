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
| Another machine, reaching your desktop app or a CLI buyer | A [tunnel endpoint](#tunnel-endpoint), which is a gateway on your computer |
| The same computer as the buyer, without a gateway | The [local buyer proxy](#local-buyer-proxy) |

The local buyer proxy listens only on `127.0.0.1`. An agent on another machine cannot reach it, and you should not publish port 8377: it checks no API key, so anyone who reaches it can spend your deposit.

Maintained setup guides and skills:

- [Hermes integration](/integrations/hermes) and the [Hermes skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed)
- [OpenClaw integration](/integrations/openclaw) and the [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed)
- The [model verification skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model), to check that an API endpoint serves the model it claims ([how it works](/docs/model-verification))
- [Generate videos with an agent](/docs/videos) with the `antseed-videos` skill

## Gateway API key

A gateway gives each agent its own key, with spend limits, allowed models and usage logs. For agents, run it on a small server: it stays on when your computer sleeps, and every agent on every machine uses the same HTTPS URL. [Run a gateway on a server](/docs/gateway/server) takes one command. A gateway on your own computer (`http://localhost:8379/v1`, see the [quickstart](/docs/quickstart)) works for agents on that computer, or for others through a [tunnel](#tunnel-endpoint). Create a key in the Gateway Console under **Keys**, or with the CLI, then use:

```bash
export ANTSEED_BASE_URL="https://gateway.example.com/v1"   # or http://localhost:8379/v1
export ANTSEED_API_KEY="<your gateway key>"
```

The gateway expects `Authorization: Bearer $ANTSEED_API_KEY`. See [Gateway API](/docs/gateway/api) for creating keys and the routes it serves.

## Tunnel endpoint

A tunnel endpoint is a public HTTPS URL for your desktop app or CLI buyer, protected by a generated key. In the desktop app, open **Agents** and set up an **Internet-accessible endpoint**. With the CLI, run `antseed tunnel start`. See [Tunnels](/docs/tunnels).

Use the base URL ending in `/v1` and the generated Antseed API key, sent as a bearer token.

## Local buyer proxy

When the agent runs on the same computer as the buyer and you don't use a gateway, point it at `http://127.0.0.1:8377/v1`. The local proxy does not check API keys, but many agents require one, so use any placeholder:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
curl "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY"
```

The model `antseed` follows the model picked in the desktop app. It works only here, on the local buyer proxy of a desktop app with a model picked; through a gateway, use concrete model ids. See [Use the local buyer proxy](/docs/api).

## Hermes

Add Antseed under `providers:` in `~/.hermes/config.yaml`. This example uses a gateway key:

```yaml
model:
  provider: antseed
  default: kimi-k2.6
  base_url: ""
  api_mode: chat_completions

providers:
  antseed:
    name: Antseed
    api: https://gateway.example.com/v1   # or http://localhost:8379/v1
    api_key: <your gateway key>
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

For the local buyer proxy on the same computer, use `api: http://127.0.0.1:8377/v1` and `api_key: antseed-p2p` instead.

Use model ids returned by `GET /v1/models`. A bare id uses automatic routing; `<peerId>@kimi-k2.6` pins one seller. The [Hermes skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) covers funding, systemd and auxiliary models.

## OpenClaw

Add Antseed under `models.providers` in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "antseed": {
        "baseUrl": "https://gateway.example.com/v1",
        "apiKey": "<your gateway key>",
        "authHeader": true,
        "api": "openai-completions",
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

Then run `openclaw models set "antseed/kimi-k2.6"` and `openclaw gateway restart`. `authHeader: true` sends the key as `Authorization: Bearer <key>`, which gateway keys and tunnel endpoints require. Antseed translates the chat-completions request when a seller speaks another API. For the local buyer proxy on the same computer, use `"baseUrl": "http://127.0.0.1:8377/v1"` and `"apiKey": "antseed-p2p"`.

`kimi-k2.6` has no free seller, so it needs a funded gateway. After a `402`, OpenClaw disables the key for about 10 minutes for every model. On an unfunded gateway, use a gateway preset that prefers free sellers as the model id, such as `@preset/openclaw`. Only a gateway resolves presets; through the local buyer proxy, OpenClaw needs a concrete model id. On a local buyer with no deposits, pick a model that has a free seller: newer CLIs retry a free seller after a paid one answers `402`, while CLI 0.1.234 and earlier pass the `402` on, so there it needs a funded buyer or a gateway. To keep paid text sellers out entirely, give the buyer zero token price caps ([Routing](./routing.md)). OpenClaw cuts model ids at `@`, so `<peerId>@<service-id>` doesn't work there; pin a seller with a preset made with `--allow-peer <peerId>`. The [OpenClaw integration](/integrations/openclaw) has the commands.

## Switch an agent between endpoints

To move an agent from the local buyer proxy to a gateway key or tunnel endpoint, or back, change the base URL (ending in `/v1`) and the key:

| Agent | Base URL field | API key field |
|---|---|---|
| Hermes | `providers.antseed.api` | `providers.antseed.api_key` |
| OpenClaw | `models.providers.antseed.baseUrl` | `models.providers.antseed.apiKey` |

For other agents, use their custom OpenAI- or Anthropic-compatible provider settings with the same two values.
