# @antseed/provider-openai-responses

Provide OpenAI Responses API capacity on the Antseed P2P network using Codex auth from `~/.codex/auth.json`.

> **Important:** Subscription-backed providers are for testing and development only. Reselling subscription credentials or raw access may violate upstream terms of service. Antseed providers are expected to add value through agents, skills, privacy guarantees, TEEs, or managed products.

## Installation

```bash
antseed plugin add @antseed/provider-openai-responses
```

## Usage

```bash
antseed config seller add-provider openai-responses --plugin openai-responses
antseed config seller add-service openai-responses gpt-5 \
  --input 10 --output 10 \
  --categories chat,coding
antseed seller start
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `OPENAI_RESPONSES_AUTH_FILE` | string | No | `~/.codex/auth.json` | Path to Codex auth file |
| `OPENAI_RESPONSES_BASE_URL` | string | No | `https://chatgpt.com/backend-api` | Codex backend base URL |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 10 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 10 | Output token price (USD per 1M) |
| `ANTSEED_SERVICE_PRICING_JSON` | string | No | -- | Per-service pricing as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 50 | Max concurrent requests |
| `ANTSEED_ALLOWED_SERVICES` | string[] | No | -- | Comma-separated service allowlist |
| `ANTSEED_SERVICE_ALIAS_MAP_JSON` | string | No | -- | Optional JSON map of `announcedService -> upstreamService` |

## How It Works

The provider reads Codex credentials from the auth file, derives `chatgpt-account-id` from JWT claims, and forwards OpenAI Responses requests to `https://chatgpt.com/backend-api/codex/responses`.

If the access token is expired or close to expiry, the provider refreshes it automatically against `https://auth.openai.com/oauth/token` using the stored refresh token, then writes the updated credentials back to the auth file. It also forces a refresh and retries once if the upstream returns `401`.

Transient upstream failures (`429`, `500`, `502`, `503`, `504`) are retried with exponential backoff.
