---
sidebar_position: 3
slug: /config
title: Configuration
hide_title: true
---

# Configuration

Antseed stores configuration at `~/.antseed/config.json`. This file is the normal source of truth for your node.

The intended workflow is:

1. Create or update `config.json` with `antseed seller setup` or `antseed config ...`
2. Keep non-secret settings there: providers, services, pricing, capabilities, billing models, ports, bootstrap nodes
3. Keep secrets in environment variables: API keys, identity key
4. Start your node with the grouped runtime commands

Once your config file is populated, the normal seller startup path is just:

```bash
antseed seller start
```

And the normal buyer startup path is:

```bash
antseed buyer start
```

You only need extra flags when you want to override the saved config for a specific run.

## How the Config File Gets Created

You do not need to hand-write `~/.antseed/config.json` unless you want to.

Common ways to create it:

```bash
# Interactive seller onboarding
antseed seller setup

# Add or update config entries directly
antseed config seller add-provider together --plugin openai --base-url https://api.together.ai
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --cached 0.06 --output 1.7
antseed config set identity.displayName "Acme Inference"
```

`--cached` is optional. Set it (on either `add-provider --cached ...` for defaults or `add-service --cached ...` per service) when your upstream charges a reduced rate for cached-input tokens (e.g. Anthropic prompt caching, OpenAI prompt caching).

You can also edit the JSON file directly if that is easier for automation or deployment.

## Config vs Environment Variables

Use `config.json` for durable node behavior. Use env vars for secrets and temporary overrides.

| Put it in `config.json` | Put it in env vars |
|---|---|
| Provider/plugin selection | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| `baseUrl` for OpenAI-compatible providers | `ANTSEED_IDENTITY_HEX` |
| Service list, categories, and capabilities | `ANTSEED_DEBUG=1` |
| Token pricing and per-service unit billing | One-off runtime overrides in deployment scripts |
| Domain/GitHub verification claims | |
| `payments.crypto.rpcUrl` for durable RPC config | `ANTSEED_BASE_RPC_URL` for deployment-specific Base RPC endpoints |
| Buyer proxy port and peer refresh interval | `ANTSEED_DATA_DIR` for per-process buyer state isolation |
| Bootstrap nodes | |

For example, this is a normal production pattern:

```json
{
  "seller": {
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "pricing": {
              "inputUsdPerMillion": 0.6,
              "cachedInputUsdPerMillion": 0.06,
              "outputUsdPerMillion": 1.7
            },
            "categories": ["chat", "coding", "math"],
            "capabilities": {
              "contextWindow": 128000,
              "maxOutputTokens": 32768,
              "inputs": ["text"],
              "reasoning": true,
              "toolUse": true,
              "structuredOutput": true
            }
          }
        }
      }
    }
  }
}
```

```bash
export OPENAI_API_KEY=<your-key>
export ANTSEED_IDENTITY_HEX=<your-identity-key>
antseed seller start
```

## Override Precedence

When the same setting exists in multiple places, Antseed resolves it in this order:

1. CLI flags for the current command
2. Environment variables
3. `config.json`
4. Built-in defaults

So if `config.json` already contains your provider and service setup, you can still do a one-off run like:

```bash
antseed seller start --provider together --input-usd-per-million 0.7
```

That changes only the current process. It does not rewrite `config.json`.

## Data Directory vs Config File

`config.json` controls durable settings, but buyer runtime state is isolated by the data directory. The default data directory is `~/.antseed`; it contains `buyer.state.json`, SQLite databases, payment-channel files, and the fallback `identity.key`.

For each independent buyer node, service integration, isolated test, or concurrent process, use a separate data directory:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"

ANTSEED_DATA_DIR="$BUYDIR" \
antseed --data-dir "$BUYDIR" buyer start \
  --peer <peer-id> \
  --port 8380
