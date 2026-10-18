---
title: Budgets and spend limits
slug: /gateway/budgets
description: Cap what API keys, members and workspaces can spend through an Antseed gateway, and what happens when a cap is reached.
---

# Budgets and spend limits

Budgets cap the USDC actually paid to providers. You can set them on three levels, each per UTC day, UTC week (starting Monday), UTC calendar month and lifetime:

| Level | Where to set it | Caps |
|---|---|---|
| Workspace | **Workspaces** → edit a workspace → **Workspace budgets (USD)** (organization admins) | Everything every key in the workspace spends |
| Member | **Members** → edit a member → **Spend limits across their keys (USD)** | Everything the keys a member owns spend, together |
| API key | **Keys** → create or edit a key | That key alone |

Leave a field blank for no limit.

## How limits stack

A request runs only if every level has room: the key, the member who owns it, and its workspace. The first level that is out of room refuses it.

A key has two layers of limits:

- **Workspace admin restrictions**, set by workspace admins.
- **Your restrictions as the key owner**, set by the member who owns the key.

The lower of the two applies. An owner can only tighten their own key; a higher limit than the admins' has no effect.

Member spend counts every request made with that member's keys, including keys they have since revoked. A member cannot get a fresh budget by creating a new key.

## When a limit is reached

The gateway answers `402 Payment Required` with the code `spend_limit_reached`. `limit.level` says which level ran out (`key`, `member` or `workspace`), `limit.period` which period, and `limit.resets_at` when it resets (`null` for a lifetime limit):

```json
{
  "error": {
    "type": "insufficient_quota",
    "code": "spend_limit_reached",
    "message": "This API key's workspace reached its weekly spend limit of $50.00.",
    "limit": {
      "level": "workspace",
      "period": "weekly",
      "limit_usd": "50.000000",
      "spent_usd": "50.112000",
      "remaining_usd": "0.000000",
      "held_usd": "0.000000",
      "resets_at": "2026-10-19T00:00:00.000Z"
    }
  }
}
```

`limit.remaining_usd` is what is left of the limit and `limit.held_usd` what requests still running (or not yet charged) may use. Each running request holds up to the most one request may cost, so a small limit can refuse a request before it is fully spent. The message then says how much is left.

Refused requests are not added to the request log.

A key holder can check their key's spend and remaining limits with `GET /v1/key`. See [Calling the API](/docs/gateway/api#check-a-keys-usage-and-limits).

The console's **Overview** warns when a workspace budget is 80% used or reached.

## How spend is counted

The exact cost of a request is only known once the provider is paid, which can happen after the response ends. While a request is in flight, the gateway holds the buyer's `payments.maxPerRequestUsdc` against every capped level, so a burst of parallel requests cannot all slip under a cap. A key can still go over a limit by roughly one request.

`GET /v1/models` and `POST /v1/messages/count_tokens` are answered for free and never count against a limit.

### Videos

A video is charged once, when its file is delivered, but its price is known when it starts, so it counts against the limits from start to charge:

- When a video is created, the gateway tells the buyer how much is left under the key's limits (the lowest of the key's, its owner's and its workspace's), and holds that much while the buyer prices the video. The most one video may hold is the buyer's `payments.maxVideoRequestUsdc` ($5 by default). A video that costs more than what is left is refused with `422` before it starts.
- Once the video is accepted, it holds its price until it is charged, the job fails, or 30 days pass. Its status polls and its download are always let through, since its price is already held.
- Only the key that created a video can poll or download it. Other keys get `404 video_route_not_found`.
- Other requests that only miss the limit because a video is still being priced get `429 video_pricing_in_progress`, which can be retried after a few seconds.

### Fail closed

A key with limits at any level fails closed. If the buyer is not reachable or does not report spend to the gateway, or the gateway cannot save the videos it holds, the gateway answers `503` with `spend_tracking_unavailable` instead of serving requests it cannot count. Videos of such a key are only started through a buyer that checks their price against the limit; an older buyer gets `503 buyer_upgrade_required`. Keys with no limits at any level are not affected.

The most common cause is a gateway and a buyer that use different data directories, so the buyer rejects the gateway's control secret. Run both with the same `--data-dir`.

### Known gaps

Two small gaps can make spend slightly under-counted:

- The buyer keeps spend reports in memory until the gateway reads them, every couple of seconds. If the buyer crashes in between, that spend is not counted.
- A provider can occasionally ask for payment without naming the request it is for. The gateway books that spend to a key only when exactly one key's requests are using that wallet with that provider; otherwise it is left uncounted. Giving each key its own wallet avoids this. See [Buyer identities](/docs/gateway/api#buyer-identities).

## From the command line

```bash
# Key: created with limits, or changed later
antseed gateway key create --label "Alice" --daily-limit 2 --monthly-limit 20
antseed gateway key limits <keyId> --weekly-limit 10 --total-limit none

# The key owner's own layer
antseed gateway key update <keyId> --owner-daily-limit 1

# Member and workspace
antseed gateway member update alice@example.com --monthly-limit 100
antseed gateway workspace update Research --weekly-limit 150
```

`none` removes a limit. See [Commands](/docs/commands) for every option.

Next: [Routing policies and presets](/docs/gateway/routing).
