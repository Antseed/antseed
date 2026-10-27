---
title: Global flags and environment variables
slug: /flags
description: Flags every antseed command accepts, the full buyer start flag list, and every environment variable you can set.
sidebar_label: Flags and env vars
---

# Global flags and environment variables

## Global flags

Every command accepts these flags. Put them before the command: `antseed --data-dir ~/.antseed-buyer2 buyer start`.

| Flag | Description |
|---|---|
| `--config <path>` | Config file. Env: `ANTSEED_CONFIG`. Default: `~/.antseed/config.json` |
| `--data-dir <path>` | Identity and state directory. Env: `ANTSEED_DATA_DIR`. Default: `~/.antseed` |
| `--verbose` | Verbose logging (same as `ANTSEED_DEBUG=1`) |
| `--version` | Print the version |
| `--help` | Show help for any command |

The data directory holds the wallet key (`identity.key`), buyer identities, gateway state, SQLite databases and payment-channel files. Give each independent buyer process its own data directory. See [Buyer configuration](/docs/buyer-config) for isolating several buyers.

## Buyer start flags

`antseed buyer start` takes these flags. Runtime-only flags apply to this run and do not change the config file.

| Flag | Description |
|---|---|
| `--port <number>` | Local proxy port. Default: `buyer.proxyPort` (8377) |
| `--router <name>` | Router plugin name or npm package. Default: `local` |
| `--instance <id>` | Use a configured plugin instance by ID |
| `--max-input-usd-per-million <number>` | Runtime-only cap on input price, USD per million tokens |
| `--max-output-usd-per-million <number>` | Runtime-only cap on output price, USD per million tokens |
| `--metadata-fetch-timeout-ms <number>` | Runtime-only timeout for each seller metadata fetch during discovery (default 1500, minimum 100) |
| `--disable-metadata-v2-services` | Runtime-only opt-out from per-service attribution in signed request metadata |
| `--peer <peerId>` | Pin every request to one seller (40-character hex address), bypassing the router |
| `--log-filter <sourceOrText>` | Turn on debug logs and show only lines matching a source or text, for example `ProxyMux` |
| `--verifiers <ids>` | Ordered, comma-separated verifier SDK ids to verify sellers with. Default: the seller's advertised default, if trusted |
| `--require-verifier` | Refuse to route unless a verifier verifies the seller. Default: verify but route anyway |
| `--no-verifier` | Turn seller verification off |

