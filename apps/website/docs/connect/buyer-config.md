---
slug: /buyer-config
title: Buyer configuration
description: Where the buyer config file lives, the buyer settings it holds, routing preferences, data directories and the Base RPC URL.
---

# Buyer configuration

The buyer reads its settings from `~/.antseed/config.json`. You do not need the file to start: `antseed buyer start` uses built-in defaults when it is missing. Add settings only when you want to change routing, price caps, timeouts or the chain connection.

The Gateway Console writes to the same file from **Settings → Buyer**. Seller settings live in the same file and are covered in [Seller configuration](/docs/provide/config).

## Edit the config

```bash
antseed config init                    # create the file with defaults
antseed config buyer show              # print buyer settings
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config show                    # whole file, credentials redacted
```

`config set` splits the key on dots and only accepts keys that already exist in the file (plus a few seller keys); anything else is rejected with the list of valid keys. For other settings, such as `payments.crypto.rpcUrl`, edit the JSON directly. Use `--config <path>` or `ANTSEED_CONFIG` to point at another file.

Settings resolve in this order: command-line flags, then environment variables, then `config.json`, then built-in defaults. Flags only affect that run; they do not rewrite the file.

## Buyer settings

| Key | Default | Meaning |
|---|---|---|
| `buyer.proxyPort` | `8377` | Local proxy port. The proxy always listens on `127.0.0.1`; there is no host setting (see [Reach it from other machines](/docs/api#reach-it-from-other-machines)) |
| `buyer.routingPreferences` | see below | Automatic routing preferences |
| `buyer.reasoningEffort` | `off` | Reasoning effort added to requests that name none; see [Default reasoning effort](#default-reasoning-effort) |
| `buyer.maxPricing` | `100` / `100` USD per million tokens | Hard price caps, see below |
| `buyer.minPeerReputation` | `0` | Hard minimum reputation (0–100), applied to pinned requests too |
| `buyer.peerRefreshIntervalMs` | `300000` (5 min) | How often the buyer refreshes peers from the DHT |
| `buyer.metadataFetchTimeoutMs` | `1500` | Timeout for each peer metadata fetch during discovery |
| `buyer.requestTimeoutMs` | `300000` (5 min) | Wait for a non-streaming response, or for a stream to start |
| `buyer.maxStreamDurationMs` | `1800000` (30 min) | Longest a streamed response may run |
| `buyer.disableMetadataV2Services` | `false` | `true` keeps service ids and per-service totals out of the usage metadata you sign |
| `buyer.autoSweep` | `true` | Move USDC that arrives in the buyer wallet into your deposits automatically |
| `buyer.verifier` | verify, not required | Seller TEE verification; see [Verify a seller's TEE](/docs/verify-tee) |
| `payments.crypto.chainId` | `base-mainnet` | Chain: `base-mainnet`, `base-sepolia` or `base-local` |
| `payments.crypto.rpcUrl` | chain default | Base JSON-RPC URL; see [Base RPC URL](#base-rpc-url) |
| `payments.maxPerRequestUsdc` | `300000` ($0.30) | Most the buyer authorizes beyond its own cost estimate in one request, in USDC base units |
| `payments.maxVideoRequestUsdc` | `5000000` ($5.00) | Most one video may cost, in USDC base units |
| `payments.maxReserveAmountUsdc` | `1000000` ($1.00) | Most the buyer reserves for one payment channel, in USDC base units |
| `network.bootstrapNodes` | `[]` | Extra DHT bootstrap nodes. They are added to the built-in public nodes and can't replace them; see [Test your seller before going live](/docs/provide/test-locally) |
| `network.noOfficialBootstrap` | `false` | Use only `network.bootstrapNodes`, for an isolated test network |
| `network.dhtPort` | OS-assigned | UDP port of the node's DHT socket |
| `network.bindHost` | all interfaces | Local address the node's DHT socket binds to |

Some buyer start flags override these for one run, for example `--port`, `--max-input-usd-per-million`, `--max-output-usd-per-million` and `--metadata-fetch-timeout-ms`. See [CLI commands](/docs/commands).

## Routing preferences

`buyer.routingPreferences` controls automatic routing for model-only requests. Defaults:

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

- `minTrustScore` excludes sellers below this [trust score](/docs/reputation), and sellers without one. Set `0` to turn the gate off.
- `maxInputUsdPerMillion` is a soft preference: pricier sellers rank lower but are not excluded.
- `preferFreePeers` gives free sellers a strong ranking advantage.
- `allowedPeerIds` limits automatic routing to these sellers when non-empty. `blockedPeerIds` always excludes its sellers. Ids may include or omit `0x`.

A running buyer reloads valid changes to `routingPreferences` without a restart. How these feed the ranking is described in [Routing and catalog](/docs/api/routing).

### Hard price caps

`buyer.maxPricing` sets the most you will pay. Unlike `routingPreferences`, it also applies to pinned requests:

```bash
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

## Default reasoning effort

When a request names no reasoning effort, each seller applies its own default, so the same request can get more or less reasoning depending on which seller serves it. `buyer.reasoningEffort` lets the buyer add one instead: a level for every model (`default`) and levels for single models (`models`). `off` adds nothing.

```json
{
  "buyer": {
    "reasoningEffort": {
      "default": "medium",
      "models": {
        "glm-5.3": "high",
        "kimi-k2.6": "off"
      }
    }
  }
}
```

```bash
antseed config buyer set reasoningEffort.default medium
antseed config buyer set reasoningEffort.models.kimi-k3 high
# a model id with a dot needs the JSON form, because key paths split on dots; it replaces every per-model level:
antseed config buyer set reasoningEffort.models '{"glm-5.3":"high"}'
```

- A seller gets the level only when it announces the reasoning efforts it accepts for the service ([`reasoningEfforts`](/docs/provide/config#capabilities)) and that list has exactly that level. A seller that announces no list gets no default effort, and neither does one whose list lacks the level: no other level is put in its place, and this setting changes nothing in the request.
- Only `POST /v1/chat/completions` and `POST /v1/responses` requests get a level, and only when they name no effort.
- A request that makes its own reasoning choice gets no level added. These fields count as one, with any value: `reasoning_effort`, `thinking`, `enable_thinking`, `thinking_budget`, `thinking_config`, `include_reasoning` and `think` at the top level, `enable_thinking` or `thinking` inside `chat_template_kwargs`, a `reasoning` field on Chat Completions, and on Responses an `effort` in the `reasoning` object or a `reasoning` that is not an object.
- When the buyer adds a level, it reads the JSON body and writes it out again with the level added. Spacing and key order can change, a key that appears twice keeps only its last value, and a number with more digits than JSON parsers keep (such as a 20-digit `seed`) is rounded. A request the buyer adds no level to is not changed by this setting.
- A level is 1 to 64 visible ASCII characters with no spaces, matched exactly. `off` in any letter case adds nothing, so a level a seller names `off` can't be chosen.
- A model listed in `models` ignores `default`. Model ids match the way routing matches them, so `z-ai/glm-5.3` and `glm-5.3` are the same model.
- The level is decided again for each seller a request is sent to, so a failover seller gets its own answer.
- Requests to and from Anthropic Messages are not changed.

The response header `x-antseed-default-reasoning-effort` names the level the buyer added; see [the API reference](/docs/api#response-headers).

Changes apply at once; the buyer does not need a restart.

## Data directory

The buyer keeps its state in a data directory, `~/.antseed` by default: `buyer.state.json`, SQLite databases, payment channel files and the identity key. Two buyers must never share one.

Give each buyer, service or test its own directory with `--data-dir` (or `ANTSEED_DATA_DIR`) and its own port:

```bash
antseed --data-dir "$HOME/.antseed-buyer-myapp" buyer start --port 8380
```

Prefer `--data-dir` in systemd units and scripts, since it is explicit. `ANTSEED_HOME` does not isolate buyer state. If a buyer shows stale pins or channels, check the startup log for the data directory and `buyer.state.json` path it resolved.

To pay from several wallets with one buyer, add buyer identities instead of running more buyers; see [Gateway API](/docs/gateway/api).

## Base RPC URL

Buyers, sellers and gateways read Base through a JSON-RPC endpoint. The built-in public endpoints are fine for trying things out, but they are rate-limited. For anything that runs for real, and for every seller, use a dedicated endpoint from an RPC provider or your own node.

Set it in `config.json` (edit the file; `antseed config set` rejects this key until it exists):

```json
{
  "payments": {
    "crypto": { "rpcUrl": "https://base-mainnet.example.com/<key>" }
  }
}
```

Or per process, with `ANTSEED_BASE_RPC_URL`:

```bash
ANTSEED_BASE_RPC_URL="https://base-mainnet.example.com/<key>" antseed buyer start
```

Sellers can also pass `--base-rpc-url` to `antseed seller start`. The order is: flag, then `ANTSEED_BASE_RPC_URL`, then `payments.crypto.rpcUrl`, then the built-in defaults. `payments.crypto.fallbackRpcUrls` adds endpoints to try in order. A gateway can set the buyer's RPC URL in **Settings → Buyer → Payments**.

## Identity

The buyer's identity key comes from `ANTSEED_IDENTITY_HEX` when set, otherwise from `identity.key` in the data directory, which is created on first run. The desktop app keeps its key in the operating system keychain. To encrypt the key file with a passphrase, see [Protecting wallet keys](/docs/gateway/wallet-keys).

## Environment variables

Environment variables are for secrets and per-process overrides. The full list is in [Global flags and environment variables](/docs/flags).