```

Prefer `--data-dir` in service/systemd scripts. `ANTSEED_DATA_DIR` is equivalent when the flag is not supplied. If buyer behavior looks stale or files appear in an unexpected place, check the startup log for the resolved data directory and `buyer.state.json` path. Do not rely on `ANTSEED_HOME` for CLI buyer state isolation.

## Config Sections

| Section | Description |
|---|---|
| `identity` | Display name |
| `seller` | Per-provider service offerings (plugin, pricing, capabilities, unit billing, categories, upstream model mapping), free-tier limits, reserve floor, max concurrent buyers, agent directory |
| `buyer` | Max pricing thresholds, proxy port, DHT peer refresh interval |
| `payments` | Chain ID (`base-mainnet` by default) |
| `network` | Bootstrap nodes |

## Seller Shape

Everything a seller announces lives under `seller.providers[name]`. The key under `providers` is a user-chosen label, and `plugin` identifies the provider plugin package that powers it. The list of services, pricing, upstream model mapping, and normie-friendly category tags lives under `seller.providers[name].services[id]`.

```json
{
  "seller": {
    "reserveFloor": 10,
    "maxConcurrentBuyers": 50,
    "freeTier": {
      "maxRequestsPerAddress": 100,
      "maxRequestsPerIp": 300,
      "windowMs": 86400000
    },
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "defaults": {
          "inputUsdPerMillion": 1,
          "outputUsdPerMillion": 2,
          "cachedInputUsdPerMillion": 0.1
        },
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "categories": ["chat", "math", "coding"],
            "pricing": {
              "inputUsdPerMillion": 0.60,
              "outputUsdPerMillion": 1.70,
              "cachedInputUsdPerMillion": 0.06
            }
          },
          "qwen3.5-9b": {
            "upstreamModel": "Qwen/Qwen3.5-9B",
            "categories": ["chat", "fast", "free"],
            "pricing": { "inputUsdPerMillion": 0, "outputUsdPerMillion": 0 }
          }
        }
      }
    }
  }
}
```

Each service entry supports five optional fields:

| Field | Type | Description |
|---|---|---|
| `upstreamModel` | string | The model id the provider plugin will forward requests to. Defaults to the service id itself. |
| `categories` | string[] | Normie-friendly tags announced in peer metadata (e.g. `chat`, `coding`, `math`, `study`, `fast`, `free`). |
| `pricing` | object | Per-service pricing in USD per million tokens. If omitted, the provider's `defaults` are used. |
| `capabilities` | object | Optional discovery hints: `contextWindow`, `maxOutputTokens`, `inputs`, `outputs`, `reasoning`, `toolUse`, `structuredOutput`, and `supportedParameters`. |
| `unitBillingModels` | object | Optional per-protocol non-token pricing. Currently consumed by the `openai` provider for `openai-images` services. |

Capabilities are hints, not enforced limits. Omitted fields mean “unknown.” Supported modality values for `inputs` and `outputs` are `text`, `image`, `audio`, `video`, and `pdf`. `supportedParameters` lists extra request-body parameter names the service accepts (lowercase snake_case, e.g. `background`, `output_format`, `seed`) — useful for image services where clients otherwise have to guess. The `openai` provider automatically advertises `outputs: ["image"]` for `openai-images` services; explicit config extends or overrides that default per field.

For image services, a flat per-image price looks like this:

```json
{
  "unitBillingModels": {
    "openai-images": {
      "version": 1,
      "components": [
        { "unit": "output_images", "priceUsd": 0.04 }
      ]
    }
  }
}
```

Components may include a `match` object using `model`, `size`, `quality`, or `resolution`. Every positive delivered unit must match a component; unmatched image tiers are rejected instead of being billed as zero.

`baseUrl` on the provider block is forwarded to plugins that honor it (the `openai` plugin uses it as `OPENAI_BASE_URL` for Together, OpenRouter, etc.).

If you store `baseUrl` in `config.json`, you do not need to export `OPENAI_BASE_URL` separately. The CLI reads the JSON and passes it to the plugin runtime automatically.

## Adding a Provider (CLI)

Use `antseed config seller add-provider` to create a provider entry and install the matching plugin package:

```bash
# Add a provider backed by the openai plugin, pointed at Together AI
# --cached sets the default cached-input price for every service under
# this provider (overridable per service). Omit it if your upstream does
# not offer a cached-input discount.
antseed config seller add-provider together \
  --plugin openai \
  --base-url https://api.together.ai \
  --input 1 --cached 0.1 --output 2

# Add another using the same plugin for OpenRouter
antseed config seller add-provider openrouter \
  --plugin openai \
  --base-url https://openrouter.ai/api/v1

# Remove a provider
antseed config seller remove-provider openrouter
```

After adding a provider, you typically add one or more services and then start with:

```bash
export OPENAI_API_KEY=<your-key>
antseed seller start
```

## Adding a Service (CLI)

Use `antseed config seller add-service` to add a service entry in one shot:

```bash
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.60 --output 1.70 --cached 0.06 \
  --categories chat,math,coding \
  --base-url https://api.together.ai
```

Capabilities and image unit pricing are JSON options:

```bash
antseed config seller add-service openai flux.1-schnell \
  --upstream "black-forest-labs/FLUX.1-schnell" \
  --input 0 --output 0 \
  --categories image,creative \
  --capabilities '{"inputs":["text","image"],"outputs":["image"],"supportedParameters":["background","output_format","quality","size"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.003}]}}'
