# @antseed/provider-local-llm

Provide local LLM capacity on the Antseed P2P network. Works with Ollama, llama.cpp, and any OpenAI-compatible local server.

## Installation

The CLI installs the plugin when you add a provider that uses it:

```bash
antseed config seller add-provider local-llm --plugin local-llm
```

## Usage

```bash
# Configure once
antseed config seller add-service local-llm llama3.2:3b \
  --input 0 --output 0 \
  --categories chat,fast,free
antseed seller settings set --max-buyers 1

# With Ollama (default)
antseed seller start

# With a custom endpoint
export LOCAL_LLM_BASE_URL=http://localhost:8080
antseed seller start
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `LOCAL_LLM_BASE_URL` | string | No | `http://localhost:11434` | Local LLM server URL |
| `LOCAL_LLM_API_KEY` | secret | No | -- | Optional API key for local server |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 0 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 0 | Output token price (USD per 1M) |
| `ANTSEED_SERVICE_PRICING_JSON` | string | No | -- | Per-service pricing as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 1 | Max concurrent requests |
| `ANTSEED_ALLOWED_SERVICES` | string[] | No | -- | Comma-separated service allowlist |

### Reasoning efforts

At startup the plugin asks the local server which reasoning efforts each service's model accepts and announces them as `capabilities.reasoningEfforts`, unless the service config sets a list. It recognises the server by its answer:

- **llama.cpp server:** `GET /props?model=<model>&autoload=false` (it never loads a model to answer). The levels are `chat_template_caps.reasoning_effort_levels` minus `reasoning_effort_rejected`.
- **Ollama:** `POST /api/show` with the model. The levels are the named levels in `thinking.values`. A model with only on/off values (`true`, `false`) gets nothing.

`reasoning: true` is set when the server says the model reasons. Nothing is filled for a service with `reasoning: false`, and a list with any label that breaks the label rule fills nothing. A filled list is exactly what the server publishes, so it may lack `none`. Each call waits at most 10 seconds, so a server that answers neither call can hold the start for up to 20 seconds. If the server answers with an error or more than 4 MiB, or not at all, the capabilities stay as configured, the provider logs one line naming the host and paths, and the seller starts normally.

## How It Works

Relays requests to a local LLM server. Pricing defaults to 0 (free) since you're running your own hardware. The CLI sets the plugin's concurrency from `seller.maxConcurrentBuyers`, which defaults to 50, so lower it with `antseed seller settings set --max-buyers 1` (or another number your hardware can handle) to avoid overloading local inference. The plugin's own default of 1 applies only when you load it outside the CLI.
