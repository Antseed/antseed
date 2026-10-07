---
sidebar_position: 2
slug: /guides/using-the-api
title: Using the API
hide_title: true
---

# Using the API

Once connected to the Antseed network, your buyer proxy exposes a local API at `http://localhost:8377`. Point any AI tool at this endpoint — the proxy handles peer discovery, routing, and payments transparently.

There are two ways to get that proxy running:

- **AI VPN desktop app (recommended)** — download from [antseed.com](https://antseed.com). While the app is open it runs the buyer proxy at `http://localhost:8377` for you, and its **Apps** view detects tools like Claude Code and Codex on your machine and launches them already wired to Antseed. Its routing preferences are saved into the same buyer config used by the proxy, so internal chat, connected apps, and direct API calls use the same Price + Trust policy. Deposits and peer browsing live in the same UI.
- **CLI** — `antseed buyer start`, for headless machines, servers, and scripts. The Quick Start below covers this path.

Everything in this guide works identically against both.

If the client runs outside this computer—or uses a hosted backend that cannot reach `localhost`—open the AI VPN's **Agents** view and [connect a remote agent](/docs/guides/agents#connect-a-remote-agent).

## Quick Start (CLI)

```bash
# 1. Install
npm install -g @antseed/cli

# 2. Set your identity
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 3. Start the buyer proxy
antseed buyer start
# Proxy listening on http://localhost:8377

# 4. Browse available models and peers
curl -s http://localhost:8377/v1/models | jq '.data[].id'
antseed network browse

# 5. Make a request — the model name selects the highest-ranked eligible
#    offer under your shared Price + Trust routing preferences
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 6. Deposit USDC when you want to pay providers
antseed buyer deposit
# Shows your funding address + QR code; incoming USDC deposits automatically
```

Model-only requests automatically rank compatible offers using your Price + Trust preferences, peer health, and model-specific pricing metadata. The default minimum trust score is `60`; lower-trust or unscored sellers are ineligible unless you lower `buyer.routingPreferences.minTrustScore` (set it to `0` to disable the gate). To force one seller, encode the peer in the model field: `"model": "<peerId>@deepseek-v4-flash"`. See [Automatic routing and explicit pins](#automatic-routing-and-explicit-pins) below.

`antseed buyer start` does not require a pre-existing `~/.antseed/config.json`. If the file is missing, the CLI starts with built-in defaults such as router `local` and proxy port `8377`. The proxy binds to `127.0.0.1` only — it is never exposed to your LAN.

## Follow the AI VPN model picker with `model: "antseed"`

Clients connected to the AI VPN desktop proxy can send the special model alias `antseed`. The proxy replaces it at request time with the model or explicit seller route currently selected in AI VPN, so changing the picker updates already-configured clients without rewriting their config files.

```json
{
  "baseURL": "http://127.0.0.1:8377/v1",
  "apiKey": "antseed",
  "model": "antseed"
}
```

The alias is useful for agent clients with a single default-model setting, including the [Hermes](/integrations/hermes) and [OpenClaw](/integrations/openclaw) configurations. The API key only needs to be non-empty when a client requires one; the local proxy does not authenticate it.

`antseed` is an AI VPN-controlled alias, not a model in the network catalog. If AI VPN has not selected a route, the proxy returns `no_default_route`. Headless CLI buyers should normally request a concrete catalog model such as `deepseek-v4-flash`. To bypass the AI VPN selection for one request, use `"model": "<peerId>@<serviceId>"`.

## Automatic routing and explicit pins

The buyer proxy can auto-select a peer from the requested model, or you can override that choice with one of three explicit pin mechanisms:

| Mechanism | Scope | How |
|---|---|---|
| **Model prefix** `<peerId>@<model>` | one request | `"model": "<peerId>@deepseek-v4-flash"` |
| **Header** `x-antseed-pin-peer: <peerId>` | one request | works even when the tool controls the model field |
| **Session pin** | until changed | `antseed buyer connection set --peer <peerId>` (survives daemon restart) |

Precedence when several are present: header > model prefix > session pin. The model prefix is always stripped before routing, so `<peerId>@deepseek-v4-flash` reaches the seller as model `deepseek-v4-flash`.

Without a pin, the proxy canonicalizes the requested model name, considers every compatible peer advertising that model, applies the shared routing preferences, and selects the highest-ranked eligible offer. Ranking combines trust, token or image price, cached-input pricing coverage, recent failures, cooldowns, free-peer preference, and allow/block lists. Missing cached-input pricing reduces an offer's effective model-specific reputation only when another seller for that model advertises cached pricing; if no seller reports it, nobody is penalized.

For recognized conversations, the first automatic route becomes a **soft affinity**: later turns prefer the same seller and service so a chat stays consistent. The proxy may still fail over when that seller is unavailable, cooling down, policy-ineligible, or returns a retryable peer-attributed failure. Stable session metadata from supported coding tools is used automatically, and the desktop internal chat supplies its conversation identity directly. Explicit pins are different: they remain hard and never switch sellers automatically.

The `<peerId>@<model>` form forces a specific seller and works in the model field of **every** tool and SDK that lets you type a model name — Claude Code, Codex, LangChain, the Vercel AI SDK, curl. The peer id is 40 hex chars, with or without a `0x` prefix, case-insensitive. One caveat: the prefix rewrite needs a JSON body, so it does not work on multipart requests (`/v1/images/edits`) — use the header there.

```bash
# Discover peers and what they serve
antseed network browse                    # all peers + services + pricing
antseed network browse --service deepseek # filter by service name
antseed network peer <peerId>             # one peer in detail (pricing, protocols, on-chain stats)

# Pin / unpin a session peer
antseed buyer connection set --peer <peerId>
antseed buyer connection clear

# List every model on the network (answered locally; free, no pin needed)
curl -s http://localhost:8377/v1/models | jq '.data[].id'

# Only image-generation models, with the peers that serve them
curl -s 'http://localhost:8377/v1/models?type=images' | jq '.data[] | {id, peers: [.peers[].peerId]}'
```

`GET /v1/models` is answered locally from the buyer's discovered-peer cache and covers the **whole network** — no peer pin required. Cosmetic names and conservative aliases such as `claude-opus-5` and `opus-5` are grouped into one entry, whose `aliases` array includes normalized observed names and the compact canonical key (for example `['claude-opus-5', 'opus-5', 'opus5']`). Established model families also merge numeric-version punctuation and conservative flattened vendor prefixes, so names such as `gpt-5.6-sol`, `gpt-56-sol`, and `openai-gpt-56-sol` resolve to the same entry; Claude `coding-only` aliases merge into their base model, while meaningful variants such as `fast` and `web` remain distinct. Each entry keeps an observed `id` for compatibility and exposes a protocol-wide preferred `name` for display, so every GPT 5.6 alias renders consistently as names such as `GPT 5.6 Sol` or `GPT 5.6 Luna`. It also lists the model `type` (`text`, `image`, or `decision`) and a `peers` array with every seller serving it. A peer appears at most once per canonical model: when the same peer advertises equivalent aliases through one or more providers, Antseed retains only its cheapest known offer while preserving that offer's actual provider, protocol, and `serviceId` for routing. Each peer offer also includes reputation, pricing, categories, and seller-reported capabilities such as context window, output limit, modalities, reasoning, tool use, structured output, and supported parameters. Offers use the same shared Price + Trust ordering as automatic buyer routing, including the minimum-trust eligibility gate, cached-price adjustment, pricing, cooldowns, and recent failures. Filter with `?type=text`, `?type=images`, or `?type=decisions`, or look up a single model with `GET /v1/models/<id>`. Sending an API request with only one of these model names automatically selects from that ranked offer set; a saved conversation affinity can prefer its previous healthy seller over the first catalog offer. Route to a specific offer explicitly with `<peerId>@<serviceId>` using values from that same `peers[]` item.

Model-level `context_length`, `max_output_tokens`, modalities, capability booleans, and `supported_parameters` are conservative guarantees for model-only routing: numeric limits use the lowest value, lists use the intersection, and booleans are `true` only when every offer explicitly reports support. If any offer omits a field, that model-level field is omitted rather than treating unknown as unsupported. `capability_coverage` reports how many offers supplied each field, while `supported_protocols` is the union of protocols available across sellers. The full per-peer capabilities remain authoritative when selecting a particular seller.

If one peer advertises multiple service ids that normalize to the same model, Antseed keeps a single offer for that peer: the lowest-priced alias. Text offers compare `inputUsdPerMillion + outputUsdPerMillion`; image offers compare `minImageUsdPerImage`; an explicitly known price beats an unknown price. All observed names remain in the model's `aliases`, and model-only routing rewrites requests to the retained seller service id.

Cached-input pricing is treated as model-specific metadata completeness. If at least one offer for a model advertises `cachedInputUsdPerMillion`, an offer that omits it receives a 50% reduction to its effective reputation for that model because its real cost can be materially higher for cache-heavy workloads. This remains a soft penalty: an exceptionally stronger peer can still outrank a weaker peer with complete cached pricing. If no offer for the model advertises cached-input pricing, Antseed assumes the model may not support caching and applies no penalty. `reputationScore` remains the raw trust/reputation value, while `effectiveReputationScore` shows the normalized model-specific score used for ordering and model-only routing.

The desktop's **Auto** route stores the selected model without a peer id. Telegram model selections, automatic in-app chats, and connected apps configured with the `antseed` model alias therefore use the same shared Price + Trust policy, cooldown avoidance, and peer fallback. Recognized conversations softly prefer the seller that actually served their previous turn while it remains healthy and eligible. Explicitly choosing a seller in the desktop stores `<peerId>@<serviceId>` instead and intentionally keeps that route single-peer.

## Supported API Formats

The proxy accepts these API formats. Use whichever matches your tool:

| Endpoint | Format | Compatible Tools |
|---|---|---|
| `/v1/messages` | Anthropic Messages API | Claude Code, Anthropic SDKs |
| `/v1/chat/completions` | OpenAI Chat Completions | Any OpenAI-compatible client |
| `/v1/responses` | OpenAI Responses API | Codex |
| `/v1/images/generations` | OpenAI Images generation | OpenAI-compatible image clients |
| `/v1/images/edits` | OpenAI Images edits | OpenAI-compatible multipart image clients |
| `/v1/models` | OpenAI model list | network-wide, answered locally; `?type=images` filters (free) |
| `/v1/messages/count_tokens` | Anthropic token counting | answered locally, never routed or billed |

The `model` field in your request determines which service to route to, and optionally which peer (`<peerId>@<model>`).

**Your tool's wire format does not need to match the seller's.** If the pinned peer serves the model natively in your tool's format, the request passes through untouched. Otherwise `@antseed/api-adapter` translates on the fly — Anthropic ↔ OpenAI Chat ↔ OpenAI Responses in any direction — so Claude Code can talk to an OpenAI-only seller and Codex to an Anthropic-style one. Limitations to know: image endpoints are never translated (the peer must advertise `openai-images`), reasoning traces do not survive translation, and services behind `openai-responses` require streaming (the adapter handles this transparently, re-assembling a non-streaming response when your tool asked for one).

### Images

Image services advertise the `openai-images` protocol and may publish per-output pricing. Buyers validate the seller's announced unit-billing model before authorizing payment. Image requests are not included in periodic model health probes because a meaningful probe would create a billable upstream image.

```bash
curl http://localhost:8377/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{
    "model": "flux.1-schnell",
    "prompt": "A tiny ant carrying a seed",
    "n": 1,
    "size": "1024x1024"
  }'

curl http://localhost:8377/v1/images/edits \
  -F 'model=flux.1-schnell' \
  -F 'prompt=Now with a blue background' \
  -F 'image=@source.png' \
  -F 'n=1'

# Discover image models first: GET /v1/models?type=images
# A bare model id uses automatic routing and can fail over.
# To explicitly pin a multipart /v1/images/edits request, use:
#   -H 'x-antseed-pin-peer: <peerId>'
```

Image edits are multipart requests, but their `model` field follows the same routing and seller-side alias rewriting rules as JSON generation requests. Upgrade the buyer and seller together if an upstream rejects an edit with `model is required`: `@antseed/cli@0.1.150`, `@antseed/provider-core@0.2.53`, and `@antseed/provider-openai@0.2.45` predate multipart model preservation, so edits that depend on a seller service rewrite can fail on those versions. Use `@antseed/cli@0.1.151`, `@antseed/provider-core@0.2.54`, and `@antseed/provider-openai@0.2.46` or newer. The provider plugin pins its provider-core version, so updating only the buyer is not sufficient. Desktop v0.2.16 predates conversational image editing entirely.

Sellers that support edits must advertise both `text` and `image` in the service's input modalities, with `image` in its outputs. This is an end-to-end capability claim for that exact configured service: the provider adapter, upstream endpoint, and upstream model must all accept image edits. A service advertising `inputs: ["text"]` is generation-only, so buyers must not route `/v1/images/edits` to it. Do not add image input merely because the upstream vendor supports editing through a different endpoint or separate model. Venice-backed services are generation-only through the current generic OpenAI-compatible adapter; native Venice edit translation is tracked separately.

In Desktop image chats, follow-up prompts use `/v1/images/edits` only when the selected seller advertises image input. With a generation-only seller, Desktop keeps the selected seller and requests a new image using the conversation's image-prompt history as cumulative instructions.

## Claude Code

**Recommended:** launch Claude Code from the AI VPN's **Apps** view — it detects the installed tool, wires it to the proxy, and handles peer and model routing automatically.

CLI alternative — the `antseed claude` wrapper resolves the running buyer proxy, sets `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_API_KEY` for the child process, and forwards the rest of your flags to Claude Code:

```bash
antseed claude --model kimi-k2.6

# Route to a specific peer for the session:
antseed claude --model <peerId>@kimi-k2.6
```

Manual equivalent:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8377
export ANTHROPIC_API_KEY=antseed   # any non-empty placeholder
claude --model kimi-k2.6           # or <peerId>@kimi-k2.6
```

Claude Code sends requests to `/v1/messages`. Bare model ids use automatic routing and conversation affinity; explicitly prefixed model ids remain hard-pinned. The proxy translates to the selected seller's native format when needed.

## Codex

**Recommended:** launch Codex from the AI VPN's **Apps** view, which supplies the provider config and routing for you.

CLI alternative — recent Codex versions (0.40+) ignore `OPENAI_BASE_URL` and `OPENAI_API_KEY`, so use the wrapper for automatic per-run config:

```bash
antseed codex --model deepseek-v4-flash

# Route to a specific peer:
antseed codex --model <peerId>@deepseek-v4-flash
```

Or create `~/.codex/antseed.config.toml` and launch with `codex --profile antseed` for a persistent manual setup. See the [Codex integration page](/integrations/codex) for the tested profile file, routing-verification check, and known gotchas (project-local configs, `-c` flag pitfalls).

## OpenCode

**Recommended:** launch OpenCode from the AI VPN's **Apps** view. CLI alternative:

```bash
antseed opencode --model gpt-oss-120b

# Route to a specific peer:
antseed opencode --model <peerId>@gpt-oss-120b
```

The wrapper writes a temporary OpenCode provider config pointing at the proxy and removes it when the session ends. See the [OpenCode integration page](/integrations/opencode) for manual config.

## curl

Use a bare model id for normal automatic routing:

```bash
# Anthropic format
curl http://localhost:8377/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "kimi-k2.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI format
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# To hard-pin one request, prefix the model with a peer id:
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "<peerId>@deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## How Routing Works

When you send a request:

1. The proxy resolves an explicit peer pin when present (header > `<peerId>@<model>` prefix > session pin).
2. Without a pin, it canonicalizes the requested model, finds compatible offers, applies the shared `buyer.routingPreferences`, and ranks eligible sellers by Price + Trust plus health signals.
3. If the request belongs to a known conversation, its previous automatic route is softly preferred while it remains healthy and eligible.
4. The request model is rewritten to the selected peer's actual advertised `serviceId`, so aliases such as `claude-opus-5`, `opus-5`, and `opus5` route correctly.
5. If the seller's native protocol differs from your tool's, the request is translated by the api-adapter.
6. The request is forwarded to that peer over an encrypted peer-to-peer connection and the response streams back through the proxy.

Explicitly pinned requests never fail over to a different peer. Model-only requests skip cooling peers when another eligible offer is ready, and peer-attributed retryable failures advance to the next ranked offer. HTTP `429` gets up to three attempts on the same peer before fallback. Buyer-local failures, client cancellation, non-retryable responses, and responses whose streaming headers already started never fail over. After a successful automatic route, the actual peer and service are persisted for conversation affinity; attribution always comes from the request/response path, never by guessing from `/v1/models` ordering.

## Response Headers: Cost and Attribution

Every non-streaming response carries telemetry headers so you can see exactly who served the request and what it cost:

```
x-antseed-peer-id: <peerId>
x-antseed-service: deepseek-v4-flash
x-antseed-input-tokens: 14
x-antseed-output-tokens: 78
x-antseed-estimated-cost-usd: 0.000306
x-antseed-latency-ms: 912
x-antseed-peer-reputation: 87
```

Streaming responses carry only the request id and peer identity headers (token counts aren't known when headers are flushed) — use `antseed buyer metering` for authoritative per-channel token and USDC totals. The desktop stores that actual routed peer on the conversation. Its **Show routed peer** preference is off by default and only controls whether the saved seller is displayed in chat lists and chat views.

## Errors You Might See

| Status | Code / message | Meaning | Fix |
|---|---|---|---|
| 400 | `missing_routing_target` | Request has neither a model nor an explicit peer pin | Set `model`, or pin a peer |
| 502 | `model_not_found` | No policy-allowed peer currently advertises the requested model or alias | Check `curl localhost:8377/v1/models`; adjust policy or choose another model |
| 402 | `insufficient_deposits` | No (or too little) USDC deposited | `antseed buyer deposit`; response includes `suggestedAmount` |
| 402 | `channel_exhausted` | Per-channel budget spent | Deposit more or re-open the channel |
| 413 | `upload_body_too_large` | Request exceeds the seller's upload limit | Response includes the seller's `maxUploadBodyBytes`; trim context or pick another peer |
| 502 | `Pinned peer … is not reachable` | Peer offline or not announcing | `antseed network browse` for alternatives |
| 502 | `Pinned peer … is outside your buyer routing policy` | Peer's price exceeds your `maxPricing` caps or reputation below `minPeerReputation` | Raise caps in buyer config, or pick a cheaper peer |
| 499 | `Request cancelled` | Your client aborted mid-request | Nothing — the upstream request is aborted too |

## Health and Diagnostics

The proxy serves a local control plane under `/_antseed/*` (used by the desktop app; handy for scripts):

```bash
curl -s http://localhost:8377/_antseed/status    # DHT node count, peer count, uptime
curl -s http://localhost:8377/_antseed/peers     # cached peer list with pricing + reputation
curl -s -X POST http://localhost:8377/_antseed/peers/refresh   # force re-discovery
curl -s http://localhost:8377/_antseed/channels  # your open payment channels
```

## Buyer state isolation

Buyer runtime state is stored in the CLI data directory. By default this is `~/.antseed`, where the proxy writes `buyer.state.json`, SQLite databases, payment-channel files, and the fallback `identity.key`.

For multiple buyer nodes, service integrations, isolated tests, or concurrent processes, give each buyer its own data directory:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"

ANTSEED_DATA_DIR="$BUYDIR" \
antseed --data-dir "$BUYDIR" buyer start \
  --peer <peer-id> \
  --port 8380
```

Use `--data-dir <path>` in service/systemd scripts because it is explicit. `ANTSEED_DATA_DIR=<path>` is useful for wrappers and local scripts. Do not reuse the same buyer data directory across concurrent processes.

If the buyer proxy starts but appears to use stale pins, waits on broad discovery, times out before payment negotiation, or shows sessions/channels in an unexpected place, check the startup log for the resolved data directory and `buyer.state.json` path. `ANTSEED_HOME` is not the CLI state-isolation setting; use `--data-dir` or `ANTSEED_DATA_DIR`.

Extra buyer config is optional. Add it only for advanced customization such as pricing caps, reputation thresholds, bootstrap nodes, or chain settings:

```json
{
  "buyer": {
    "minPeerReputation": 0,
    "routingPreferences": {
      "preferFreePeers": false,
      "maxInputUsdPerMillion": 25,
      "minTrustScore": 60,
      "allowedPeerIds": [],
      "blockedPeerIds": []
    },
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 25,
        "outputUsdPerMillion": 75
      }
    }
  },
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

`routingPreferences` controls model-only automatic routing and is shared with the desktop AI VPN. `minTrustScore` is a hard eligibility gate; set it to `0` only if you intentionally want unscored and lower-trust peers considered. `allowedPeerIds` restricts automatic routing to that list when non-empty, while `blockedPeerIds` always excludes matches. The running proxy watches `config.json` and reloads valid routing-preference changes without a restart.

With a config file like that in place, the startup command is still just:

```bash
antseed buyer start
```

## Local and public authentication

The local proxy at `127.0.0.1:8377` does not validate an API key. Authentication and payments are handled by the protocol using your node's identity key and on-chain USDC deposits, so local tools that require an API-key field can use any non-empty placeholder.

The AI VPN's public endpoint is different: it requires the generated `antseed_...` key as `Authorization: Bearer <API_KEY>`. Configure it from **AI VPN → Agents → Define your internet-accessible Antseed endpoint** and follow the [Public HTTPS Tunnels guide](/docs/guides/public-tunnels).

## Monitor Buyer Usage

Expose buyer metrics with:

```bash
antseed metrics serve --role buyer
```

See [Metrics](/docs/guides/metrics) for buyer spend, channel, request, token, and per-peer metrics. For a quick per-peer view without metrics infrastructure, `antseed buyer metering` prints token and USDC totals per channel.

## Agent Skills

If you're using Pi, Codex or another agent, these skills can walk you through the full setup:

- [`antseed/antseed-pi`](https://github.com/AntSeed/pi-antseed) — Use the Antseed local buyer proxy as a model provider in pi.
- [`@skills/join-buyer`](https://github.com/AntSeed/antseed/tree/main/skills/join-buyer) — step-by-step buyer setup for Claude Code agents
- [`@skills/antseed-images`](https://github.com/AntSeed/antseed/tree/main/skills/antseed-images) — discover image models from `/v1/models?type=images` and generate through automatic model-only peer routing
- [`@skills/antseed-decisions`](https://github.com/AntSeed/antseed/tree/main/skills/antseed-decisions) — discover decision models from `/v1/models?type=decisions` and ask typed `choice`, `score`, and `noul` questions through `/v1/systemone`
- [`@skills/openclaw-antseed`](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) — connect OpenClaw to Antseed as a buyer
- [`@skills/hermes-antseed`](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) — connect Hermes Agent through the local AI VPN or its authenticated public endpoint

See the maintained [OpenClaw integration](/integrations/openclaw) and [Hermes integration](/integrations/hermes) for current upstream-compatible configuration examples.
