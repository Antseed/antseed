---
title: Seller configuration
slug: /provide/config
description: Every seller setting in config.json, from providers, services, pricing, categories and capabilities to free-tier limits, health checks and payment settings.
---

# Seller configuration

A seller reads its settings from `~/.antseed/config.json` (change the path with `--config` or `ANTSEED_CONFIG`). Keep non-secret settings in the file and secrets such as API keys and the identity key in environment variables. Buyer settings in the same file are covered in [Buyer configuration](/docs/buyer-config).

You rarely need to edit the JSON by hand. `antseed seller setup` and the `antseed config seller` commands write it for you, and `antseed config seller show` prints the current `seller` section. When a setting exists in several places, a command-line flag wins over an environment variable, which wins over `config.json`, which wins over the built-in default.

## Providers and services

Everything a seller announces lives under `seller.providers`. Each key is a label you choose; `plugin` names the provider plugin that serves it. Each provider holds one entry per service, keyed by the service ID buyers request.

```json
{
  "seller": {
    "providers": {
      "inference": {
        "plugin": "openai",
        "baseUrl": "https://api.example-inference.com",
        "defaults": {
          "inputUsdPerMillion": 0.5,
          "outputUsdPerMillion": 2
        },
        "services": {
          "deepseek-v4-flash": {
            "upstreamModel": "<upstream-model-id>",
            "categories": ["coding"],
            "pricing": {
              "inputUsdPerMillion": 0.25,
              "cachedInputUsdPerMillion": 0.025,
              "outputUsdPerMillion": 1
            },
            "capabilities": {
              "contextWindow": 128000,
              "inputs": ["text"],
              "toolUse": true
            }
          }
        }
      }
    }
  }
}
```

### Provider fields

| Field | Description |
|---|---|
| `plugin` | Plugin name (`openai`, `anthropic`, `local-llm`, …) or an npm package name. Required. |
| `baseUrl` | Upstream API base URL, without the `/v1` suffix. Passed to the `openai`, `local-llm`, `typesafe`, `venice-video` and `fal-video` plugins as their `*_BASE_URL` setting, so you don't need to export it separately. |
| `apiKeyEnv` | Name of the environment variable that holds this provider's API key, so two providers on one seller can use different keys. Applies to the same plugins as `baseUrl`. |
| `pathRewrite` | Exact request paths to rewrite before forwarding upstream, for example `{ "/v1/chat/completions": "/v4/chat/completions" }`. `openai` plugin only. |
| `defaults` | Fallback token pricing for services that don't set their own `pricing`. |
| `services` | The services this provider announces. |

### Service fields

| Field | Description |
|---|---|
| `upstreamModel` | Model ID sent upstream. Defaults to the service ID. |
| `pricing` | `inputUsdPerMillion`, `outputUsdPerMillion` and optional `cachedInputUsdPerMillion`, in USD per million tokens. Overrides the provider's `defaults`. |
| `categories` | Tags announced in discovery. Lowercase letters, digits and hyphens. Buyers can filter on any tag; `privacy`, `legal`, `uncensored`, `coding`, `finance` and `tee` are the well-known ones shown in `antseed network browse --tag`. |
| `capabilities` | Hints about the model. See below. |
| `unitBillingModels` | Per-image, per-video or per-routing-request pricing. See [Unit-billed services](/docs/provide/media). |

Set `cachedInputUsdPerMillion` when your upstream charges less for cache hits. When any seller of a model advertises a cached-input price, buyers count offers of that model that omit it at half their trust score, which can drop them below the buyer's minimum. Free offers are exempt.

### Capabilities

Capabilities tell buyers what a service can do. They are hints, not enforced limits, and an omitted field means "unknown".

