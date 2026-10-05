# @antseed/provider-typesafe

Provide System One decision-model capacity on the AntSeed P2P network. Works with TypeSafe's API and any upstream that serves the same `POST /v1/systemone` contract.

System One models (TypeSafe Jev) are not chat models. A request carries a `state` and typed `questions` (`choice`, `score`, `noul`); the response carries typed `answers` with probabilities and confidence. Every service under this plugin is advertised with the `typesafe-systemone` API protocol, so buyers route decision requests only to sellers that speak it.

## Installation

```bash
antseed plugin add @antseed/provider-typesafe
```

## Usage

```bash
export TYPESAFE_API_KEY=<key>
antseed config seller add-provider typesafe --plugin typesafe
antseed config seller add-service typesafe jev-latest \
  --input 0.05 --output 0 \
  --categories decision
antseed seller start
```

Buyers point the TypeSafe SDKs at their local AntSeed proxy:

```bash
export TYPESAFE_BASE_URL=http://127.0.0.1:8377
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `TYPESAFE_API_KEY` | secret | Yes | -- | Upstream API key |
| `TYPESAFE_BASE_URL` | string | No | `https://api.typesafe.ai` | System One API base URL |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 0.05 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 0 | Output token price (USD per 1M) |
| `ANTSEED_SERVICE_PRICING_JSON` | string | No | -- | Per-service pricing as JSON |
| `ANTSEED_SERVICE_CAPABILITIES_JSON` | string | No | -- | Per-service capability hints as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 10 | Max concurrent requests |
| `ANTSEED_ALLOWED_SERVICES` | string[] | No | -- | Comma-separated service allowlist |
| `ANTSEED_SERVICE_ALIAS_MAP_JSON` | string | No | -- | Announced service → upstream model name |

## How It Works

1. The seller announces each allowed service with the `typesafe-systemone` protocol.
2. A buyer's proxy accepts `POST /v1/systemone`, detects the protocol from the path, and routes to a seller advertising it. Decision requests are never adapted onto chat protocols.
3. The seller relays the request to `TYPESAFE_BASE_URL` as-is, rewriting `model` through the alias map when configured, and meters `usage.input_tokens` and `usage.output_tokens` from the response.
