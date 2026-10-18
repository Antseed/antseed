---
slug: /buyer-config
title: Buyer configuration
description: Where the buyer config file lives, the buyer settings it holds, routing preferences, data directories and the Base RPC URL.
---

# Buyer configuration

The buyer reads its settings from `~/.antseed/config.json`. You do not need the file to start: `antseed buyer start` uses built-in defaults when it is missing. Add settings only when you want to change routing, price caps, timeouts or the chain connection.

The desktop app and the Gateway Console write to the same file: the desktop's **Preferences** and the console's **Settings → Buyer**. Seller settings live in the same file and are covered in [Seller configuration](/docs/provide/config).

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
| `buyer.proxyPort` | `8377` | Local proxy port |
| `buyer.routingPreferences` | see below | Automatic routing preferences |
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
| `network.bootstrapNodes` | `[]` | Extra DHT bootstrap nodes, added to the built-in ones |

Some buyer start flags override these for one run, for example `--port`, `--max-input-usd-per-million`, `--max-output-usd-per-million` and `--metadata-fetch-timeout-ms`. See [CLI commands](/docs/commands).

## Routing preferences

`buyer.routingPreferences` controls automatic routing for model-only requests. The desktop app's **Preferences** edit the same values. Defaults:

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
