---
title: Routing policies and presets
slug: /gateway/routing
sidebar_label: Routing and presets
description: Choose which providers may serve your gateway's requests and how they are ranked, and save model setups as presets.
---

# Routing policies and presets

A routing policy decides which providers may serve a request and how the eligible ones are ranked. You can set policies for the whole gateway, a workspace, a member, an API key and a preset. Each level can only narrow the ones above it.

## What a policy can say

| Setting | Meaning |
|---|---|
| **Which sellers may serve** | **Any seller**, or **Only these**: chosen providers or saved peer lists |
| **Blocked sellers**, **Blocked peer lists** | Providers that never serve |
| **Minimum trust score** | 0 to 100. See [Trust score](/docs/reputation). |
| **TEE sellers only** | Only providers that advertise running models in a trusted execution environment (TEE) |
| **Verified sellers only** | Only providers whose responses pass a verifier, such as a TEE attestation check |
| **Sort by** | **Balanced**, **Lowest price**, **Lowest latency** or **Highest trust**. **Balanced** keeps the buyer's automatic order: the cheapest provider that passes the trust minimum, with trust only breaking ties (see [Router plugin API](/docs/router-api)). |
| **Free sellers first** | Rank free providers ahead of paid ones |
| **Which models may be used** | **Any model**, or **Only these models**. Requests for other models get `403 model_not_allowed`. |
| **Price caps** | Maximum input, output and cached-input price per million tokens, and price per image |
| **Fallback chains** | For a model, an ordered list of providers to try first. **Strict** allows only those providers. |
| **Reputation** | Minimum reputation, 0 to 100 |

The policy editor also offers starting points: **Cheapest**, **Most trusted** (trust 70+ and reputation 60+, ranked by trust), **TEE only** and **Own peers only** (only providers in one of your peer lists).

**TEE sellers only** checks what providers advertise, so it works whether or not your buyer verifies responses. **Verified sellers only** requires your buyer to verify them. [Verify TEE providers](/docs/verify-tee) explains the difference and how to turn verification on.

## Policy levels

Policies apply in this order:

1. **Buyer settings**: the buyer's own config, under **Settings → Buyer** (organization admins). Its price caps, minimum trust and reputation, verification and allowed or blocked providers are the top of every policy.
2. **Gateway default**: on **Routing**, for every request through the gateway.
3. **Organization policy**: a workspace's policy set by organization admins. Workspace admins cannot change it.
4. **Workspace policy**: set by the workspace's own admins, on top of the organization policy.
5. The **member** who owns the key.
6. The **API key**: the admins' layer, then the key owner's own layer.
7. The **preset**, if the request uses one.

Each level only narrows the ones above it:

- Allow lists intersect, and block lists add up.
- Minimums take the higher value, and price caps the lower one.
- **TEE sellers only** and **Verified sellers only** stay on once any level turns them on.
- Ranking choices (sort, free first, fallback chains) take the most specific level that sets them.

A member can therefore never give their own key more than their workspace allows. The default minimum trust score in the buyer settings is 60, so a lower minimum at a gateway level has no effect until you lower the buyer's. If providers you expect are missing, check **Settings → Buyer** first.

Policies also apply to pinned requests (`<peerId>@<model>`): a client cannot get around a policy by pinning a provider.

## Edit policies

- **Routing** shows the **Gateway default** and **This workspace** tabs, and **Effective for this workspace**: what keys in the workspace get before member, key and preset policies narrow it.
- **Members** and **Keys** have a policy section when you edit a member or a key.
- On **Providers**, **Allow**, **Prefer** and **Block** add one provider to the policy at the scope you choose and keep the rest of that policy. See [Models and providers](/docs/gateway/models).

When a save would leave no provider able to serve, or asks for more than the levels above allow, the console asks you to confirm.

## Route preview

**Route preview** on the **Routing** page shows, for a model and a workspace, key, member or preset, which providers would serve a request and in what order, and why the others are excluded: blocked, over a price cap, below the trust minimum, and so on. Exclusions caused by the buyer settings read `buyer config: …`, for example `buyer config: reputation 30 below 40`.

## Presets

A preset is a saved model setup: a model, an optional system prompt, default request parameters and an optional routing policy. Clients use one by sending `@preset/<slug>` as the model.

Create one on **Presets** with **Name**, **Slug**, **Model**, **Available in** (one workspace, or all workspaces for organization admins), **System prompt** and **Parameters (JSON)**.

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "@preset/code-review", "messages": [{"role": "user", "content": "Review this diff: …"}]}'
```

The gateway:

- Replaces the model with the preset's, for example `<peerId>@qwen3-coder-480b`.
- Puts the preset's system prompt before the client's.
- Merges its parameters under the client's own, so the client's values win.

Presets work on `/v1/chat/completions`, `/v1/messages` and `/v1/responses`. An unknown slug returns `400 preset_not_found`.

Codex needs a preset as its model. The **Codex** tab in a provider's API call panel offers **Create preset for this model**.

## From the command line

```bash
antseed gateway routing set --min-trust 30 --max-input-price 5
antseed gateway workspace policy set Research --layer org --require-tee
antseed gateway key policy set <keyId> --allow-model deepseek-v4-flash --sort price
antseed gateway routing preview --model deepseek-v4-flash --workspace Research
antseed gateway preset create --slug coder --name Coder --model qwen3-coder-480b --param temperature=0.2
```

A `policy set` replaces the policy at that level unless you add `--merge`. See [Commands](/docs/commands) for every flag.

Next: [Calling the API](/docs/gateway/api).
