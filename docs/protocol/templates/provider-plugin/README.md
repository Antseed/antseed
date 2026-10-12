# Build a Antseed Provider Plugin

This template shows how to publish a **provider plugin** for the Antseed Network. A provider plugin connects the Antseed node to an upstream AI API (Anthropic, OpenAI, a local LLM, etc.) and offers AI services to buyers on the P2P network.

> **Important:** Antseed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills or agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service.

## How It Works

```
antseed seller start
       ↓
CLI loads antseed-provider-echo from ~/.antseed/plugins/
       ↓
plugin.createProvider(config) → Provider
       ↓
AntseedNode (seller mode) handles DHT, encrypted P2P transport, metering, payments
```

Your plugin only owns the upstream connection logic. Everything else is handled by the node.

## Quick Start

```bash
npm install
npm run verify     # check the plugin satisfies the interface
npm run build      # compile to dist/
```

To test end-to-end with the CLI:

```bash
antseed plugin add ./   # install this package as a plugin
antseed config seller add-provider echo --plugin echo
antseed config seller add-service echo my-model-v1 --input 2 --output 2 --categories coding
antseed seller start
```

## Customization

Replace `EchoProvider` in `src/provider.ts` with your real inference logic:

```ts
import type { Provider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node/types';

export class MyProvider implements Provider {
  readonly name = 'my-provider';
  readonly services = ['my-model-v1'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    },
  };
  readonly serviceCategories = { 'my-model-v1': ['coding'] };
  readonly serviceCapabilities = {
    'my-model-v1': { contextWindow: 128000, inputs: ['text'], toolUse: true },
  };
  readonly maxConcurrency = 10;

  private _current = 0;
  constructor(private readonly config: Record<string, string>) {}

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._current++;
    try {
      const body = await callMyLLM(req, this.config['MY_API_KEY']);
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    } finally {
      this._current--;
    }
  }

  getCapacity() { return { current: this._current, max: this.maxConcurrency }; }
}
```

Then declare config keys in `src/index.ts`:

```ts
configSchema: [
  { key: 'MY_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'API key' },
  { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string' },
],
```

The CLI reads matching environment variables and passes them to `createProvider(config)`. Non-secret runtime shape such as services, pricing, categories, capabilities, unit billing, and provider `baseUrl` should live in `~/.antseed/config.json`.

Use `parseServiceCapabilitiesJson()` from `@antseed/provider-core` to consume `ANTSEED_SERVICE_CAPABILITIES_JSON`. If your plugin supports non-token billing, also declare `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON` and parse it with `parseServiceUnitBillingModelsJson()`. Plugins that omit the unit-billing key cause seller startup to warn when an operator configures `unitBillingModels` for them.

## Adding an Ant Agent

Providers can differentiate their service by wrapping it with a **ant agent** — a read-only, knowledge-augmented AI service that injects a persona, guardrails, and on-demand knowledge into buyer requests. Creators can also add custom tools for fetching external data, calling APIs, etc. The CLI handles this automatically via `@antseed/ant-agent` — no plugin code required.

### Setup

Create an agent directory with an `agent.json` manifest:

```
my-agent/
  agent.json           # manifest
  persona.md           # system prompt / personality
  knowledge/           # knowledge modules (markdown files)
    visual-explainer.md
    code-review.md
```

```json
{
  "name": "my-coding-agent",
  "persona": "./persona.md",
  "guardrails": [
    "Never execute code on behalf of the user",
    "Always explain trade-offs"
  ],
  "knowledge": [
    { "name": "visual-explainer", "description": "Generate HTML diagrams and visualizations", "file": "./knowledge/visual-explainer.md" },
    { "name": "code-review", "description": "Review code for quality and bugs", "file": "./knowledge/code-review.md" }
  ]
}
```

Then point your config at the agent directory:

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

### How it works

1. **Persona + guardrails** are always injected into the system prompt
2. **Knowledge modules** are loaded on demand — an `antseed_load_knowledge` tool is injected and the LLM decides which modules to load during the conversation
3. Internal tool calls are executed in a loop until the LLM produces a final text response
4. The buyer gets a clean streamed response with no internal tools or loop artifacts

The composition chain is: `AntAgentProvider → BaseProvider`.

See the [`@antseed/ant-agent` README](../../../packages/ant-agent/README.md) for the full manifest reference.

## Publishing

```bash
npm publish

# Users install with:
antseed plugin add my-provider-package
antseed config seller add-provider my-provider --plugin my-provider
antseed seller start
```

## Verification

```bash
npm run verify
```

## Interface Reference

### `Provider`

| Property / Method | Type | Description |
|---|---|---|
| `name` | `string` | Unique provider name |
| `services` | `string[]` | Supported service IDs |
| `pricing.defaults.inputUsdPerMillion` | `number` | Default input pricing in USD per 1M tokens |
| `pricing.defaults.cachedInputUsdPerMillion?` | `number` | Default cached input pricing in USD per 1M tokens (defaults to input price) |
| `pricing.defaults.outputUsdPerMillion` | `number` | Default output pricing in USD per 1M tokens |
| `pricing.services?` | `Record<string, { inputUsdPerMillion; cachedInputUsdPerMillion?; outputUsdPerMillion }>` | Optional per-service pricing overrides |
| `serviceCategories?` | `Record<string, string[]>` | Optional discovery tags by service |
| `serviceCapabilities?` | `Record<string, ServiceCapabilities>` | Optional context, modality, reasoning, tool-use, and structured-output hints |
| `serviceUnitBillingModels?` | `ServiceUnitBillingModelsV1` | Optional per-service/protocol non-token billing models |
| `serviceCategories?` | `Record<string, string[]>` | Optional per-service discovery tags (e.g. `coding`, `privacy`) |
| `maxConcurrency` | `number` | Max concurrent requests |
| `handleRequest(req)` | `Promise<SerializedHttpResponse>` | Handle an inference request |
| `getCapacity()` | `{ current: number; max: number }` | Current / max concurrency |

### `AntseedProviderPlugin`

| Property | Type | Description |
|---|---|---|
| `type` | `'provider'` | Must be `'provider'` |
| `name` | `string` | Short ID, e.g. `'anthropic'` |
| `displayName` | `string` | Human-readable label |
| `version` | `string` | Semantic version (e.g. `'1.0.0'`) |
| `description` | `string` | Short description of the plugin |
| `configSchema` | `ConfigField[]` | Plugin configuration fields |
| `createProvider(config)` | `Provider \| Promise<Provider>` | Factory |

## Links

- [@antseed/node source](https://github.com/AntSeed/node)
- [Provider interface](https://github.com/AntSeed/node/tree/main/src/interfaces/seller-provider.ts)
- [Official Anthropic provider](https://github.com/AntSeed/provider-anthropic)
- [Official Claude Code provider](https://github.com/AntSeed/provider-claude-code)
