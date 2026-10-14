---
title: Metrics
slug: /provide/metrics
description: Export seller and buyer requests, tokens, channels and USDC flow to Prometheus with antseed metrics serve.
---

# Metrics

Antseed includes a Prometheus-compatible metrics exporter for sellers and buyers:

```bash
antseed metrics serve
```

The exporter reads local runtime state, payment channel ledgers and metering stores, and exposes them in the Prometheus text format.

The exporter covers a buyer or seller node as a whole. It does not break usage down by gateway workspace, API key or member; for that, use the Gateway Console's activity and usage views, described in [Activity](/docs/gateway/activity).

## Start the exporter

```bash
# Auto-detect role where possible
antseed --config ~/.antseed/config.json --data-dir ~/.antseed metrics serve

# Seller metrics
antseed --config ~/.antseed/config.json --data-dir ~/.antseed \
  metrics serve --role seller --host 0.0.0.0 --port 9108 --instance seller

# Buyer metrics
antseed --config ~/.antseed/config.json --data-dir ~/.antseed \
  metrics serve --role buyer --host 127.0.0.1 --port 9108 --instance buyer
```

Default endpoints:

```text
/metrics
/healthz
/readyz
```

`/metrics` is for Prometheus-compatible scraping. `/healthz` and `/readyz` are for liveness/readiness checks.

## Options

| Option | Default | Description |
|---|---:|---|
| `--role <role>` | `auto` | Metrics role: `buyer`, `seller`, `both`, or `auto`. |
| `--host <host>` | `127.0.0.1` | Listen host. Use `0.0.0.0` when another system needs to scrape over the network. |
| `--port <port>` | `9108` | Listen port. |
| `--path <path>` | `/metrics` | Metrics path. |
| `--instance <name>` | `$HOSTNAME`, else `antseed` | Value for the `instance` label. |
| `--include-chain` | disabled | Include chain balance metrics. This can add RPC latency. |

Environment variables set the same defaults:

```bash
ANTSEED_METRICS_ROLE=seller
ANTSEED_METRICS_HOST=0.0.0.0
ANTSEED_METRICS_PORT=9108
ANTSEED_METRICS_PATH=/metrics
ANTSEED_METRICS_INSTANCE=seller
```

## Common metrics

| Metric | Description |
|---|---|
| `antseed_metrics_scrape_timestamp_seconds` | Unix timestamp of the metrics scrape. |
| `antseed_daemon_up` | Whether local daemon state exists and is readable. |
| `antseed_daemon_info` | Static daemon info such as state, peer id, and ports. |
| `antseed_daemon_active_channels` | Active channel count from daemon state. |

## Buyer metrics

Buyer metrics include:

- payment channel counts by status
- all-time spend
- spend since UTC day start
- active authorized USDC
- request totals
- token totals
- per-seller-peer spend, requests, tokens, and channels

Common metric names:

```text
antseed_buyer_channels_total
antseed_buyer_spend_usdc_total
antseed_buyer_spend_today_usdc
antseed_buyer_active_authorized_usdc
antseed_buyer_requests_total
antseed_buyer_tokens_total
antseed_buyer_peer_spend_usdc_total
antseed_buyer_peer_requests_total
antseed_buyer_peer_tokens_total
antseed_buyer_peer_channels_total
```

Optional chain metrics are emitted only with `--include-chain`:

```text
antseed_buyer_deposits_available_usdc
antseed_buyer_deposits_reserved_usdc
antseed_wallet_usdc
antseed_chain_scrape_error
```

## Seller metrics

Seller metrics include:

- payment channel counts by status
- delivered, settled, and authorized USDC totals
- delivered USDC since UTC day start
- request totals
- token totals
- metering session totals
- metering token/request totals
- usage receipt revenue totals

Common metric names:

```text
antseed_seller_channels_total
antseed_seller_payment_delivered_usdc_total
antseed_seller_payment_delivered_today_usdc
antseed_seller_payment_settled_usdc_total
antseed_seller_payment_authorized_usdc_total
antseed_seller_channel_requests_total
antseed_seller_channel_tokens_total
antseed_seller_metering_requests_total
antseed_seller_metering_requests_today
antseed_seller_metering_tokens_total
antseed_seller_metering_tokens_today
antseed_seller_metering_input_tokens_total
antseed_seller_metering_output_tokens_total
antseed_seller_sessions_total
antseed_seller_sessions_today
antseed_seller_receipt_revenue_usd_total
antseed_seller_receipt_revenue_today_usd
```

Seller payment metrics (`antseed_seller_payment_*`) come from payment channels and represent USDC-denominated payment flow. Seller receipt metrics (`antseed_seller_receipt_revenue_*`) come from metering/usage receipts and represent metered usage accounting.

## Read-only behavior

The exporter is designed to be safe to scrape:

- It never creates an identity.
- It reads `ANTSEED_IDENTITY_HEX` if set, otherwise the existing `identity.key` in `--data-dir`.
- It never creates payment channel databases. Missing databases produce empty or absent metrics.

If `identity.key` is encrypted, give the exporter the same `ANTSEED_PASSPHRASE` or `ANTSEED_PASSPHRASE_FILE` as the node. Without it, the buyer and seller collectors fail and report `antseed_buyer_scrape_error` and `antseed_seller_scrape_error` instead of their metrics. See [Protecting wallet keys](/docs/gateway/wallet-keys).

## Operational notes

Run the exporter where it can read the same data directory as the buyer or seller process. Expose `/metrics` to your monitoring system using your normal access controls; with `--host 0.0.0.0` it is reachable by anyone who can reach the port.

`--include-chain` makes the exporter read balances over RPC on every scrape. For larger fleets, collect chain balances separately or use a dedicated RPC endpoint.
