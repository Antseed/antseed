# @antseed/provider-openai

Provide OpenAI-compatible API capacity on the Antseed P2P network (OpenAI, Together, OpenRouter, Venice, and similar).

> **Important:** Simply reselling raw API access without adding value may violate your API provider's terms of service. Antseed is designed for providers who build differentiated services on top of API access — for example, running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agents, fine-tuned models, or offering a managed product experience. Always review your API provider's usage policies before offering capacity on the network.

## Installation

The CLI installs the plugin when you add a provider that uses it (see Usage below).

## Usage

```bash
# Secrets go in env vars
export OPENAI_API_KEY=sk-...

# Everything else lives in config.json, set via the CLI
antseed config seller add-provider together --plugin openai --base-url https://api.together.ai
antseed config seller add-service together kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding

antseed seller start
```

## Configuration

Only upstream authentication and runtime toggles go in env vars. Pricing, categories, upstream model mapping, and the list of announced services all live under `seller.providers.<name>.services[id]` in `~/.antseed/config.json` (see [Configuration](/docs/config)).

If you set `baseUrl` in `config.json`, you do not need to export `OPENAI_BASE_URL` separately. `antseed seller start` reads the provider block and passes `baseUrl` into the plugin runtime automatically.

### Secrets (env vars)

| Key | Required | Description |
|-----|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI-compatible upstream API key |

### Runtime toggles (env vars, optional)

| Key | Default | Description |
|-----|---------|-------------|
| `OPENAI_PROVIDER_FLAVOR` | `generic` | Special handling profile (`generic`, `openrouter`, `venice`). Venice is also detected from `baseUrl`. |
| `OPENAI_UPSTREAM_PROVIDER` | -- | Optional OpenRouter upstream provider selector |
| `OPENAI_EXTRA_HEADERS_JSON` | -- | Extra headers as JSON object |
| `OPENAI_BODY_INJECT_JSON` | -- | JSON object merged into request body |
| `OPENAI_STRIP_HEADER_PREFIXES` | -- | Comma-separated header prefixes to strip |

### Per-service config (config.json)

```bash
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --output 1.7 --cached 0.06 \
  --categories chat,math,coding

antseed config seller add-service together kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding
```

The CLI reads `seller.providers.<name>.services[id]` and turns it into the flat env keys (`ANTSEED_SERVICE_ALIAS_MAP_JSON`, `ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON`, `ANTSEED_SERVICE_EXTRA_PROTOCOLS_JSON`, `ANTSEED_SERVICE_PRICING_JSON`, `ANTSEED_ALLOWED_SERVICES`) that this plugin's `configSchema` consumes internally. Categories are written directly onto `provider.serviceCategories` by the seller start path, not via env var. You should not set those env keys directly.

### Extra text protocols

Set `seller.providers.<name>.services[id].extraProtocols` to add `openai-responses` or `anthropic-messages` to a text service's default Chat Completions announcement.
For example: `{"extraProtocols": ["openai-responses", "anthropic-messages"]}`.
The upstream and all fallbacks must already support those APIs, including streaming; the relay does not translate protocols.

### Venice image editing

Venice's generation endpoint is OpenAI-compatible, but its image-edit endpoint is native. Pair each advertised generation service with a compatible Venice edit model explicitly:

```bash
export OPENAI_API_KEY=...

antseed config seller add-provider venice \
  --plugin openai \
  --base-url https://api.venice.ai/api

antseed config seller add-service venice grok-imagine-image-quality \
  --upstream grok-imagine-image-quality \
  --venice-edit-model grok-imagine-quality-edit \
  --input 0 --output 0 \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.06}]}}'
```

The shared image-unit price applies to both generation and edits without changing discovery metadata. The example price reflects Venice's catalog when written; check the current `type=image` and `type=inpaint` results from Venice's Models API before advertising prices.

The public service remains `grok-imagine-image-quality` for both generation and follow-up edits. For `POST /v1/images/edits`, the provider sends the multipart request to Venice's `/api/v1/image/edit` (or `/api/v1/image/multi-edit` when the request has several images, as repeated `image` or `image[]` parts, or a `quality` field), substitutes `grok-imagine-quality-edit`, and converts Venice's raw image response to the OpenAI Images `b64_json` shape. Explicit `response_format=url` and unsupported multipart fields are rejected locally instead of being silently dropped.

Only Venice services with `--venice-edit-model` advertise `inputs: ["text", "image"]`, and they add `image` and `moderation` to `supportedParameters` (buyers route edits automatically only to services that list `image`). Venice image services without that option advertise `inputs: ["text"]`, remain available for generation, and reject edits locally without calling an invalid upstream endpoint. The CLI stores the selected model as `imageEditModel` in the service's durable seller config; seller startup loads that field and passes it to the provider. Edit pairings must be configured per service; the provider never guesses compatibility from generation model names. Seller startup warns when an edit pairing has no explicit `openai-images` billing model.

### Text to speech

Services whose upstream model is a text-to-speech model (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, Venice `tts-…`) are advertised as `openai-audio-speech` and served on `POST /v1/audio/speech`, billed per character with `input_characters`:

```bash
antseed config seller add-service venice tts-kokoro \
  --unit-billing-models '{"openai-audio-speech":{"version":1,"components":[{"unit":"input_characters","priceUsd":0.0000035}]}}'
```

On Venice the provider reads each speech model's voices from `GET /api/v1/models?type=tts` at startup and announces them as `capabilities.speech`, unless the service config sets `capabilities.speech.voices`. The seller refuses a voice that is not listed. Body injection (`OPENAI_BODY_INJECT_JSON`) is not applied to speech requests.

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to OpenAI-compatible APIs with `Authorization: Bearer` authentication. Venice image edits use a provider-local native endpoint adapter while preserving the same Antseed request, routing, metering, and payment flow.
