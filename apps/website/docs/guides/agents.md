---
sidebar_position: 3
slug: /guides/agents
title: Connect Agents
description: Connect Hermes, OpenClaw, and other agents to the Antseed AI VPN locally or through an authenticated public HTTPS endpoint.
---

# Connect Agents

The Antseed AI VPN exposes the models selected by your routing policy through an OpenAI- and Anthropic-compatible API. An agent can connect in either of two ways:

- **Local agent** — use the buyer API on the same computer at `http://127.0.0.1:8377/v1`.
- **Remote agent or hosted client** — define an authenticated internet-accessible endpoint from the AI VPN's **Agents** view.

The public endpoint is useful for agents on another server, hosted development tools such as Cursor, CI workers, and custom applications that cannot reach your computer's `localhost` address.

## Agent setup skills

Use the maintained setup skill for the agent you want to connect:

- [Hermes integration](/integrations/hermes) and [Hermes Agent skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) — configure the current Hermes `providers:` schema, select models, fund the buyer, and use local or public endpoints.
- [OpenClaw integration](/integrations/openclaw) and [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) — configure Antseed under `models.providers`, including bearer-header authentication for a public endpoint.

For another agent, use its custom OpenAI or Anthropic provider settings with the base URL and API key described below. See [Using the API](/docs/guides/using-the-api) for request formats and routing behavior.

## Connect locally

Use the local endpoint when the agent runs on the same computer as the AI VPN:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
```

The local buyer proxy does not validate an API key, but many agent SDKs require a non-empty value. The `antseed-p2p` value is only a placeholder.

Test model discovery:

```bash
curl "$ANTSEED_BASE_URL/models" \
  -H "Authorization: Bearer $ANTSEED_API_KEY"
```

### Hermes

Current Hermes releases store named custom endpoints under `providers:`. Add Antseed in `~/.hermes/config.yaml`:

```yaml
model:
  provider: antseed
  default: antseed
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
    default_model: antseed
    models:
      antseed:
        context_length: 200000
      minimax-m2.7:
        context_length: 200000
      kimi-k2.6:
        context_length: 256000
```

The `antseed` model follows the current AI VPN model picker. Add concrete IDs returned by `GET /v1/models` when you want them in Hermes' model menu. The [Hermes Agent skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) covers funding, systemd, auxiliary models, and routing in detail.

### OpenClaw

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

Then run `openclaw models set "antseed/kimi-k2.6"` followed by `openclaw gateway restart`. `authHeader: true` makes OpenClaw send the API key as `Authorization: Bearer <API_KEY>`, which is required by the public gateway and also works locally. See the [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) for the complete walkthrough and setup script.

## Connect a remote agent

When the agent cannot reach the AI VPN on `localhost`, first create an authenticated endpoint by following the [Public HTTPS Tunnels guide](/docs/guides/public-tunnels). That guide is the canonical reference for ngrok and Cloudflare setup, authentication, supported routes, CLI commands, Cursor, and troubleshooting.

After the endpoint starts, replace the local placeholder values in the configuration above with the values shown by the AI VPN:

| Agent | Public endpoint field | Antseed API key field |
|---|---|---|
| Hermes | `providers.antseed.api` | `providers.antseed.api_key` |
| OpenClaw | `models.providers.antseed.baseUrl` | `models.providers.antseed.apiKey` |

Use the complete public base URL ending in `/v1`. For OpenClaw, keep `authHeader: true` so it sends the generated Antseed key as a bearer token.

For another agent, use its custom OpenAI- or Anthropic-compatible provider settings. See [Using the API](/docs/guides/using-the-api) for request formats and model routing.
