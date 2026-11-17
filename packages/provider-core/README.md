# @antseed/provider-core

Shared infrastructure for building Antseed provider plugins. Handles HTTP relaying, authentication, token management, and model validation so plugin authors can focus on provider-specific logic.

## Installation

```bash
pnpm add @antseed/provider-core
```

Peer dependency: `@antseed/node >= 0.1.0`

## Key Exports

### BaseProvider

Implements the `Provider` interface with built-in HTTP relay support. Most provider plugins use this as their foundation.

```ts
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

const provider = new BaseProvider({
  name: 'my-provider',
  services: ['model-a', 'model-b'],
  pricing: { defaults: { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 10 } },
  serviceApiProtocols: { 'model-a': ['openai-chat-completions'], 'model-b': ['openai-chat-completions'] },
  relay: {
    baseUrl: 'https://api.example.com',
    authHeaderName: 'Authorization',
    authHeaderValue: '',
    tokenProvider: new StaticTokenProvider('Bearer sk-...'),
    maxConcurrency: 10,
    allowedServices: ['model-a', 'model-b'],
    serviceRewriteMap: {
      'model-a': 'together/model-a',
    },
  },
});
```

`BaseProvider` also takes optional `serviceUnitBillingModels` and `serviceCapabilities`. Service categories are not part of its config: the CLI sets them from the seller's `config.json`.

### Token Providers

- **`StaticTokenProvider`** -- Wraps a static API key with no refresh logic.
- **`OAuthTokenProvider`** -- Manages OAuth access/refresh token pairs with automatic renewal.
- **`createTokenProvider()`** -- Factory that creates the right provider based on auth type.

### Utilities

- **`swapAuthHeader()`** -- Injects/replaces authentication headers on outgoing requests.
- **`validateRequestService()`** -- Validates request body `model` field against an allow-list.
- **`KNOWN_AUTH_HEADERS`** -- Standard auth header names (x-api-key, Authorization, etc.).

### HttpRelay

Low-level HTTP relay with concurrency control, SSE streaming support, model validation, and optional request model rewriting (`serviceRewriteMap`). `defaultHeaders` sets a header only when the request lacks it, and `omitJsonFields` drops body fields the upstream rejects for the model it will see; `anthropicMessagesRelay` is both for the Anthropic API. Used internally by `BaseProvider`. Other `relay` options include `pathRewrite`, `injectJsonFields`, `throttle`, `retryOn5xx`, `retryOn401`, `timeoutMs`, `fallbackUpstreams` and `redirect` (upstream redirects fail by default).

## Usage in Plugins

```ts
import type { AntseedProviderPlugin } from '@antseed/node';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

const plugin: AntseedProviderPlugin = {
  name: 'my-provider',
  displayName: 'My Provider',
  version: '0.1.0',
  type: 'provider',
  description: 'My custom provider',
  configSchema: [
    { key: 'API_KEY', label: 'API Key', type: 'secret', required: true, description: 'API key' },
  ],
  createProvider(config) {
    return new BaseProvider({
      name: 'my-provider',
      services: ['default-model'],
      pricing: { defaults: { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 10 } },
      relay: {
        baseUrl: 'https://api.example.com',
        authHeaderName: 'Authorization',
        authHeaderValue: '',
        tokenProvider: new StaticTokenProvider(`Bearer ${config['API_KEY']}`),
        maxConcurrency: 10,
        allowedServices: ['default-model'],
      },
    });
  },
};

export default plugin;
```
