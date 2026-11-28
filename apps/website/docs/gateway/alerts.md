---
title: Alerts
slug: /gateway/alerts
sidebar_label: Alerts
description: Get a webhook, Telegram message or email when a workspace runs low on credits, a spend limit is near or reached, or spend tracking stops, and automate top-ups from a webhook.
---

# Alerts

Alerts tell you about a problem before your requests start failing: a workspace running low on credits, a spend limit that is nearly used up, or the gateway losing track of spend. Each workspace sets up its own alerts under **Alerts**. The page is open to workspace admins and organization admins.

## What you can be alerted about

| Alert | When | Resolves with |
| --- | --- | --- |
| Credits low (`balance.low`) | The credits the workspace wallet can spend drop below your threshold. The gateway checks every few minutes. | Credits topped up (`balance.ok`) once they are back above it. |
| Out of credits (`balance.empty`) | The buyer refused a request because the wallet has too few credits. This alert works without a threshold. | Credits topped up (`balance.ok`). |
| Spend limit near (`limit.near`) | A key, member or workspace spend limit reaches your warning percent for its period. | The next period, a raised limit or a removed key. No recovery alert is sent. |
| Spend limit reached (`limit.reached`) | A spend limit is used up, so its requests are refused. | The next period, a raised limit or a removed key. No recovery alert is sent. |
| Spend tracking down (`spend_tracking.down`) | For a few minutes the gateway cannot read spend from its buyer, so keys with a spend limit are refused. | Spend tracking recovered (`spend_tracking.ok`). |

Each alert goes out once when its condition starts. Credits and spend tracking alerts get one recovery when the condition ends; spend limit alerts end quietly. To get reminders, set **Repeat an open alert**; the alert is then sent again on that schedule until it resolves.

## Thresholds

- **Low credits below (USD)**: the credits balance that triggers a low-credits alert. Leave it empty to turn the alert off.
- **Top up to (USD)**: the balance you want after a top-up. Alerts include the difference as `suggested_topup_usd`, so a webhook knows how much to send.
- **Warn at % of a spend limit**: for example `80`. Leave it empty to get alerts only when a limit is reached.

## Destinations

Add as many destinations as you need, up to 20 per workspace. For each one, choose which alerts it gets: **Credits**, **Spend limits** and **Spend tracking**. Use **Send a test alert** in a destination's menu to check that it works. **Recent deliveries** lists every alert sent, including retries. A failed delivery is retried three times over about 12 minutes. A retry is dropped once its condition ends, once a newer alert or recovery for it is sent, or once the destination no longer takes that alert, so an old alert never arrives after a newer one.

### Webhook

The gateway sends each alert as a JSON `POST`:

```json
{
  "id": "evt_…",
  "type": "balance.low",
  "severity": "warning",
  "created_at": "2026-11-26T09:00:00.000Z",
  "workspace": { "id": "ws_default", "name": "Default" },
  "title": "Default: credits are low",
  "message": "$3.20 of credits left, below the alert threshold of $10.00. …",
  "data": {
    "wallet_address": "0x…",
    "available_usd": "3.200000",
    "wallet_usd": "0.000000",
    "threshold_usd": "10.000000",
    "topup_target_usd": "50.000000",
    "suggested_topup_usd": "46.800000",
    "console_url": "https://gateway.example.com/console/wallet"
  }
}
```

The headers say which alert was sent (`x-antseed-event`) and identify the delivery (`x-antseed-delivery`, the same as `id`; a retry keeps it, so you can skip duplicates). Any 2xx answer counts as delivered. Redirects are not followed.

Every delivery is signed. When you add a webhook, the console shows its signing secret once. Use **New signing secret** to replace it. The `x-antseed-signature` header has the form `t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` keyed with the secret. Check the signature, and that `t` is recent, before you act on an alert:

```js
const [t, v1] = header.split(',').map((part) => part.split('=')[1])
const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(`${t}.${rawBody}`).digest('hex')
const valid = crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300
```

**Automatic top-ups.** Point a webhook at a script you run. On `balance.low` or `balance.empty`, the script sends `suggested_topup_usd` in USDC on Base to `wallet_address`, from your treasury wallet or an exchange account. With automatic sweeping on (the default), USDC that reaches the workspace wallet becomes credits on its own (see [Funding](/docs/gateway/funding)). The gateway never moves funds itself. The script decides what to send, so cap what it can spend.

The webhook URL is never shown in full after it is saved, because URLs often carry a token. Webhooks may point at a private or loopback address, such as a script on the same host. Link-local and cloud metadata addresses are refused.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Add the bot to the chat, group or channel that should get alerts.
3. Add a Telegram destination with the token and the chat id (a number such as `-1001234567890`, or a public `@channel` name).

The token stays on the gateway. The console shows only its last characters.

### Email

Email goes through an SMTP server you configure on the gateway host. Set both variables in the gateway's environment and restart it:

| Variable | Example |
| --- | --- |
| `ANTSEED_GATEWAY_SMTP_URL` | `smtps://user:password@smtp.example.com:465` |
| `ANTSEED_GATEWAY_SMTP_FROM` | `Antseed Gateway <alerts@example.com>` |

Any SMTP provider works. Until both variables are set, the console cannot add email destinations. Each email destination takes up to 10 addresses.

## Who can see and change alerts

Workspace admins and organization admins can open **Alerts**, change thresholds, and add, edit, test or remove destinations. Every change is recorded in the audit log. Alerts link to the console only when the gateway has a public URL (`--public-url`, or a tunnel).
