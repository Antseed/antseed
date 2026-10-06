---
sidebar_position: 3
slug: /guides/gateway-api-keys
title: Shared Gateway API Keys
description: Give teammates, customers or friends their own Antseed API keys with per-key spend limits and usage, and let one buyer pay from several wallets.
---

# Shared Gateway API Keys

The Antseed CLI can serve one buyer API to many people. Each person or app gets their own API key. Every key has its own usage history, optional spend limits, and a buyer identity (wallet) that pays sellers for its requests. All keys run through a single `antseed buyer start`, however many wallets they use.

Use it to:

- Share one funded buyer across a team, and cap what each member can spend.
- Give a friend or customer a key with a dedicated wallet, so their spending stays separate from yours.
- See requests, tokens and USDC spent per key.

Keys work with the local gateway (`antseed gateway start`) and with [public HTTPS tunnels](/docs/guides/public-tunnels) (`antseed tunnel start`).

## Buyer identities

A buyer identity is a wallet the buyer can pay from. Every buyer has the `default` identity, the wallet in your `--data-dir`. You can add more:

```bash
antseed buyer identity create team-a
antseed buyer identity list --balances
```

Extra identities are stored in `<data-dir>/buyer-identities/<name>/identity.key`. A running buyer loads them at startup, or on first use if you create one while it runs. They share the buyer's peer discovery, routing and chain connections. Sellers still see each one as a separate buyer: its own connections, payment channels and deposits.

To fund an identity, send USDC on Base to its wallet address. While the buyer runs, incoming USDC is swept into that identity's credits automatically. To show the address and a QR code:

```bash
antseed --data-dir ~/.antseed/buyer-identities/team-a buyer deposit --no-watch
```

Any local client can pay as an identity by sending a header to the buyer:

```http
x-antseed-buyer-identity: team-a
```

Without the header, requests use `default`. The buyer strips the header before forwarding the request to a seller. `antseed buyer identity remove <name>` stops using an identity and moves its key to `buyer-identities/.archived/` instead of deleting it, since the wallet may still hold credits.

## Create keys

```bash
# Unlimited key on your default identity
antseed gateway key create --label "My laptop"

# Key with its own new wallet and spend caps
antseed gateway key create --label "Alice" --new-identity \
  --daily-limit 2 --monthly-limit 20 --total-limit 100 --expires-in-days 30

# Key paid by an existing identity
antseed gateway key create --label "Bob" --identity team-a --monthly-limit 10
```

The secret (`antseed_…`) is printed once. Only a hash of it is stored.

Manage keys with:

```bash
antseed gateway key list            # active keys with spend today / this month / total
antseed gateway key show <id>       # requests, tokens and spend for one key
antseed gateway key limits <id> --daily-limit 5 --total-limit none
antseed gateway key revoke <id>
```

Key and limit changes apply immediately, even while the gateway is running.

## Spend limits

Limits are in USD and count the USDC actually paid to sellers for a key's requests:

| Option | Period |
|---|---|
| `--daily-limit` | UTC calendar day |
| `--monthly-limit` | UTC calendar month |
| `--total-limit` | Lifetime of the key |

The exact cost of a request is only known once the seller is paid, which can happen after the response ends. While a request is in flight, the gateway reserves your buyer's `payments.maxPerRequestUsdc` against the key's limits, so a burst of parallel requests can't all slip under a cap. A key can still go over a limit by roughly one request.

When a limit is reached, the gateway answers `402 Payment Required`:

```json
{
  "error": {
    "type": "insufficient_quota",
    "code": "spend_limit_reached",
    "message": "This API key reached its daily spend limit of $2.00.",
    "limit": { "period": "daily", "limit_usd": "2.000000", "spent_usd": "2.104512", "resets_at": "2026-10-07T00:00:00.000Z" }
  }
}
```

A key with limits fails closed. If its buyer isn't reachable or doesn't report spend, the gateway answers `503` with `spend_tracking_unavailable` instead of serving requests it can't count. Keys without limits are not affected.

`GET /v1/models` and `POST /v1/messages/count_tokens` are answered locally for free. They never count against a limit.

## Run the gateway

The gateway forwards every key to your running buyer, so start that first (`antseed buyer start`, or the AI VPN). Then run the gateway locally, or on your LAN:

```bash
antseed gateway start                    # http://127.0.0.1:8379/v1
antseed gateway start --host 0.0.0.0     # serve other machines on your network
```

Publicly, use a tunnel. `antseed tunnel start` runs the same gateway behind Cloudflare Tunnel or ngrok, and every active key works through it. For an existing tunnel, the `ANTSEED_TUNNEL_API_KEY` it was started with is kept as an unlimited key on the default identity.

If your buyer doesn't listen on `buyer.proxyPort`, point the gateway at it with `--buyer-port`. The gateway sets `x-antseed-buyer-identity` from the key itself; a value sent by the client is ignored.

## Key holders: check usage

Anyone with a key can read its own usage and remaining limits:

```bash
curl "$ANTSEED_BASE_URL/key" -H "Authorization: Bearer $ANTSEED_API_KEY"
```

```json
{
  "data": {
    "id": "key_8852648843e5",
    "label": "Alice",
    "expires_at": "2026-11-04T17:25:15.251Z",
    "buyer_address": "0x91E1…e474",
    "usage": { "requests": 42, "spent_usd": "1.204310", "input_tokens": 180233, "cached_input_tokens": 90112, "output_tokens": 20118 },
    "limits": {
      "daily": { "limit_usd": "2.000000", "spent_usd": "0.410000", "remaining_usd": "1.590000" },
      "monthly": { "limit_usd": null, "spent_usd": "1.204310", "remaining_usd": null },
      "total": { "limit_usd": "100.000000", "spent_usd": "1.204310", "remaining_usd": "98.795690" }
    }
  }
}
```

Every other route behaves as described in [Using the API](/docs/guides/using-the-api), with the key sent as `Authorization: Bearer <key>`.

## Where state lives

- `<data-dir>/gateway/gateway.db`: hashed keys, the request log and the per-key ledger (SQLite).
- `<data-dir>/buyer-identities/<name>/identity.key`: each extra identity's wallet.

Back up the identity directories. Each one holds a wallet that can hold USDC credits.
