---
title: Management API and observability
slug: /gateway/management-api
description: Script the Gateway Console through its JSON API with management tokens, and export one OpenTelemetry trace per request.
sidebar_label: Management API
---

# Management API and observability

Everything the Gateway Console does goes through its JSON API under `/console/api`. Scripts, dashboards and infrastructure tools can use the same API with a management token. This page also covers exporting request traces to your observability stack.

## Create a management token

In the console, open **Settings → Management tokens**, choose **Name**, **Scope** and **Expires after**, and create it. Or on the gateway machine:

```bash
antseed gateway admin-token create --label "reporting" --scope read
antseed gateway admin-token list
antseed gateway admin-token revoke <id>
```

| Scope | Can |
|---|---|
| `read` | `GET` requests only |
| `admin` | Everything an organization admin can do, except list, create or revoke management tokens |

Tokens look like `antseed_admin_…` and are shown once. They expire after 90 days unless you choose otherwise (`--expires-in-days`, up to 365; 30 days, 90 days or 1 year in the console). Only an owner can create a token that never expires (`--no-expiry`, or **Never** in the console). A token also stops working when the member who created it is disabled or is no longer an admin.

## Call the API

Send the token as a bearer token:

```bash
TOKEN=antseed_admin_…
BASE=https://gateway.example.com/console/api

# Spend by model since the first of this month (UTC)
curl "$BASE/usage?groupBy=model&from=$(date -u +%Y-%m-01)" \
  -H "Authorization: Bearer $TOKEN"

# The last 50 audit entries for keys
curl "$BASE/audit?action=key&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

```bash
# Create a key in a workspace with a weekly budget and an allow list of models
curl -X POST "$BASE/keys" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"label": "batch-jobs", "workspaceId": "<workspaceId>",
       "limits": {"daily": null, "weekly": "25", "monthly": null, "total": null},
       "routingPolicy": {"allowedModels": ["deepseek-v4-flash", "kimi-k2.6"], "sort": "price"}}'
```

Conventions:

- Amounts are USD as decimal strings, such as `"25"` or `"0.50"`. `null` means no limit.
- Timestamps in responses are milliseconds since the epoch. `from` and `to` query parameters accept epoch milliseconds or an ISO date such as `2026-10-01`.
- Errors are `{"error": {"code": "…", "message": "…"}}` with a matching HTTP status.
- Requests with a bearer token need no other header. (The browser console sends an extra header on state-changing requests to block cross-site requests; tokens don't need it.)

### Main routes

| Route | What it does |
|---|---|
| `GET /status` | Gateway version, public URL, buyer reachability, and how reachable the gateway is (`exposure.mode`: `local`, `lan` or `public`) |
| `GET /usage` | Totals, optionally grouped with `groupBy` (`hour`, `day`, `model`, `key`, `member`, `peer`, `workspace` or `user`; two comma-separated for a split). Filters: `from`, `to`, `workspace`, `key`, `member`, `model` |
| `GET /usage/export.csv` | The same data as CSV |
| `GET /requests`, `GET /requests/:tag` | The request log, newest first (`limit`, `before`), and one request |
| `GET /audit` | The audit log. Filters: `actor`, `action`, `limit`, `before` |
| `GET /keys`, `POST /keys`, `PATCH /keys/:id`, `POST /keys/:id/rotate`, `POST /keys/:id/revoke` | API keys. See [API keys](/docs/gateway/api) for what a key holds |
| `GET /workspaces`, `POST /workspaces`, `GET /workspaces/:id`, `PATCH /workspaces/:id`, `DELETE /workspaces/:id` | Workspaces |
| `GET /workspaces/:id/members`, `PUT /workspaces/:id/members/:memberId`, `DELETE /workspaces/:id/members/:memberId` | Workspace membership and roles |
| `GET /members`, `PATCH /members/:id`, `POST /members/:id/disable`, `POST /members/:id/enable` | Members |
| `GET /invites`, `POST /invites`, `DELETE /invites/:id` | Invites. `POST` returns the single-use link |
| `GET /routing`, `PUT /routing`, `GET /route-preview` | The gateway-wide routing policy and the route preview |
| `GET /peer-lists`, `POST /peer-lists`, `PATCH /peer-lists/:id`, `DELETE /peer-lists/:id` | Saved peer lists |
| `GET /presets`, `POST /presets`, `PATCH /presets/:id`, `DELETE /presets/:id` | Presets |
| `GET /peers`, `GET /models` | The providers and models the buyer sees |
| `GET /settings`, `PATCH /settings/buyer`, `PUT /settings/observability` | Buyer and observability settings |
| `GET /update`, `POST /update/check`, `POST /update` | The running and latest Antseed version, a fresh check, and the [one-click update](/docs/gateway/server#upgrade) (admin scope; recorded in the audit log) |
| `GET /workspaces/:id/wallet`, `GET /workspaces/:id/channels`, `GET /workspaces/:id/rewards` | A workspace's balances, payment channels and rewards |

The console's own pages are the most complete examples: every request it makes is visible in your browser's developer tools.

## Observability

Under **Settings → Observability** (or `antseed gateway settings set-observability`) you can:

- **Export traces.** Set an **OTLP/HTTP endpoint** (such as `https://otel.example.com/v1/traces`) and optional **Headers** for authentication. The gateway sends one OpenTelemetry trace per request to Grafana, Honeycomb, Datadog, Langfuse or any other OTLP/HTTP receiver.
- **Store request and response bodies** in the request log and include them in exported traces. This is off by default; bodies can contain personal data.
- **Keep the request log for** 7, 30, 90 or 365 days, or forever. Older entries are deleted.

```bash
antseed gateway settings set-observability \
  --otlp-endpoint https://otel.example.com/v1/traces \
  --otlp-header "authorization=Bearer …" \
  --retention-days 30
```

`--otlp-endpoint none` turns the export off, `--log-content on|off` toggles bodies, and `--retention-days none` keeps the log forever. Saved header values are masked in the console and in `antseed gateway settings show` (add `--reveal` to see them).

Spans come from the service `antseed-gateway` and carry:

| Attribute | Value |
|---|---|
| `http.request.method`, `url.path`, `http.response.status_code` | The request and its status |
| `gen_ai.request.model` | The requested model |
| `antseed.request.tag` | The request's id in the request log |
| `antseed.key.id`, `antseed.workspace.id`, `antseed.member.id` | Who made it |
| `antseed.end_user` | The end user, from the request's `user` field or `x-antseed-end-user` header |
| `antseed.seller.peer_id` | The seller that served it |
| `antseed.latency_ms` | Latency |
| `antseed.request.body`, `antseed.response.body` | Only when bodies are stored |

Spend, tokens and request history are also in the console's **Activity** and **Logs** pages and their CSV exports: see [Logs, usage and audit](/docs/gateway/activity).

Next: [Troubleshooting](/docs/gateway/troubleshooting).
