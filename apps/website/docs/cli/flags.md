---
sidebar_position: 2
slug: /flags
title: Global Flags
sidebar_label: Flags
hide_title: true
---

# Global Flags

<div className="command-table">

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file (default: `~/.antseed/config.json`) |
| `--data-dir <path>` | Path to node identity/state directory (env: `ANTSEED_DATA_DIR`, default: `~/.antseed`) |
| `-v, --verbose` | Enable verbose logging |
| `--version` | Show version |
| `--help` | Show help |

</div>

`--data-dir` controls buyer/seller identity and runtime state: `identity.key`, `buyer.state.json`, SQLite databases, and payment-channel files. Use a separate data directory for each independent buyer process. The environment-variable equivalent is `ANTSEED_DATA_DIR=<path>`; prefer the explicit flag in service manager commands.

## Buyer Start Flags

`antseed buyer start` also supports runtime-only overrides for buyer discovery:

<div className="command-table">

| Flag | Description |
|---|---|
| `--metadata-fetch-timeout-ms <number>` | Timeout for each peer metadata HTTP fetch during discovery |

</div>

The same value can be supplied with `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS`. Precedence is: flag, environment variable, `buyer.metadataFetchTimeoutMs`, built-in default.

## Seller Start Flags

`antseed seller start` also supports runtime-only overrides for seller operations:

<div className="command-table">

| Flag | Description |
|---|---|
| `--base-rpc-url <url>` | Base JSON-RPC endpoint for seller on-chain operations |

</div>

The same value can be supplied with `ANTSEED_BASE_RPC_URL`. Precedence is: flag, environment variable, `payments.crypto.rpcUrl`, built-in default.

Service capabilities and image unit pricing are durable service configuration rather than `seller start` flags. Set them with:

```bash
antseed config seller add-service <provider> <service> \
  --capabilities '<json>' \
  --unit-billing-models '<json>'
```

They can also be entered in `antseed seller setup` or written directly under `seller.providers.<provider>.services.<service>` in `config.json`.

## Metrics Flags

`antseed metrics serve` also supports:

<div className="command-table">

| Flag | Description |
|---|---|
| `--role <buyer\|seller\|both\|auto>` | Metrics role (default: `auto`) |
| `--host <host>` | Listen host (default: `127.0.0.1`) |
| `--port <port>` | Listen port (default: `9108`) |
| `--path <path>` | Metrics path (default: `/metrics`) |
| `--instance <name>` | Instance label for Prometheus series |
| `--include-chain` | Include chain balance metrics; may add RPC latency |

</div>

See [Metrics](/docs/guides/metrics) for details.

## Environment Variables

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | secp256k1 private key (64 hex chars). When set, used instead of `identity.key` file. Cleared from process environment after read. |
| `ANTSEED_DATA_DIR` | Node identity/state directory when `--data-dir` is not supplied. Use separate values for independent buyer processes. |
| `ANTSEED_DEBUG` | Enable verbose runtime logs (`0` or `1`) |
| `ANTSEED_ENV_FILE` | Override env file path for runtime env loading |
| ~~`ANTSEED_ALLOWED_SERVICES`~~ | Removed as a user-facing env var. The set of announced services is now derived from the keys under `seller.providers[name].services` in `config.json`. The CLI still injects the env var for plugins internally. |
| `ANTSEED_ENABLE_SETTLEMENT` | Enable on-chain settlement (`true`/`false`) |
| `ANTSEED_BASE_RPC_URL` | Base JSON-RPC endpoint override for seller on-chain operations |
| `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS` | Buyer peer-discovery metadata fetch timeout in milliseconds |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Settlement idle timeout in milliseconds |
| `ANTSEED_DEFAULT_SESSION_USDC` | Default session authorization amount in USDC |
| `ANTSEED_AUTO_FUND_DEPOSIT` | Auto-fund deposit on session start (`true`/`false`) |
| `ANTSEED_SELLER_WALLET_ADDRESS` | Seller EVM wallet address override |
| `ANTSEED_METRICS_ROLE` | Metrics exporter role (`buyer`, `seller`, `both`, or `auto`) |
| `ANTSEED_METRICS_HOST` | Metrics exporter listen host |
| `ANTSEED_METRICS_PORT` | Metrics exporter listen port |
| `ANTSEED_METRICS_PATH` | Metrics endpoint path |
| `ANTSEED_METRICS_INSTANCE` | Metrics `instance` label |