```

The interactive `antseed seller setup` flow builds the capabilities object for you with one question per field, tailored to the service's protocol: image models are asked about input modalities and supported request parameters (image output is announced automatically), text models about context window, modalities, reasoning, tool use, structured output, and supported parameters. Answer `y` at the capabilities prompt, or paste a JSON object there to skip the guided flow. Unit billing models are still entered as JSON. The CLI serializes both into plugin runtime config. Seller startup warns when unit billing is configured for a plugin that does not declare support.

To remove one:

```bash
antseed config seller remove-service together deepseek-v3.1
```

You can also edit individual fields directly:

```bash
antseed config seller set providers.together.services.deepseek-v3.1.pricing.inputUsdPerMillion 0.55
antseed config seller set providers.together.services.deepseek-v3.1.categories '["chat","math","coding","fast"]'
antseed config seller set providers.together.services.deepseek-v3.1.capabilities '{"contextWindow":128000,"inputs":["text"],"toolUse":true}'
```

## Free-Tier Limits

A service is free only when its token prices and any unit-billing components are all zero. By default, free services remain unlimited for backward compatibility. Sellers can apply a persistent request allowance across all fully zero-priced services, keyed by buyer address, by remote IP, or both:

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

This example allows each buyer address 100 free requests, and each remote IP 300 free requests, in a sliding 24-hour window. A request is served only while every configured limit still has headroom, and only served requests count. The counters are seller-wide, so switching between free models or reconnecting does not reset them. Usage is stored in the seller's `metering.db` and survives restarts. Once exhausted, the seller returns HTTP `429` with `code: "free_tier_exhausted"`, a `limitedBy` field (`"address"` or `"ip"`), and a `Retry-After` header; paid services are unaffected.

| Limit | Keyed on | Strength | Caveat |
|-------|----------|----------|--------|
| `maxRequestsPerAddress` | The buyer's identity address | Precise per user | A user can create another identity to get a fresh allowance |
| `maxRequestsPerIp` | The connecting IP (IPv6 grouped by /64) | Survives identity rotation | Users behind one NAT or carrier-grade NAT share the allowance; VPN pools spread it |

At least one of the two must be set. When using both, set the IP limit higher than the address limit so shared networks are not cut off by a single heavy user. Neither replaces economic gating: use nonzero service pricing when stronger protection is required. The IP limit only sees the address that connects to the seller, so a seller behind a proxy or relay sees the proxy's IP instead of the buyer's.

Configure it from the CLI or edit `config.json` directly:

```bash
antseed config seller set freeTier.maxRequestsPerAddress 100
antseed config seller set freeTier.maxRequestsPerIp 300
antseed config seller set freeTier.windowMs 86400000
```

Omit `windowMs` to use the 24-hour default. Remove `seller.freeTier` to restore unlimited zero-priced service access.

## Model Health Checks

Seller health checks probe supported text protocols immediately at startup and periodically afterward. After repeated failures, the service is temporarily removed from discovery; its capability and billing metadata disappear with it and return when the service recovers.

`openai-images` services are intentionally skipped. A meaningful image probe would generate a billable image, so image services remain advertised until a non-billable image-specific probe is available.

```json
{
  "seller": {
    "healthCheck": {
      "enabled": true,
      "intervalMs": 300000,
      "failureThreshold": 3
    }
  }
}
```

See the [metadata v12 upgrade guide](/docs/guides/metadata-v12-upgrade) before upgrading seller fleets; older buyers cannot discover v12 sellers.

## Buyer Settings

Model-only requests use one shared Price + Trust policy in the CLI buyer proxy and the desktop AI VPN. The defaults are:

```json
{
  "buyer": {
    "routingPreferences": {
      "preferFreePeers": false,
      "maxInputUsdPerMillion": 25,
      "minTrustScore": 60,
      "allowedPeerIds": [],
      "blockedPeerIds": []
    }
  }
}
```

`minTrustScore` is a hard eligibility gate on the buyer-computed [trust score](/docs/reputation#trust-score). At the default `60`, sellers below 60 and sellers without a usable score are not selected automatically. CLI-only buyers can lower it, or set it to `0` to disable the gate. `allowedPeerIds` becomes an allowlist when non-empty; `blockedPeerIds` always excludes matching sellers. Peer ids may include or omit the `0x` prefix.

Eligible offers are ranked using trust, token or image price, cached-input pricing coverage, recent failures, cooldowns, and `preferFreePeers`. `maxInputUsdPerMillion` is a strong price preference in that ranking; the separate hierarchical `maxPricing` policy remains the hard price-cap mechanism:

```bash
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

