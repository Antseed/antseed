---
title: Reference upstreams
slug: /verify/upstreams
description: Where a verifier gets the genuine model's answers. Configure OpenRouter, the model maker's own OpenAI- or Anthropic-compatible API, a pinned OpenRouter provider, or a trusted Antseed seller.
---

# Reference upstreams

A verifier can only be as accurate as its reference. Every audit compares a seller's answers with answers from the **genuine model**, and those come from a **reference upstream** you configure. If the upstream itself serves a different or heavily quantized model, every honest seller looks wrong. This page explains the options and how to set each one up.

Upstreams are used only while building and growing [probe banks](/docs/verify/audits#reference-banks). Seller audits never call them: sellers are compared with the answers already stored in the bank.

## How requests are routed

A reference build sends three kinds of requests:

| Requests | Sent to |
|---|---|
| The audited model: candidate questions, stability checks, self-test | The model's `upstream` if it has one, otherwise `referenceEndpoint` |
| Contrast models (the cheaper look-alikes) | Always `referenceEndpoint` |
| The OpenRouter model catalog (unless you use a `contrastModelBank`) | `referenceEndpoint` (`GET /models`) |

So `referenceEndpoint` is always needed, usually OpenRouter, which serves every audited and contrast model under one key. `upstreams` lets individual audited models take their genuine answers from somewhere else, such as the model maker's own API.

You don't list the models themselves: the audited models and their OpenRouter ids are built into the CLI (see [Which models you audit](/docs/verify/audits#which-models-you-audit)). Per-model settings go under `verifier.models.<model>`, keyed by the model's service id. **A model without an `upstream` uses `referenceEndpoint`**, so OpenRouter is the default and you only list the models you want to send elsewhere. `antseed verifier models` shows the source each model will use.

## The main endpoint: `referenceEndpoint`

```json
{
  "verifier": {
    "referenceEndpoint": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "sourceId": "openrouter",
      "trust": "trusted"
    }
  }
}
```

| Key | Meaning |
|---|---|
| `baseUrl` | OpenAI-compatible Chat Completions base URL, including the version (`…/v1`) |
| `apiKeyEnv` | Environment variable holding the API key. Preferred over `apiKey`, which stores the key in the config file |
| `sourceId` | A name for this source. It is recorded in every reference and keeps banks from different sources apart. Changing it makes existing banks incompatible |
| `trust` | `"trusted"` for production references, `"smoke"` for test runs. Recorded in the reference's provenance |
| `antseedPeerId` | Optional. Sends `x-antseed-pin-peer` with each request, for an endpoint that is itself an Antseed buyer proxy |
| `contrastModelBank` | Contrast candidates with prices and ranks, when you don't use the OpenRouter catalog |

On OpenRouter, reasoning is turned off for reference requests (`reasoning_effort: "none"`). For models where the catalog says reasoning can't be turned off, the lowest supported effort is used and the reasoning is left out of the answer.

### Pin the OpenRouter provider

OpenRouter can serve one model from several providers, with different hardware and quantization. A bank measured across providers mixes them. Pin one with `referenceProvider`. Fallbacks are turned off, so a request fails rather than going to another provider:

```json
"verifier": {
  "models": {
    "kimi-k3": {
      "referenceProvider": { "order": ["DeepInfra"] }
    }
  }
}
```

A build without a pin warns when it sees answers from more than one provider (`reference provider … changed during the build; pin referenceProvider.order`). Pick a provider that serves the model at full precision. The pin is part of the bank's compatibility, so changing it later needs a new bank.

## Named upstreams: `upstreams`

`verifier.upstreams` defines named sources. A model uses one with `upstream.name`:

```json
{
  "verifier": {
    "upstreams": {
      "anthropic": {
        "type": "anthropic",
        "baseUrl": "https://api.anthropic.com/v1",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      },
      "openai": {
        "type": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    },
    "referenceEndpoint": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "sourceId": "openrouter",
      "trust": "trusted"
    },
    "models": {
      "claude-opus-5.5": {
        "upstream": { "name": "anthropic", "model": "claude-opus-5-5" }
      },
      "gpt-6.1-sol": {
        "upstream": { "name": "openai", "model": "gpt-6.1-sol" }
      }
    }
  }
}
```

Here the genuine Claude and GPT answers come straight from Anthropic and OpenAI. Contrast models and the price catalog still come from OpenRouter. The model's built-in OpenRouter id is still used to look up its price and reasoning settings in the catalog. `upstream.model` is the id on the maker's API.

### Upstream types

| `type` | Protocol | Notes |
|---|---|---|
| `openrouter` | OpenAI Chat Completions | Same request settings as `referenceEndpoint` on OpenRouter. The only type that supports `referenceProvider` |
| `openai` | OpenAI Chat Completions | Any OpenAI-compatible API: OpenAI, Together, Fireworks, a vLLM server you run. Requests are sent without extra reasoning settings |
| `anthropic` | Anthropic Messages (`POST /messages`) | Native Anthropic API. Sends `x-api-key` and `anthropic-version: 2023-06-01`, moves the system prompt to `system` and leaves out `top_p` |
| `antseed` | Through your buyer proxy | One trusted Antseed seller, see [below](#a-trusted-antseed-seller) |

API types take `baseUrl` (including the version), and `apiKeyEnv` or `apiKey`. A build stops with `verifier.upstreams.<name> has no API key; set <VAR>` if the variable is empty.

### Per-model `upstream`

| Key | Meaning |
|---|---|
| `name` | The entry in `verifier.upstreams` (required) |
| `model` | Model id on that upstream. Defaults to the model's built-in OpenRouter id. For an `antseed` upstream, the seller's service id |
| `pricing` | `{ inputUsdPerMillion, outputUsdPerMillion }`. Required for an `antseed` upstream, where it is the price the seller charges. It is also the model's audit [price limit](/docs/verify/audits#price-limit) |

`upstream` can't be combined with `referenceRoute`. `referenceProvider` works only with an `openrouter` upstream.

### A trusted Antseed seller

An `antseed` upstream takes the genuine answers from one seller on the network, through your running buyer proxy and pinned to its peer ID. Use it when you trust one seller to serve the genuine model, for example its own maker:

```json
"upstreams": {
  "maker-seller": { "type": "antseed", "peerId": "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c" }
},
…
"models": {
  "grok-4.7": {
    "upstream": {
      "name": "maker-seller",
      "model": "grok-4.7",
      "pricing": { "inputUsdPerMillion": 2, "outputUsdPerMillion": 8 }
    }
  }
}
```

Requests go to `http://127.0.0.1:<buyer.proxyPort>/v1`, so the buyer must be running. `temperature` and `top_p` are left out. **Only use a seller you trust.** If it serves a different model, the reference is wrong and so is every audit built on it. Its own audits are no protection here, since they would compare it with itself. The per-model `referenceRoute` key is the older way to write the same thing.

## Choosing a trustworthy upstream

- **Prefer the model maker's own API**, or an OpenRouter provider you have pinned. That is the version sellers are expected to match.
- **Use the same settings the whole time.** Each bank records its source, request settings and provider pin, and refuses builds that differ. Changing an upstream for a model means a new bank (new `banksDir`, `referencesDir` and `evidenceDir`, or a new `sourceId`).
- **Pick a model id that won't change.** Use a dated or versioned model id where the upstream offers one, so the model behind it can't silently change while your bank is in use.
- **Watch the self-test.** A high self-test error rate in the build summary often means the upstream is unstable (mixed providers, sampling it ignores). The build fails above 35%.
- **Expect to be checked.** Published audits name the upstream (name, type, base URL, model, request settings, provider pin and, for `antseed`, the peer ID, never API keys) and include the raw reference requests and responses. Anyone can see where your reference came from and repeat it.

## Costs and rate limits

A reference build pays the upstream for every request: candidate generation, stability checks, contrast answers and self-tests. Limit it with:

- `referenceMaxRequestsPerBuild` (default 2,000): upstream requests per build, including retries. For `verifier run --enroll-if-needed`, `--max-enrollment-requests` sets the limit per model and can't exceed this.
- `referenceMaxConcurrentRequests` (4) and `referenceMaxConcurrentRequestsPerModel` (3): requests in flight.
- `referenceBatchRetryCount` (3) and `referenceRetryBaseDelayMs` (500): retries of `429`, `5xx` and network errors, with exponential backoff that honors `Retry-After`.

These are request limits, not spending caps. The build summary (`<banksDir>/reference-build-summary.json`) and the bank record the estimated cost per model and purpose. New OpenRouter accounts have low per-minute limits. The builder recognizes that error and slows down.
