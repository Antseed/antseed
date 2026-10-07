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

Extra identities are stored in `<data-dir>/buyer-identities/<name>/identity.key`. A running buyer loads them at startup, or on first use if you create one while it runs. They share the buyer's peer discovery, routing and chain connections. Sellers still see each one as a separate buyer: its own connections, payment channels and deposits. Because each identity opens its own connection, a seller accepts up to 64 identities from one buyer machine at once (10 on sellers running a release from before buyer identities).

### Keep keys out of the data dir

By default an identity's private key is stored in plain text in `identity.key` (file mode 0600), like the default identity. To keep it in a secret manager instead, create the identity with `--key-from`:

```bash
# Key injected as an env var (Vault agent, Doppler, systemd credentials, ...)
antseed buyer identity create team-a --key-from env:ANTSEED_KEY_TEAM_A

# Key mounted as a file (Kubernetes secret, cloud secret manager CSI driver, ...)
antseed buyer identity create team-b --key-from file:/run/secrets/antseed-team-b
```

The value is a hex private key, with or without `0x`. Only the reference is stored, in `identity.json`. The buyer reads the key each time it loads the identity, so the env var or file must be available to `antseed buyer start`. If it is missing, the identity is not loaded and the buyer logs why; it never falls back to another wallet. This is also how you bring an existing wallet as an identity.

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

Spend counting has two known gaps, both small:

- The buyer keeps spend reports in memory until the gateway reads them, which it does every few seconds. If the buyer crashes, spend signed since the last read is not counted, so a capped key can end up slightly under-counted.
- A seller can occasionally ask for payment without naming the request it is for. The gateway books that spend to a key only when exactly one key's requests are using that wallet with that seller; otherwise it is left uncounted. Give each key its own identity (`--new-identity`) to avoid this.

`GET /v1/models` and `POST /v1/messages/count_tokens` are answered locally for free. They never count against a limit.

## Run the gateway

The gateway forwards every key to your running buyer, so start that first (`antseed buyer start`, or the AI VPN). Then run the gateway locally, or on your LAN:

```bash
antseed gateway start                    # http://127.0.0.1:8379/v1
antseed gateway start --host 0.0.0.0     # serve other machines on your network
```

To run the buyer and gateway as always-on services on a Linux server, with HTTPS, use the installer in [Run a Gateway on a Server](/docs/guides/gateway-server).

Publicly, use a tunnel. `antseed tunnel start` runs the same gateway behind Cloudflare Tunnel or ngrok, and every active key works through it. For an existing tunnel, the `ANTSEED_TUNNEL_API_KEY` it was started with is kept as an unlimited key on the default identity. Start the tunnel without `ANTSEED_TUNNEL_API_KEY` to revoke that key.

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
    "usage": { "requests": 42, "spent_usd": "1.204310", "topped_up_usd": "5.000000", "input_tokens": 180233, "cached_input_tokens": 90112, "output_tokens": 20118 },
    "limits": {
      "daily": { "limit_usd": "2.000000", "spent_usd": "0.410000", "remaining_usd": "1.590000" },
      "monthly": { "limit_usd": null, "spent_usd": "1.204310", "remaining_usd": null },
      "total": { "limit_usd": "100.000000", "spent_usd": "1.204310", "remaining_usd": "98.795690" }
    }
  }
}
```

Every other route behaves as described in [Using the API](/docs/guides/using-the-api), with the key sent as `Authorization: Bearer <key>`.

## Top up a key with x402

Key holders can fund their own key with an [x402](https://github.com/coinbase/x402) payment. The USDC goes straight to the key's buyer wallet, and the running buyer deposits it into that identity's credits on its next check, usually within a minute. You decide which keys accept top-ups. Top-ups are off by default and only possible for keys with their own identity (`--identity` or `--new-identity`):

```bash
antseed gateway key create --label "Alice" --new-identity --allow-topup
antseed gateway key topup <id> on     # or off; applies immediately
```

Keys paid from your `default` wallet return `403 topup_not_available`, and keys without top-ups enabled return `403 topup_not_allowed`. `GET /v1/key` reports `topup_enabled` so clients can check first.

Turn top-ups on for the gateway by choosing an x402 facilitator that settles the `exact` scheme on Base. The facilitator is your choice; the paying client never sees it.

| Facilitator | Flag value | Credentials |
|---|---|---|
| Coinbase CDP | `cdp` | `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (a CDP secret API key; each call is signed with it) |
| PayAI | `payai` | None for its free allowance |
| Any other x402 facilitator | its base URL | Optional static token in `ANTSEED_X402_FACILITATOR_AUTHORIZATION` |

```bash
export CDP_API_KEY_ID="…"
export CDP_API_KEY_SECRET="…"
antseed gateway start --x402-facilitator cdp

# or, for a tunnel:
ANTSEED_X402_FACILITATOR_URL=cdp antseed tunnel start --provider cloudflare
```

`antseed gateway start` also accepts `--topup-min-usd` (default 2) and `--topup-max-usd` (default 500).

The flow is standard x402 v2 over HTTP, so x402 client libraries handle it automatically:

1. `POST /v1/key/topup` with `{"amount_usd": "5"}` and the key as a bearer token.
2. The gateway answers `402` with a `PAYMENT-REQUIRED` header. It asks for USDC on Base (`eip155:8453`) through an EIP-3009 transfer, paid to the key's buyer wallet.
3. The client repeats the request with a signed `PAYMENT-SIGNATURE` header.
4. The gateway checks the amount, payee, validity window and signature. The facilitator then verifies the payment and settles it on-chain.
5. The answer is `200` with a `PAYMENT-RESPONSE` header and the transaction hash. The top-up is recorded on the key and shows as `topped_up_usd` in `GET /v1/key`.

Top-ups add funds to the wallet. They don't change the key's spend limits. A first deposit into a new wallet must be at least 1 USDC after the relay fee, and anything above the wallet's credit limit stays in the wallet until there is room.

## Where state lives

- `<data-dir>/gateway/gateway.db`: hashed keys, the request log and the per-key ledger (SQLite).
- `<data-dir>/buyer-identities/<name>/identity.key`: each extra identity's wallet, or `identity.json` pointing at its key in your secret manager.

Back up the identity directories, or the secrets they point at. Each wallet can hold USDC credits.
