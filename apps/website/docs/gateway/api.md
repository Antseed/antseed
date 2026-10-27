---
title: Calling the API
slug: /gateway/api
description: Create gateway API keys and call Antseed models from curl, the OpenAI and Anthropic SDKs and coding tools, check a key's usage and top it up.
---

# Calling the API

Your gateway serves an OpenAI- and Anthropic-compatible API at `/v1`. Every request carries an API key, which decides who pays, which budgets and routing policies apply, and where the request is logged.

## Create an API key

1. In the console, open **Keys** and click **Create key**.
2. Enter a **Name**. Optionally set budgets, an **Expires** date, and (for keys with their own wallet) **Allow top-ups**.
3. Click **Create key** and copy the secret (`antseed_…`). It is shown once; the gateway stores only a hash of it.

Every member can create keys in the workspaces they belong to, up to the number an admin allows them. A key spends from its workspace's wallet. Use the row menu to **Edit**, **Rotate secret** (a new secret, same key, limits and usage) or **Revoke**. Changes apply immediately, even while the gateway runs.

On the gateway host you can do the same from the command line:

```bash
antseed gateway key create --label "CI" --workspace Research --weekly-limit 25
antseed gateway key list
antseed gateway key rotate <keyId>
antseed gateway key revoke <keyId>
```

See [Commands](/docs/commands) for every option.

## Base URL and key

| Setting | Value |
|---|---|
| Base URL | `https://gateway.example.com/v1` on a server, `http://localhost:8379/v1` for a local gateway. The console's top bar shows yours. |
| API key | Sent as `Authorization: Bearer $ANTSEED_API_KEY`. |
| Model | `<peerId>@deepseek-v4-flash` pinned to one provider, `deepseek-v4-flash` for automatic routing, or `<routerPeerId>@<routerServiceId>` to let a routing service choose. See [Models and providers](/docs/gateway/models). |

```bash
export ANTSEED_API_KEY="antseed_…"

curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

The same keys work through a [tunnel endpoint](/docs/tunnels).

### Use a routing service

Name a routing service as the model and it picks the model and provider for each request, among the ones the key's routing policy allows. Add optional router settings in a `routing` object, in the terms of the router's protocol. For an `irp-suggest` router, `cost_quality_tradeoff` goes from `0` (best quality) to `10` (cheapest); without it the router uses its default, `5`:

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<routerPeerId>@<routerServiceId>","messages":[{"role":"user","content":"Hello"}],"routing":{"cost_quality_tradeoff":7}}'
```

With the OpenAI SDK, pass `routing` as `extra_body={"routing": {"cost_quality_tradeoff": 7}}`. `GET /v1/models?type=router` lists the routers the key may use, with the `model` value, `protocol` and accepted `options` for each.

A router counts as a model in the key's policy: a key limited to certain models needs the router's service id in its allow list. Its peer must also pass the policy's provider rules (allow and block lists, minimum trust and reputation, TEE); token and image price caps do not apply to a router, which charges per ranking. A router that is offline answers like an offline provider: `502`, peer not reachable. The router's fee and the inference are both charged to the key. See [Use a routing service](/docs/api/routing#use-a-routing-service).

## Supported routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/models` | Models on the network. With a key limited to certain models, only those. Free. |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic-compatible messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible token count. Free. |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/images/edits` | Image editing |
| `POST` | `/api/v1/video/queue`, `/api/v1/video/retrieve` | Venice-format video jobs |
| `POST` | `/fal/v1/video/queue`, `/fal/v1/video/retrieve` | fal-format video jobs, with the fal endpoint id as `model` |
| `GET` | `/v1/key` | Usage and limits of the calling key |
| `POST` | `/v1/key/topup` | Fund the calling key's wallet with x402 |

Other paths return `404`. A missing, unknown, revoked or expired key returns `401`. For other errors, see [Troubleshooting](/docs/gateway/troubleshooting).

Video routes sit at the gateway's root, not under `/v1`. Queue a job, then poll retrieve with its `queue_id` (fal: `request_id`) until the answer is `video/mp4` instead of a JSON status:

```bash
curl https://gateway.example.com/fal/v1/video/queue \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@<fal-video-endpoint>","prompt":"A tiny ant carrying a seed","duration":"5"}'

curl https://gateway.example.com/fal/v1/video/retrieve \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@<fal-video-endpoint>","request_id":"<request_id>"}' -o result.out
```

Retrieve goes to the seller that accepted the job. The video is paid once, on the retrieve that delivers the MP4, and that spend counts against the key's limits. See [Video jobs](/docs/api#video-jobs) for the request fields. Video edits send the source video as `video_url` (inline, up to 64 MiB per request, or a public `https` URL) with `duration` set to its length in whole seconds; see [Edit a video](/docs/api#edit-a-video).

To attribute requests to your own end users, send the OpenAI-style `user` field in the body, or an `x-antseed-end-user` header. The gateway records it in the request log and does not forward the header.

A response the buyer answered includes `x-antseed-gateway-tag`. That value is the request's tag in the [management API](/docs/gateway/management-api) (`GET /console/api/requests/:tag`). It is not the buyer's `x-antseed-request-id`, which the gateway still forwards unchanged.

## SDKs

**OpenAI SDK** (Python):

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://gateway.example.com/v1", api_key=os.environ["ANTSEED_API_KEY"])

reply = client.chat.completions.create(
    model="<peerId>@deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)
```

**OpenAI SDK** (JavaScript):

```javascript
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://gateway.example.com/v1',
  apiKey: process.env.ANTSEED_API_KEY,
})