The desktop writes routing-preference changes to this same config. A running buyer proxy watches the config file and reloads valid `buyer.routingPreferences` changes automatically.

The buyer proxy refreshes its discovered peer cache from the DHT in the background. The default is 5 minutes, and you can tune it in milliseconds:

```bash
antseed config buyer set peerRefreshIntervalMs 300000
```

Each discovered endpoint is then queried over HTTP for signed peer metadata. The default per-endpoint metadata fetch timeout is 1500ms; raise it for high-latency networks or lower it to make discovery skip slow/offline endpoints faster:

```bash
antseed config buyer set metadataFetchTimeoutMs 1500
```

For one process, use either the runtime flag or env var instead of writing config:

```bash
antseed buyer start --metadata-fetch-timeout-ms 1500
ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS=1500 antseed buyer start
```

Long-running models can exceed the defaults (5 minutes for `requestTimeoutMs`, 30 minutes for `maxStreamDurationMs`). Configure the initial/non-streaming request timeout and the maximum total stream duration independently:

```bash
antseed config buyer set requestTimeoutMs 600000
antseed config buyer set maxStreamDurationMs 3600000
```

`requestTimeoutMs` applies while waiting for a non-streaming response or for a stream to begin. Once streaming starts, idle-stream protection remains active, while `maxStreamDurationMs` controls the total permitted stream lifetime. The stream cap can also be set per process with the `ANTSEED_BUYER_MAX_STREAM_DURATION_MS` environment variable.

Buyer SpendingAuth and free-usage metadata v2 include aggregate usage totals by default. They also include per-service attribution unless disabled. Privacy-sensitive buyers can keep aggregate accounting while suppressing service IDs and per-service totals:

```bash
antseed config buyer set disableMetadataV2Services true
antseed buyer start --disable-metadata-v2-services
ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES=true antseed buyer start
```

## Identity and Metadata

```bash
antseed config set identity.displayName "Acme Inference - us-east-1"
antseed config seller set publicAddress "peer.example.com:6882"
```

## Domain and GitHub Verification

Sellers can publish optional ownership claims in signed peer metadata. These claims let buyers and directories show that a peer is connected to a public domain or GitHub account controlled by the operator.

Verification claims bind to the seller **peer ID** — the EVM address derived from the seller identity key. If your deployment also advertises a seller contract, such as a staking proxy, the external proof still contains the peer ID, not the contract address. Buyers verify the seller-contract relationship separately on-chain.

Add claims under `seller.verifications`:

```json
{
  "seller": {
    "verifications": {
      "domains": [
        {
          "domain": "provider.example.com",
          "methods": ["dns-txt"]
        }
      ],
      "github": [
        {
          "username": "example-org",
          "repository": "antseed-verification"
        }
      ]
    }
  }
}
```

### Domain proof

For DNS TXT verification, create a TXT record at `_antseed.<domain>`:

```text
Name:  _antseed.provider.example.com
Type:  TXT
Value: antseed-peer=<peer-id-without-0x>
```

Example:

```text
antseed-peer=9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7
```

If you prefer HTTPS verification, serve this JSON at `https://<domain>/.well-known/antseed.json` and configure the claim with `"methods": ["https-well-known"]`:

```json
{
  "type": "antseed-domain-verification",
  "peerId": "9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7",
  "domain": "provider.example.com"
}
```

Do not redirect the well-known URL; verifiers require the proof to be served directly from the claimed domain.

### GitHub proof

Create a public repository and place `antseed.json` at the repository root. Antseed fetches:

```text
https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json
```

The file must contain:

```json
{
  "type": "antseed-github-verification",
  "peerId": "9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7",
  "username": "example-org"
}
```

The `repository` field is configured in `config.json`; it is not included in the proof file. If `repository` is omitted, verifiers use the profile repository named after the username.

After updating config and publishing proofs, restart the seller. Startup logs will print the configured verification claims, and `/metadata` will include `verifications`.

## Provider Authentication

Provider plugins authenticate with their upstream AI service. Credentials live in environment variables — they never belong in `config.json`.

| Provider | Auth env var | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | |
| `openai` | `OPENAI_API_KEY` | Set `providers.<name>.baseUrl` in config.json for Together/OpenRouter/etc. |
| `claude-code` | keychain | Reads from `claude-code` secure storage |
| `local-llm` | none | Ollama/llama.cpp |
| `typesafe` | `TYPESAFE_API_KEY` | System One decision models (`POST /v1/systemone`). Set `providers.<name>.baseUrl` for a compatible upstream. |

The separation is intentional:

- `config.json` says what you offer
- env vars say how to authenticate