There is no `--host` flag: the buyer proxy always listens on `127.0.0.1`. To reach it from other machines, use a gateway; see [Reach it from other machines](/docs/api#reach-it-from-other-machines).

Precedence for settings that have a flag, a variable and a config key: flag, then environment variable, then `config.json`, then the built-in default.

Flags for every other command are listed on [CLI commands](/docs/commands) and in `antseed <command> --help`.

## Environment variables

The CLI also reads `.env.local` and `.env` from the current directory, and the file named by `ANTSEED_ENV_FILE`. Variables already set in the environment win over values from these files.

| Variable | Used by | Description |
|---|---|---|
| `ANTSEED_CONFIG` | all | Config file path when `--config` is not given |
| `ANTSEED_DATA_DIR` | all | Data directory when `--data-dir` is not given |
| `ANTSEED_ENV_FILE` | all | Extra env file to load before `.env.local` and `.env` |
| `ANTSEED_DEBUG` | all | `1` turns on debug logs |
| `ANTSEED_LOG_FILTER` | buyer | Show only debug lines matching this source or text (same as `--log-filter`) |
| `ANTSEED_PASSPHRASE` | all | Passphrase that decrypts encrypted wallet keys (`identity.key` and buyer identities). At least 12 characters. See [Wallet keys](/docs/gateway/wallet-keys) |
| `ANTSEED_PASSPHRASE_FILE` | all | File whose first line is the passphrase; used when `ANTSEED_PASSPHRASE` is not set, and keeps it out of the process environment |
| `ANTSEED_IDENTITY_HEX` | all | Wallet private key (64 hex characters) to use instead of `identity.key`. Removed from the environment after it is read |
| `ANTSEED_BASE_RPC_URL` | buyer, seller, gateway | Base JSON-RPC URL; overrides `payments.crypto.rpcUrl`. `seller start --base-rpc-url` takes precedence |
| `ANTSEED_ENABLE_SETTLEMENT` | buyer, seller | `false` runs without payments. On a seller, `true` keeps payments on even when the RPC does not answer at startup |
| `ANTSEED_SKIP_PLUGIN_UPDATE_CHECK` | all | `1` skips the plugin update check (air-gapped hosts, CI) |
| `ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION` | buyer | Overrides `buyer.maxPricing.defaults.inputUsdPerMillion` (default 100) |
| `ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION` | buyer | Overrides `buyer.maxPricing.defaults.outputUsdPerMillion` (default 100) |
| `ANTSEED_BUYER_MIN_REPUTATION` | buyer | Overrides `buyer.minPeerReputation` (0–100, default 0) |
| `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS` | buyer | Overrides `buyer.metadataFetchTimeoutMs` (default 1500, minimum 100) |
| `ANTSEED_BUYER_MAX_STREAM_DURATION_MS` | buyer | Overrides `buyer.maxStreamDurationMs`, the longest streamed response (default 1800000, 30 minutes) |
| `ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES` | buyer | `true` turns off per-service attribution in signed request metadata |
| `ANTSEED_SUPERVISED` | buyer | `1` declares that a supervisor (systemd, Docker, launchd, pm2) restarts the process, so the buyer accepts restart requests. The server installer sets it |
| `ANTSEED_GATEWAY_PUBLIC_URL` | gateway, tunnel | Origin the console is reached at, for example `https://gateway.example.com`. Same as `gateway start --public-url`; needed for passkeys and single sign-on off this machine |
| `ANTSEED_X402_FACILITATOR_URL` | gateway | Turns on x402 top-ups of key wallets: a facilitator URL, `cdp` or `payai`. Same as `--x402-facilitator` |
| `ANTSEED_X402_FACILITATOR_AUTHORIZATION` | gateway | Static authorization token for a facilitator that needs one |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | gateway | Coinbase CDP credentials, required with the `cdp` facilitator |
| `ANTSEED_OIDC_ISSUER`, `ANTSEED_OIDC_CLIENT_ID`, `ANTSEED_OIDC_CLIENT_SECRET` | gateway | Single sign-on (OpenID Connect) for the console. Needs an `https://` public URL. See [Sign-in](/docs/gateway/sign-in) |
| `ANTSEED_OIDC_LABEL` | gateway | Sign-in button label. Default: `Google` for Google, else `Single sign-on` |
| `ANTSEED_OIDC_ALLOWED_DOMAINS` | gateway | Comma-separated email domains allowed to sign in with single sign-on |
| `ANTSEED_CF_ACCESS_TEAM_DOMAIN`, `ANTSEED_CF_ACCESS_AUD` | gateway | Cloudflare Access team domain and application audience tag, for console sign-in behind Cloudflare Access |
| `ANTSEED_TRUST_CLOUDFLARE_HEADERS` | gateway | `1` trusts `CF-Connecting-IP` as the client address; only when the gateway runs behind its own Cloudflare tunnel |
| `ANTSEED_BRAVE_API_KEY` | gateway | Brave Search key for console chat web search. Without it, chat uses DuckDuckGo |
| `ANTSEED_PAY_URL` | gateway | Card checkout (Antseed Pay) URL used by the console's **Wallet & Funding** page |
| `ANTSEED_GATEWAY_KEY` | chat | Gateway API key for `antseed chat` (same as `--key`) |
| `ANTSEED_TUNNEL_PROVIDER` | tunnel | `cloudflare` (default) or `ngrok`; `--provider` takes precedence |
| `ANTSEED_TUNNEL_TOKEN` | tunnel | Tunnel token. Falls back to `CLOUDFLARED_TUNNEL_TOKEN` (Cloudflare) or `NGROK_AUTHTOKEN` (ngrok) |
| `ANTSEED_TUNNEL_PUBLIC_URL` | tunnel | `https://` hostname of the tunnel; required for Cloudflare |
| `ANTSEED_TUNNEL_API_KEY` | tunnel | Legacy single client API key (at least 16 characters), kept as an unlimited key on the default identity. Prefer `antseed gateway key create` |
| `ANTSEED_NGROK_BIN` | tunnel | Path to the `ngrok` binary |
| `ANTSEED_MODEL` | tool wrappers | Default `--model` for `antseed claude`, `antseed codex` and `antseed opencode` |
| `ANTSEED_SELLER_INPUT_USD_PER_MILLION` | seller | Overrides every provider's default input price, USD per million tokens |
| `ANTSEED_SELLER_OUTPUT_USD_PER_MILLION` | seller | Overrides every provider's default output price, USD per million tokens |
| `ANTSEED_DEFAULT_DEPOSIT_USDC` | seller | Read by `seller start` but currently has no effect: the node does not use the value |
| `ANTSEED_SETTLEMENT_IDLE_MS` | seller | Idle time before the seller settles a channel, in milliseconds (default 600000) |
| `ANTSEED_MAX_UPLOAD_BODY_BYTES` | seller | Largest accepted request body; overrides `seller.maxUploadBodyBytes` |
| `ANTSEED_VERIFIER_SDKS` | seller | Comma-separated verifier SDK ids the seller supports, first is the default (same as `seller start --verifiers`) |
| `ANTSEED_VERIFIER_*`, `ANTSEED_TEE_PEER_ID` | TEE seller | TEE attestation settings. See [TEE provider](/docs/provide/tee) and [Verify TEE](/docs/verify-tee) |
| `ANTSEED_METRICS_ROLE`, `ANTSEED_METRICS_HOST`, `ANTSEED_METRICS_PORT`, `ANTSEED_METRICS_PATH`, `ANTSEED_METRICS_INSTANCE` | metrics | Defaults for the matching `antseed metrics serve` flags. See [Metrics](/docs/provide/metrics) |

Upstream provider credentials (for example `OPENAI_API_KEY`) are read by provider plugins; see [Provider configuration](/docs/provide/config).
