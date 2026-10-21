---
title: Models and providers
slug: /gateway/models
description: Browse the network's models and providers in the gateway console, copy peer@model ids and get ready-to-run API calls.
---

# Models and providers

The console has two pages for finding what to call: **Models** lists every model on the network, and **Providers** lists every provider (seller) your gateway can route to. Both open an item in a panel on the right with copyable model ids and a ready-to-run API call. Every member can open both pages.

## The gateway endpoint

The top bar of every console page shows the gateway's API base URL with a copy button: your public URL plus `/v1` (for example `https://gateway.example.com/v1`), or the address you opened the console on. Point your clients and SDKs at it. See [Calling the API](/docs/gateway/api).

## Automatic and pinned routing

A request names its model in one of two ways:

| Model id | Routing |
|---|---|
| `deepseek-v4-flash` | Automatic. The gateway picks the cheapest provider that passes your minimum trust score and [routing policy](/docs/gateway/routing); trust only breaks ties. |
| `<peerId>@deepseek-v4-flash` | Pinned. Every request goes to that provider. The peer id is lowercase, without `0x`. |

Routing policies apply to pinned requests too: a pinned provider that your policy blocks is refused.

## Models page

**Models** lists every model offered on the network, with its type, number of providers, input and output price per million tokens, and context length. Filter by name or alias, by type, or turn on **Free** to see only models with free offers. A **TEE** badge means at least one provider runs the model in a trusted execution environment.

Click a model to open its panel:

- The model id with a copy button, its type, context length, capabilities (tool use, reasoning, structured output, vision) and aliases.
- **Providers**: every provider offering the model, with its price, trust score, time to first token and output speed. Each row has a copy button for the pinned id `<peerId>@<model>`, verified domain or GitHub links when the provider has them, and a link to the provider on **Providers**.
- **API call**: a request for the model. The selector defaults to **Best provider (automatic)**. Pick a provider in it, or click **Pin** on a provider row, to get the pinned version instead.

Image models get a `/v1/images/generations` call. Video models are served through the gateway's [video job routes](/docs/gateway/api#supported-routes), which the panel does not generate a call for yet.

The Models page shows the whole network, without any routing policy applied. A client calling `GET /v1/models` with an API key that has an allow list of models only sees the models that key may use.

## Providers page

**Providers** lists the providers the gateway's buyer knows, with prices, trust score, reputation (when available), the median time to first token and output speed (tokens per second) on this gateway's streamed requests, and how many requests this gateway sent them in the last 24 hours. Filter by name, peer id or model, or turn on **Domain or GitHub**, **TEE** or **Free**. Badges show **TEE**, **Free**, **Flagged** and **Cooling down** (a provider that failed recently and is skipped for a while).

Click a provider to open its panel:

- Its peer id with a copy button, verified links, trust score, stake, network usage share, time to first token, output speed and recent failures.
- **Allow**, **Prefer** and **Block**, which add this provider to a routing policy. You choose the scope in **Apply to**: the gateway default, a workspace's organization or workspace policy, a member or an API key. The other settings of that policy stay as they are. See [Routing policies and presets](/docs/gateway/routing).
- **Models**: each model the provider offers, with its price, the API it speaks, a copy button for `<peerId>@<model>` and an **API call** button.
- **API call**: ready-to-run requests pinned to this provider.

Named groups of providers that routing policies allow or block in one step are managed under **Routing → Seller lists**. See [Seller lists](/docs/gateway/routing#seller-lists).

Panel addresses can be bookmarked or shared: `/console/models/<model>` and `/console/providers/<peerId>`. Older `/console/network/…` links open **Providers**.

## Verified identity

Some providers prove they control a domain or a GitHub account. The console shows those as links on the provider's row and panel. It shows only claims the buyer verified. Providers set this up as described in [Verified identity](/docs/provide/verified-identity).

## API call snippets

Every snippet uses your gateway's base URL and reads the key from `$ANTSEED_API_KEY`, never a real secret. The format follows the model: chat completions for text models, the images API for image models, and for a pinned provider the API that provider speaks (`/v1/chat/completions`, `/v1/messages` or `/v1/responses`).

**curl**

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

**Python** (OpenAI SDK)

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

**JavaScript** (OpenAI SDK)

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

Models that speak the Messages API also get an **Anthropic SDK** tab. On the Providers panel, text models also get **Codex**, **Claude Code** and **Cursor / OpenAI-compatible** tabs; [Calling the API](/docs/gateway/api#coding-tools) shows them.

For the image model `qwen-image`, the curl tab looks like this:

```bash
curl https://gateway.example.com/v1/images/generations \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@qwen-image","prompt":"A lighthouse on a cliff at dawn, watercolor","n":1}'
```

## From the command line

`antseed gateway peers` lists the providers the running buyer knows, with trust, TEE, prices and this gateway's own 24-hour stats. `antseed gateway peers --model deepseek-v4-flash` narrows it to one model. See [Commands](/docs/commands).

Next: [Chat](/docs/gateway/chat), or [call the API](/docs/gateway/api) from your own code.