| Field | Type | Meaning |
|---|---|---|
| `contextWindow` | number | Total context window in tokens |
| `maxOutputTokens` | number | Maximum output tokens per response |
| `inputs` | string[] | Accepted input modalities: `text`, `image`, `audio`, `video`, `pdf` |
| `outputs` | string[] | Produced output modalities, same values |
| `reasoning` | boolean | Supports reasoning effort or extended thinking |
| `toolUse` | boolean | Supports tool calls |
| `structuredOutput` | boolean | Supports JSON schema responses |
| `supportedParameters` | string[] | Extra request-body parameters the service accepts, in lowercase snake_case (for example `seed`, `output_format`); at most 32 |
| `video` | object | Options a video model accepts. See [Image and video services](/docs/provide/media#video-services) |

## Edit the configuration from the CLI

Add a provider. This also installs its plugin into `~/.antseed/plugins`:

```bash
antseed config seller add-provider inference \
  --plugin openai \
  --base-url https://api.example-inference.com \
  --input 0.5 --cached 0.05 --output 2
```

For OpenRouter, use `--base-url https://openrouter.ai/api`.

Add or update a service. The provider must already exist:

```bash
antseed config seller add-service inference kimi-k2.6 \
  --upstream "<upstream-model-id>" \
  --input 0.6 --cached 0.06 --output 2.5 \
  --categories coding \
  --capabilities '{"contextWindow":128000,"inputs":["text"],"toolUse":true,"reasoning":true}'
```

| Option | Description |
|---|---|
| `--upstream <model>` | Upstream model ID (defaults to the service ID) |
| `--input`, `--output`, `--cached <usd>` | Token prices in USD per million tokens |
| `--categories <list>` | Comma-separated tags |
| `--capabilities <json>` | Capabilities object |
| `--unit-billing-models <json>` | Unit pricing, see [Unit-billed services](/docs/provide/media) |
| `--base-url <url>` | Sets `baseUrl` on the whole provider |

Change single fields or remove entries:

```bash
antseed config seller set providers.inference.services.deepseek-v4-flash.pricing.inputUsdPerMillion 0.2
antseed config seller set providers.inference.services.deepseek-v4-flash.categories '["coding","privacy"]'
antseed config seller remove-service inference kimi-k2.6
antseed config seller remove-provider inference
```

`config seller set` splits the key on dots, so it can't address a service whose ID contains a dot, such as `kimi-k2.6`. Use `add-service` again, which updates an existing service, or edit the file. `set` accepts keys that already exist in the file, any key under `providers`, and the `freeTier`, `freeUsage` and `restrictedCountries` keys shown below; add other blocks, such as `healthCheck`, by editing the file.

`antseed seller setup` builds the capabilities object with one question per field, tailored to the service: image services are asked about input modalities and supported parameters, text services about context window, modalities, reasoning, tool use and structured output. You can paste a JSON object at the capabilities prompt instead.

## Built-in plugins and credentials

Credentials always come from environment variables, never from `config.json`.

| Plugin | Serves | Credential |
|---|---|---|
| `openai` | OpenAI-compatible chat and image APIs | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `local-llm` | Ollama or llama.cpp (default `http://localhost:11434`) | `LOCAL_LLM_API_KEY`, optional |
| `typesafe` | System One decision models (`POST /v1/systemone`) | `TYPESAFE_API_KEY` |
| `venice-video` | Video models behind the Venice video API | `VENICE_VIDEO_API_KEY` |
| `fal-video` | fal.ai video models | `FAL_VIDEO_API_KEY` |
| `claude-code`, `claude-oauth`, `openai-responses` | Subscription credentials, for testing only | Local keychain, OAuth token or Codex auth file |

Any other npm package that exports a provider plugin works too. See [Provider plugin API](/docs/provider-api).

## Node settings

| Key | Default | Description |
|---|---|---|
| `seller.publicAddress` | empty | `host:port` buyers should dial. Needed when the address the DHT sees isn't the one buyers can reach, such as behind a load balancer. Check it with `antseed seller doctor`. |
| `seller.maxConcurrentBuyers` | `50` | Maximum concurrent requests each provider plugin handles. |
| `seller.maxUploadBodyBytes` | 64 MiB | Largest request body accepted from a buyer; at least 1 MiB. `ANTSEED_MAX_UPLOAD_BODY_BYTES` overrides it. |
| `seller.restrictedCountries` | `["CU","IR","KP","SY","RU"]` | Countries whose IP addresses are refused. See below. |
| `seller.freeTier` | none | Request allowance for zero-priced services. See below. |
| `seller.freeUsage` | 16 requests / 15 min | How often free usage is recorded on-chain. See below. |
| `seller.healthCheck` | enabled, 5 min, 3 failures | Model health checks. See below. |
| `seller.gasCheck` | enabled, 60 s, 0.00005 ETH | Pauses advertising while the seller wallet holds less ETH than `minBalanceEth`, checking every `intervalMs` (at least 10 s). Resumes once funded. |
| `seller.verifiers` | none | Verifier SDKs to run provers for. See [TEE seller](/docs/provide/tee). |
| `seller.verifications` | none | Domain and GitHub ownership claims. See [Verified identity](/docs/provide/verified-identity). |
| `seller.agentDir` | none | Ant agent directory. See below. |
| `identity.displayName` | derived from peer ID | Name shown to buyers. |

```bash
antseed config set identity.displayName "Example Inference"
antseed config seller set publicAddress "peer.example.com:6882"
```

### Free-tier limits

A service is free when its token prices and all unit-billing prices are zero. Free services are unlimited unless you set `seller.freeTier`, which applies one allowance across all free services, per buyer address, per IP, or both:

```json
{
  "seller": {
    "freeTier": {
      "maxRequestsPerAddress": 100,
      "maxRequestsPerIp": 300,
      "windowMs": 86400000
    }
  }
}
```

Set at least one of the two limits. `windowMs` is a sliding window (default 24 hours, minimum 1000). A request is served only while every configured limit has room, and only served requests count. Counters are stored in the seller's `metering.db`, survive restarts, and are shared across all free services. When a buyer runs out, the seller answers HTTP 429 with `code: "free_tier_exhausted"`, a `limitedBy` field (`address`, `ip` or `stake`) and a `Retry-After` header. Paid services are unaffected.

| Limit | Keyed on | Caveat |
|---|---|---|
| `maxRequestsPerAddress` | Buyer identity address | A user can create another identity |
| `maxRequestsPerIp` | Connecting IP, IPv6 grouped by /64 | Users behind one NAT share it; a seller behind a proxy sees the proxy's IP |

When you set both, set the IP limit higher so a shared network isn't cut off by one heavy user. Use nonzero pricing when you need stronger protection.

```bash
antseed config seller set freeTier.maxRequestsPerAddress 100
antseed config seller set freeTier.maxRequestsPerIp 300
```

Remove `seller.freeTier` to make free services unlimited again.

#### Staked tiers

Buyers who lock ANTS in your seller pool get a larger free allowance. Their stake raises your pool weight, which multiplies the points your paid usage earns, so staked free users pay you back through your paid services. Staked tiers are on by default whenever `seller.freeTier` is set:

| Staking power | ≈ ANTS locked for one year | Allowance |
|---|---|---|
| 520,000 | 10,000 | 5× the base limit |
| 2,600,000 | 50,000 | 20× the base limit |
| 10,400,000 | 200,000 | Unlimited |

Staking power is ANTS × epochs (weeks) of lock remaining, the same power the seller pool uses for rewards. It is zero until a position activates in the next epoch and shrinks as the lock runs down; a max-locked position keeps 104 epochs of power. The base limit is `maxRequestsPerAddress`, or `maxRequestsPerIp` when only that is set.

The seller reads power from `AntseedSellerPools` for the buyer's address and, once the buyer has paid for usage on-chain, for its operator in `AntseedDeposits`, and uses whichever is larger. Usage is counted on the staked positions themselves, so every buyer behind the same stake shares one allowance, and transferring a position to a new wallet carries its used allowance with it. Staked requests skip the per-IP limit and don't count toward the base limits of unstaked buyers. Lookups are cached for 10 minutes; if the chain can't be read, buyers keep the base limits.

Set your own program with `stakeTiers`, or `[]` to turn staked tiers off. Up to four tiers; `minPower` and `multiplier` must both increase, and `"unlimited"` can only be the last:

```json
{
  "seller": {
    "freeTier": {
      "maxRequestsPerAddress": 100,
      "maxRequestsPerIp": 300,
      "stakeTiers": [
        { "minPower": 260000, "multiplier": 10 },
        { "minPower": 5200000, "multiplier": "unlimited" }
      ]
    }
  }
}
```

Your limits and tiers are signed into your peer metadata as `free-tier.v1.*` capabilities, so buyers, the desktop app and [Antscan](https://antscan.co/api/free-tier) can show them. Tiers are only announced when the seller can read the seller pools and deposits contracts. A staked buyer who runs out gets the same 429 with `limitedBy: "stake"`; every 429 from a seller with tiers also carries `stakeTiers` and the buyer's current `stakePower`. See [Staked free tier](/docs/staked-free-tier) for the buyer side.

### Restricted countries

By default the seller refuses connections from IP addresses in Cuba, Iran, North Korea, Syria and Russia. The lookup uses the bundled `geoip-country` database, so no buyer address leaves the seller. It is best effort: buyers behind a VPN are seen at the VPN's address. A refused buyer gets "This seller does not accept connections from your location.", and `GET /metadata` returns 403 with the same text.

```bash
antseed config seller set restrictedCountries '["CU","IR","KP","SY","RU"]'
antseed config seller set restrictedCountries '[]'    # turn the check off
```

### Free-usage records

Free requests are still recorded on-chain so buyers earn usage credit, and the seller pays the gas. The seller writes a record once `recordBatchSize` free requests have accumulated on a channel, or `recordFlushIntervalMs` after the first unrecorded one, whichever comes first, and always before the channel's deadline. Larger values mean fewer transactions; usage is written later, never dropped.

```bash
antseed config seller set freeUsage.recordBatchSize 64
antseed config seller set freeUsage.recordFlushIntervalMs 3600000
```

Both must be positive integers; `recordFlushIntervalMs` must be at least 1000. The free-usage flow itself is described in [Payments](/docs/payments).

### Model health checks

The seller probes each text service at startup and every `intervalMs` afterwards. After `failureThreshold` consecutive failures it stops advertising the service, and advertises it again when a probe succeeds.

Image and video services are never probed, because a probe would generate a paid result. Instead, the Venice and fal video plugins check the account and model list for free every `intervalMs` (see [Image and video services](/docs/provide/media)).

```json
{
  "seller": {
    "healthCheck": { "enabled": true, "intervalMs": 300000, "failureThreshold": 3 }
  }
}
```

### Ant agent

An ant agent wraps your service with a persona, guardrails, on-demand knowledge and custom tools. Point `agentDir` at a directory containing an `agent.json` manifest, or map service IDs to directories, with `"*"` as the fallback:

```json
{
  "seller": {
    "agentDir": {
      "kimi-k2.6": "./agents/coding",
      "*": "./agents/default"
    }
  }
}
```

Relative paths resolve from the config file's directory. See [Provider plugin API](/docs/provider-api#ant-agent) and the [`@antseed/ant-agent` README](https://github.com/AntSeed/antseed/tree/main/packages/ant-agent) for the manifest format.

## Payment settings

| Key | Default | Description |
|---|---|---|
| `payments.crypto.chainId` | `base-mainnet` | `base-mainnet`, `base-sepolia` or `base-local` |
| `payments.crypto.rpcUrl` | public Base RPC | Your Base JSON-RPC endpoint. See [Base RPC](/docs/buyer-config#base-rpc-url). |
| `payments.minBudgetPerRequest` | `"10000"` ($0.01) | Minimum USDC per request, in base units |
| `payments.minSettleDelta` | `"2000"` ($0.002) | Smallest unsettled amount, in base units, for which the idle settle loop sends a transaction. Closing a channel always settles the full amount. `seller start --min-settle-delta 0.002` overrides it in USDC. |
| `payments.serveWhileClosePending` | `false` | Keep serving channels whose buyer already requested a close on-chain. Work served this way can become uncollectible. |
| `payments.sellerContract.address` | none | An on-chain seller contract that fronts this peer. Buyers check that your peer address is an operator of the contract. |
| `relayer.enabled` | `true` | Relay buyers' gasless deposit sweeps with your seller wallet and earn the relay fee |
| `relayer.minProfitBaseUnits` | `"0"` | Minimum profit (relay fee minus estimated gas), in USDC base units |
| `relayer.maxInFlight` | `2` | Concurrent sweep submissions |
| `relayer.maxPerPeerPerMinute` | `6` | Sweep requests accepted per buyer per minute |

How earnings reach you is covered in [Seller payments](/docs/provide/payments).

## ANTS staking settings {#ants-staking}

`antseed ants` and the seller staking commands find the recognized-usage contracts from the built-in deployment record for `payments.crypto.chainId` and from the on-chain `AntseedRegistry`, so nothing needs configuring on Base mainnet. Two optional settings live under `payments.crypto`:

| Key | Description |
|---|---|
| `explorerApiUrl` | Antscan base URL used for pool statistics, volume history, seller profiles and closed positions. Defaults to `https://antscan.co`. Set it to `""` to read only the chain, which lists only the pools you stake in. |
| `<contract>Address` | Per-contract overrides for local or test deployments: `sellerRegistryAddress`, `sellerPoolsAddress`, `sellerPoolsRewardsAddress`, `usageAccountingAddress`, `usageRewardsAddress`, `emissionsGateAddress`, `positionInitAddress`, `washTradingRegistryAddress`, `pointsPolicyRegistryAddress`, `antsTokenAddress`, `legacyEmissionsContractAddress`, `legacyStakingContractAddress`. `positionInitAddress` has no on-chain pointer and must be set explicitly outside the built-in deployments. |

## Environment variables

Environment variables hold secrets and per-run overrides. The seller-relevant ones are `ANTSEED_IDENTITY_HEX`, `ANTSEED_PASSPHRASE`, the plugin credentials above, `ANTSEED_BASE_RPC_URL`, `ANTSEED_SETTLEMENT_IDLE_MS` (idle time before settling, default 10 minutes), `ANTSEED_MAX_UPLOAD_BODY_BYTES` and `ANTSEED_VERIFIER_SDKS`. See [Flags and environment variables](/docs/flags) for the full list.
