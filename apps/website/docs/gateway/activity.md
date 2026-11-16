---
title: Logs, usage and audit
slug: /gateway/activity
description: See spend, tokens and requests through your Antseed gateway, inspect single requests, export them, and review who changed what.
---

# Logs, usage and audit

The console records every request that reaches the buyer: its key, model, provider, status, tokens and cost. **Activity** and **Logs** show them; the **Audit log** records changes to the gateway itself.

What you see depends on your role: members see their own keys' usage, workspace admins their workspace's, and organization admins everything. Someone signed in with an API key sees only that key.

## Activity

**Activity** totals spend, requests (and how many failed), input tokens (and how many were cached) and output tokens for a time range: **24 hours**, **7 days**, **30 days** or **90 days**.

![Activity: spend, requests and tokens over time, broken down by model](/img/docs/gateway/activity.webp)

- The chart shows **Spend**, **Requests** or **Tokens** per hour, day or week depending on the range, by model, in UTC.
- **Breakdown** groups the totals by **Model**, **Key**, **Seller**, **End user**, **Member** (admins), **Workspace** (organization admins) or **Day**.
- Filter by key, or by member for admins.

The **Overview** page shows this week's spend against the workspace budgets, the balance and how long it lasts at last week's pace, and the top keys and models this month.

## Logs

**Logs** lists every request through the workspace's keys, newest first, with its model, key, provider, status, time to first token, output speed, tokens and cost. Search by model, key, end user or error, and filter by key, model, status (**Succeeded** or **Failed**) and a UTC date range.

![Logs: every request with its key, model, seller, status, latency, tokens and cost](/img/docs/gateway/logs.webp)

Click a request to open its details:

- Status, method and path, model, key, end user and provider (peer id).
- Time to first token and output speed (streamed requests only), duration, input, cached input and output tokens, and cost.
- The request's tag, which identifies it in the CLI and exports.
- For a failed request, its error code and message.
- With content logging on, the request and response bodies.

The cost column can show:

| Value | Meaning |
|---|---|
| An amount | What the buyer paid the provider |
| `Free` | Served by a free provider |
| `pending` | The buyer reports spend a moment after the response ends |
| `not recorded` | No spend was reported for this request |

Requests the gateway refuses before they reach the buyer, such as an invalid key, a disallowed model or a budget that ran out, get an error response but are not logged.

To attribute requests to your own end users, send the OpenAI-style `user` field or an `x-antseed-end-user` header. See [Calling the API](/docs/gateway/api#supported-routes).

### Request bodies and retention

Bodies are not stored by default. Organization admins can turn on content logging, and delete log entries after a number of days, under **Settings → Observability**. See [Management API and observability](/docs/gateway/management-api).

## Export

**Export CSV** on **Activity** and **Logs** downloads the current filters' data. Exports never include request or response bodies.

From the command line on the gateway host:

```bash
antseed gateway usage --group-by model --from 2026-10-01 --workspace Research
antseed gateway logs list --status error --limit 20
antseed gateway logs list --follow --key <keyId>
antseed gateway logs show <tag>
antseed gateway export --from 2026-10-01 --output october.csv
```

`antseed gateway export` writes the request log as CSV, to standard output or to the file in `--output`. With `--out` instead, it writes an encrypted bundle of the whole gateway to [move it to a server](/docs/gateway/migrate).

## Audit log

**Audit log** (organization owners and admins) records who changed what, with the time, the actor and their IP address: sign-ins and refused sign-ins, invites, members, workspaces, API keys, gateway routing, seller lists, presets, wallets and authorized-wallet changes, channel closes, settings and management tokens. Filter it by who or by kind of action, and click an entry for its details. Changes made from the CLI are recorded as `antseed CLI`.

```bash
antseed gateway audit --action key --limit 50
```

Management tokens can read it through `GET /console/api/audit`. See [Management API and observability](/docs/gateway/management-api).

Next: [Management API and observability](/docs/gateway/management-api).