That means you can commit deployment config templates safely while injecting secrets at runtime.

## Ant Agent

Providers can wrap their service with an ant agent — a knowledge-augmented AI service that injects a persona, guardrails, and on-demand knowledge into buyer requests.

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest defining persona, guardrails, knowledge modules, and custom tools. The LLM decides which knowledge to load during the conversation. Buyers see only the final response.

Per-service agents (different agents for different services):

```json
{
  "seller": {
    "agentDir": {
      "social-strategist": "./agents/social",
      "code-reviewer": "./agents/coding",
      "*": "./agents/default"
    }
  }
}
```

See the [`@antseed/ant-agent` README](https://github.com/AntSeed/antseed/tree/main/packages/ant-agent) for the full manifest reference.

## Identity Storage

| Priority | Method | Best for |
|---|---|---|
| 1 | `ANTSEED_IDENTITY_HEX` env var | CLI and server deployments |
| 2 | Desktop keychain (Electron `safeStorage`) | Antseed Desktop app |
| 3 | Custom `IdentityStore` | KMS/HSM integrations |
| 4 | `~/.antseed/identity.key` (plaintext) | Not recommended for production |

For production servers, pass the key from a secrets manager:

```bash
export ANTSEED_IDENTITY_HEX="$(vault kv get -field=key secret/antseed/identity)"
```

## Base RPC URL

Sellers should configure a dedicated Base JSON-RPC endpoint for production deployments. Public defaults are fine for testing, but provider RPCs (Alchemy, Infura, QuickNode, self-hosted nodes, etc.) are more reliable for seller registration, staking, reserve, settle, and close transactions.

Use `payments.crypto.rpcUrl` for durable config:

```bash
antseed config set payments.crypto.rpcUrl "https://base-mainnet.g.alchemy.com/v2/<key>"
```

Or use runtime overrides when you do not want to edit `config.json`:

```bash
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start

# one-off process override
antseed seller start --base-rpc-url https://base-mainnet.infura.io/v3/<key>
```

Precedence is: CLI flag, then `ANTSEED_BASE_RPC_URL`, then `payments.crypto.rpcUrl`, then built-in Base defaults.

## ANTS Staking

`antseed ants` and its subcommands use the same chain settings as the rest of
the CLI. Contract addresses for the recognized-usage stack (seller registry,
seller pools, usage accounting, usage rewards, emissions gate, wash-trading
registry, points policy registry) come from the built-in deployment record for
`payments.chainId` and from the on-chain `AntseedRegistry`, so nothing needs to
be configured on Base Mainnet.

Two optional settings under `payments.crypto`:

| Key | Description |
|---|---|
| `explorerApiUrl` | Antscan base URL. `antseed ants` takes pool statistics, per-epoch volume and usage, seller profiles, and closed positions from it and reads the chain only for your wallet's live state. Defaults to `https://antscan.co`; set it to `""` to disable (for example on a local fork), which leaves only the pools you stake in listed. |
| `<contract>Address` | Per-contract overrides for local or test deployments: `sellerRegistryAddress`, `sellerPoolsAddress`, `sellerPoolsRewardsAddress`, `usageAccountingAddress`, `usageRewardsAddress`, `emissionsGateAddress`, `positionInitAddress`, `washTradingRegistryAddress`, `pointsPolicyRegistryAddress`, `antsTokenAddress`, `legacyEmissionsContractAddress`, `legacyStakingContractAddress`. `positionInitAddress` has no on-chain pointer and must be set explicitly outside the built-in deployments. |

```bash
antseed config set payments.crypto.explorerApiUrl ""
```

See the [staking guide](/docs/guides/staking) for what the dashboard shows.

## Runtime Environment Variables

Only secrets, global toggles, and deployment-specific runtime overrides are set via env vars — everything else is in `config.json`.

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | Identity private key (64 hex chars, optional 0x prefix) |
| `ANTSEED_BASE_RPC_URL` | Runtime Base JSON-RPC endpoint override for seller on-chain operations |
| `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS` | Runtime buyer peer-discovery metadata fetch timeout in milliseconds |
| `ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES` | Runtime opt-out for buyer per-service metadata v2 attribution (`true` opts out) |
| `ANTHROPIC_API_KEY` | Upstream Anthropic API key (used by the `anthropic` provider plugin) |
| `OPENAI_API_KEY` | Upstream OpenAI-compatible API key (used by the `openai` provider plugin) |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Idle time before settling a session (default: 600000 / 10 min) |
| `ANTSEED_DEFAULT_DEPOSIT_USDC` | Default lock amount per session (default: 1) |
| `ANTSEED_DEBUG` | Enable debug logging (set to 1) |