const reply = await client.chat.completions.create({
  model: '<peerId>@deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello' }],
})
console.log(reply.choices[0].message.content)
```

**Anthropic SDK** (JavaScript). The base URL has no `/v1`:

```javascript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: 'https://gateway.example.com',
  authToken: process.env.ANTSEED_API_KEY, // sent as Authorization: Bearer
})

const reply = await client.messages.create({
  model: '<peerId>@deepseek-v4-flash',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
```

## Coding tools

A provider's panel on the console's **Providers** page generates these for any of its models.

**Cursor and other OpenAI-compatible tools**: paste three values into their model settings.

```text
Base URL:  https://gateway.example.com/v1
API key:   $ANTSEED_API_KEY  (your Antseed key)
Model:     <peerId>@deepseek-v4-flash
```

**Claude Code**: point it at the gateway. The gateway translates its requests for models that speak another API.

```bash
export ANTHROPIC_BASE_URL="https://gateway.example.com"
export ANTHROPIC_AUTH_TOKEN="$ANTSEED_API_KEY"
export ANTHROPIC_MODEL="<peerId>@qwen3-coder-480b"
claude
```

**Codex**: add a provider to `~/.codex/config.toml`. Use a [preset](/docs/gateway/routing#presets) as the model: with a raw model name, Codex can switch to a tool format some providers drop.

```toml
# ~/.codex/config.toml
model = "@preset/coder"
model_provider = "antseed"

[model_providers.antseed]
name = "Antseed gateway"
base_url = "https://gateway.example.com/v1"
env_key = "ANTSEED_API_KEY"
wire_api = "responses"
```

To launch coding tools against Antseed with one click instead, use the [desktop app](/docs/desktop).

## Check a key's usage and limits

Anyone with a key can read its usage and remaining limits:

```bash
curl https://gateway.example.com/v1/key -H "Authorization: Bearer $ANTSEED_API_KEY"
```

```json
{
  "data": {
    "id": "key_…",
    "label": "Alice",
    "created_at": "2026-10-01T09:12:44.000Z",
    "expires_at": null,
    "topup_enabled": false,
    "buyer_address": "0x…",
    "usage": { "requests": 42, "spent_usd": "1.204310", "topped_up_usd": "0.000000", "input_tokens": 180233, "cached_input_tokens": 90112, "output_tokens": 20118 },
    "limits": {
      "daily": { "limit_usd": "2.000000", "spent_usd": "0.410000", "remaining_usd": "1.590000" },
      "weekly": { "limit_usd": null, "spent_usd": "1.204310", "remaining_usd": null },
      "monthly": { "limit_usd": null, "spent_usd": "1.204310", "remaining_usd": null },
      "total": { "limit_usd": "100.000000", "spent_usd": "1.204310", "remaining_usd": "98.795690" }
    }
  }
}
```

`limits` are the key's own limits (the lower of the admins' and the owner's). Member and workspace budgets can stop a request first; see [Budgets and spend limits](/docs/gateway/budgets).

A key holder can also paste their key on the console's sign-in page for a read-only view of its usage. See [Sign-in](/docs/gateway/sign-in).

## Top up a key with x402

Key holders can fund their own key with an [x402](https://github.com/coinbase/x402) payment in USDC on Base. The USDC goes to the key's wallet, and the running buyer deposits it into that wallet's credits, usually within a minute. Top-ups add funds; they do not change the key's limits.

Top-ups are off by default and only possible for keys with their own wallet. Keys paid from the `default` wallet return `403 topup_not_available`, and keys without top-ups enabled return `403 topup_not_allowed`. `GET /v1/key` reports `topup_enabled`.

To turn them on, the gateway needs an x402 facilitator that settles payments on Base. Setting one up is done on the gateway host:

| Facilitator | `--x402-facilitator` | Credentials |
|---|---|---|
| Coinbase CDP | `cdp` | `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the environment |
| PayAI | `payai` | None for its free allowance |
| Any other x402 facilitator | its base URL | Optional token in `ANTSEED_X402_FACILITATOR_AUTHORIZATION` |

```bash
export CDP_API_KEY_ID="…"
export CDP_API_KEY_SECRET="…"
antseed gateway start --x402-facilitator cdp
```

`--topup-min-usd` (default 2) and `--topup-max-usd` (default 500) bound each top-up. Then enable top-ups per key: **Allow top-ups** in the key's form, or `antseed gateway key topup <keyId> on`.

The flow is standard x402 v2, so x402 client libraries handle it:

1. `POST /v1/key/topup` with `{"amount_usd": "5"}` and the key as a bearer token.
2. The gateway answers `402` with a `PAYMENT-REQUIRED` header asking for USDC on Base (`eip155:8453`), paid to the key's wallet.
3. The client repeats the request with a signed `PAYMENT-SIGNATURE` header.
4. The gateway checks the payment and the facilitator settles it on-chain.
5. The answer is `200` with a `PAYMENT-RESPONSE` header. The top-up shows as `topped_up_usd` in `GET /v1/key`.

## Advanced: buyer identities {#buyer-identities}

These options are only available from the command line on the gateway host.

A buyer identity is a wallet the buyer can pay from. Each workspace pays from one, and the `default` identity is the wallet in your data directory. You can give a single key its own identity, so its spending stays separate from everyone else's:

```bash
# A key with a new wallet of its own
antseed gateway key create --label "Alice" --new-identity --allow-topup

# A key paid by an identity you created earlier
antseed buyer identity create team-a
antseed gateway key create --label "Bob" --identity team-a
```

A key made with `--identity` or `--new-identity` lands in the workspace that pays with that identity, which is created if there is none. List identities and their balances with `antseed buyer identity list --balances`.

On a server installed with an encrypted wallet passphrase, run these as `sudo antseed …` so the CLI can read the passphrase. See [Wallet keys](/docs/gateway/wallet-keys).

### Keep a wallet key in a secret manager

By default an identity's private key is stored in `<data-dir>/buyer-identities/<name>/identity.key`. To keep it in a secret manager, create the identity with `--key-from`:

```bash
antseed buyer identity create team-a --key-from env:ANTSEED_KEY_TEAM_A
antseed buyer identity create team-b --key-from file:/run/secrets/antseed-team-b
```

The value is a hex private key. Only the reference is stored. The buyer reads the key each time it loads the identity, so the variable or file must be available to it; if it is missing, the identity is not loaded and the buyer never falls back to another wallet. This is also how you bring an existing wallet.

### The buyer identity header

The gateway tells the buyer which identity pays with the `x-antseed-buyer-identity` header, set from the key. A value sent by a client is ignored. Talking to the buyer directly, once a gateway control secret exists the buyer accepts an identity other than `default` only together with that secret in `x-antseed-gateway-auth`, and otherwise answers `401 gateway_auth_required`. Clients should pay as an identity through a gateway API key instead.

`antseed buyer identity remove <name>` stops using an identity and archives its key instead of deleting it, since the wallet may still hold credits.

## Where state lives

- `<data-dir>/gateway/gateway.db`: hashed keys, the request log and spend (SQLite).
- `<data-dir>/buyer-identities/<name>/`: each extra identity's wallet key, or a reference to it.

Back up the identity directories, or the secrets they point to: each wallet can hold credits.

Next: [Logs, usage and audit](/docs/gateway/activity).
