---
sidebar_position: 2
slug: /flags
title: Global Flags
sidebar_label: Flags
hide_title: true
---

# Global Flags

```bash title="flags"
-c, --config <path>     Path to config file (default: ~/.antseed/config.json)
--data-dir <path>       Path to node identity/state directory (env: ANTSEED_DATA_DIR, default: ~/.antseed)
-v, --verbose            Enable verbose logging
--version                Show version
--help                   Show help
```

`--data-dir` controls buyer/seller identity and runtime state: `identity.key`, `buyer.state.json`, SQLite databases, and payment-channel files. Use a separate data directory for each independent buyer process. The environment-variable equivalent is `ANTSEED_DATA_DIR=<path>`; prefer the explicit flag in service manager commands.

## Buyer Start Flags

`antseed buyer start` also supports runtime-only overrides for buyer discovery:

```bash title="buyer start"
--metadata-fetch-timeout-ms <number>    Timeout for each peer metadata HTTP fetch during discovery
```

The same value can be supplied with `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS`. Precedence is: flag, environment variable, `buyer.metadataFetchTimeoutMs`, built-in default.

### Bind host and proxy auth token

```bash title="buyer start"
--host <host>            Interface the proxy listens on (default: 127.0.0.1)
--auth-token <token>     Require Authorization: Bearer <token> on every request (env: ANTSEED_PROXY_TOKEN)
```

By default the buyer proxy listens on `127.0.0.1` and accepts any local request. To reach it from another machine or container (a VPS, a CI runner, a remote agent), give it a token:

```bash
export ANTSEED_PROXY_TOKEN=$(openssl rand -hex 32)
antseed buyer start --host 0.0.0.0
```

With a token set, every request (API routes and the `/_antseed/*` control plane) must send `Authorization: Bearer <token>`, and anything else gets `401`. The token is compared in constant time and is never forwarded to a seller. Tokens must be at least 16 printable characters.

`antseed buyer start` **refuses to start** on a non-loopback `--host` without a token: anyone who can reach the port could spend the buyer's wallet. Exposing the proxy without a token is not supported. The proxy speaks plain HTTP, so put TLS in front of it (a reverse proxy or tunnel) when it crosses an untrusted network. For per-user keys with spend limits, use [`antseed gateway`](/docs/guides/gateway-api-keys) instead.

Clients send the token as their API key:

```bash
export ANTHROPIC_BASE_URL=http://buyer-host:8377
export ANTHROPIC_AUTH_TOKEN=$ANTSEED_PROXY_TOKEN     # Claude Code (sent as Authorization: Bearer)
export OPENAI_BASE_URL=http://buyer-host:8377/v1
export OPENAI_API_KEY=$ANTSEED_PROXY_TOKEN
```

The CLI's own commands on the same machine (`antseed buyer deposit`, `sweep`, `activity`, `channels close`, `antseed gateway`, `antseed tunnel`, `antseed system-proxy`, and the `antseed claude` / `codex` / `opencode` wrappers) find the running buyer's token automatically: it is written to `<data-dir>/buyer-proxy-auth-<port>.json` with `0600` permissions while the buyer runs. For a buyer on another host, set `ANTSEED_PROXY_TOKEN` in the client's environment. Buyers started by the desktop app never use a token.

## Seller Start Flags

`antseed seller start` also supports runtime-only overrides for seller operations:

```bash title="seller start"
--base-rpc-url <url>    Base JSON-RPC endpoint for seller on-chain operations
```

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

```bash title="metrics"
--role <buyer|seller|both|auto>
--host <host>
--port <port>
--path <path>
--instance <name>
--include-chain
```

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
