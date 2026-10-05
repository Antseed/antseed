---
sidebar_position: 1
slug: /guides/vpr
title: AI VPN Desktop Guide
description: Use the Antseed AI VPN—like a VPN for AI—to choose sellers, connect AI apps, manage credits, understand privacy, and troubleshoot requests.
---

# AI VPN Desktop Guide

The Antseed **AI VPN** is like a **VPN for AI**: your AI apps connect to one local router, while the AI VPN discovers available sellers, applies your routing preferences, and sends each compatible request through the selected route. You can change models or sellers without reconfiguring every connected tool.

The AI VPN also manages pay-per-request settlement from your Antseed credits, so connected tools can use network sellers without maintaining a separate Antseed subscription or central AI account.

This guide follows the AI VPN interface from first launch through troubleshooting. For a protocol-level introduction, see [How Antseed works](/docs/overview).

## Start the router

Use the power button on the Home screen to start or stop the local router. Once it is running, the status area shows network health, the local proxy port, and the number of visible peers and services.

Discovery is not instant. After startup, allow a few seconds for peer announcements and model offers to arrive. Open **Models** and use **Refresh models** if the catalog still appears empty.

The AI VPN runs locally, but the AI service is delivered by the seller selected for each route. Antseed does not put a central account or hosted chat service between the AI VPN and that seller.

## Choose a model and seller

Open **Models** to browse the services currently advertised on the network. The catalog shows live seller availability, offered prices, and expected savings where a retail comparison is available.

Selecting a model sets the route used by new sessions. Existing conversations may retain their current model or seller affinity so they can continue consistently.

### Automatic seller selection

With **Auto select seller** enabled, the AI VPN ranks eligible sellers using your routing preferences and current network information. The selection can account for:

- Minimum trust score
- Price preference and hard maximum pricing
- Free-service preference
- Recent route failures and cooldowns
- Whether the seller offers the requested model and API format

Automatic routes can fail over after retryable seller or transport failures. A conversation normally prefers the seller that served it successfully, but that affinity is not a hard pin.

### Pin a seller

Pin a seller when you need a fixed route. A pin overrides automatic seller selection and does not fail over to another peer. Remove the pin before troubleshooting availability or performance problems with that seller.

Seller reputation is an input to routing, not a guarantee about model quality, privacy, or future availability. See [Reputation](/docs/reputation) for the protocol-level scoring model.

## Set routing preferences

Click the **Settings** gear beside the credit balance to open **Preferences** and control automatic routing across models:

- **Minimum trust score** excludes sellers below the selected threshold.
- **Price preference** strongly penalizes offers above the preferred input-token price.
- **Maximum pricing** is the hard spending cap when configured.
- **Prefer free peers** gives zero-cost eligible routes a strong ranking advantage.

Turning automatic selection off leaves connected apps on their last selected route. It does not automatically choose a replacement if that pinned route becomes unavailable.

## Chat inside the AI VPN

The AI VPN includes its own chat interface, so you can use network models without opening another tool. Type in **Ask anything. On any model...** on Home to start a conversation with the currently selected model.

### Choose a model for the conversation

The model picker in the chat header controls the active conversation. If the conversation already contains messages, the AI VPN asks whether to continue that thread on the new model or start a new chat so the existing thread keeps its current model.

Use **New chat** to start a clean conversation with the same current model. The **View chats** control opens the conversation list; from there you can return to previous chats, search within the active conversation, and manage the chat history stored by the AI VPN.

### Conversations keep their own route

Changing the global model affects new sessions. An existing conversation keeps its own model until you deliberately change it. This prevents changing the Home picker from unexpectedly moving every active conversation.

The internal chat and connected-tool conversations use the same model catalog, Price + Trust preferences, seller routing, credits, and payment channels.

## Connect an AI app

Open **Connected apps** and select a detected tool. Depending on the application, the AI VPN connects it by updating a supported configuration file or by routing its API domains through the local proxy.

The tool keeps its normal interface. Its compatible AI requests are sent to the local AI VPN endpoint, translated when necessary, and routed to the selected Antseed seller.

Some config-file integrations must be restarted before they read their updated settings. When the app row shows **Restart**, use that action before testing the connection.

For manual endpoints, SDK examples, and supported wire formats, see [Using the API](/docs/guides/using-the-api). Tool-specific setup is available from the [Integrations directory](/integrations).

### App settings

Use the gear on an app row to choose which installed application the AI VPN opens, manage the client names used to attribute conversations, or disconnect and remove the integration.

For config-file integrations, the AI VPN keeps a backup beside the original config and removes its changes when you disconnect. For HTTPS proxy integrations, disconnecting stops the local interception for that app.

### Trust the local HTTPS certificate

Some connected apps use HTTPS endpoints that the local proxy must intercept on your device. For those apps, the AI VPN generates a local certificate authority and asks the operating system to trust it.

The certificate is generated locally and its private key does not leave your computer. You can inspect or reveal the certificate from **Connected apps**. If an intercepted app reports an SSL or certificate error, trust the current certificate and restart the app.

Only apps connected through HTTPS interception need this certificate. Config-file integrations that point directly to the local AI VPN API do not.

## Manage connected-tool conversations

After a connected app sends a request, its conversation appears under **Recent chats** on Home, Connected apps, and the floating window. Open the full Chats view from the Recent chats card to manage them.

Each conversation keeps the model that served it. This lets one Claude Code, Codex, or other tool session stay on one model while another session uses a different model.

### Select a model for one conversation

1. Open **Recent chats** and select the conversation.
2. Choose the model that conversation should use.
3. Return to the connected tool and continue the same session.

Changing a conversation's model does not change the default model for new sessions or the models assigned to other conversations.

### Select a specific seller for one conversation

Each model row in a conversation has settings for its seller route:

- Leave **Auto select seller** on to use your Price + Trust preferences and automatic failover.
- Turn it off to keep the seller currently serving the conversation.
- Select a seller row to pin that exact seller for the conversation.
- Select the pinned seller again, or turn automatic selection back on, to return the conversation to automatic routing.

A seller pin applies only to that conversation. It does not change the global seller choice for the model or other chats.

### Rename, open, or delete a conversation

The conversation detail page lets you rename a chat, open the connected application it belongs to, or delete its stored entry. If the external tool session is still active, a deleted entry can appear again when that tool sends its next request.

## Use the floating window

The floating window stays above your other apps so routing information and conversation controls remain available while you work. It shows your balance, the active model, and current token and cost activity.

The status dot is red when routing is stopped, steady while the router is ready, and pulses while request traffic is moving. A conversation receiving traffic also displays an activity pulse in the conversation menu.

Open the menu to:

- Change the default model used by new sessions
- Select a recent conversation and change only its model
- Open the connected app that owns a conversation
- See the model assigned to each conversation
- See the seller that actually served the conversation when **Show routed peer** is enabled

### Floating-window preferences

Open **Preferences → Floating window** to control its behavior:

- **Show on traffic** opens the floating window automatically when a connected app begins sending requests.
- **Show routed peer** displays the seller that actually served each conversation in Recent chats, the internal chat list, and the floating window.

You can still open or close the floating window manually. Closing it does not stop the router, disconnect apps, or end active conversations.

## Privacy, transport, and seller trust

The AI VPN is anonymous by default. There is no central Antseed account, platform-issued API key, or personal profile attached to your requests. Sellers generally receive a pseudonymous peer or wallet identity rather than your name, email, or identity on the tools you connected.

### Anonymous access

Identity anonymity and request content are separate. A standard seller can process the prompt it serves, but Antseed does not tell the seller who you are. A passing seller-node TEE check is narrower than end-to-end inference confidentiality; see the verification section below.

### What stays local

The AI VPN's configuration, signing identity, connected-app setup, routing decisions, and local activity data remain on your device unless a specific feature sends data elsewhere. The desktop signing key is encrypted at rest through the operating system keychain.

### Encrypted peer transport

Between Antseed nodes, the preferred transport is a mutually authenticated encrypted TCP channel using wallet-signed ephemeral keys. **WebRTC DataChannels are a fallback** for peers that advertise WebRTC but cannot use direct encrypted TCP. WebRTC is not the primary transport for normal node-to-node AI VPN traffic.

See the [Transport specification](/docs/transport) for handshake, encryption, framing, and fallback details. For background on the fallback technology, see [WebRTC data channels on MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

### TEE availability and seller-node verification

In **Models**, choose **TEE advertised** from the seller filter to browse models with sellers advertising TEE attestation support. The models overview does not show TEE badges; individual sellers on model details show **TEE** only after verification passes. The same filter is available on each model's seller list and stays selected as you navigate during the app session.

While filtering, prices, savings, seller counts, and the Free filter reflect only matching offers, subject to the existing pricing eligibility rules. This is a **browsing filter only**: it does not change your selected seller, pins, automatic routing, or verification policy. Automatic routing may still select another seller. Use **Show all sellers** to see a selected seller hidden by the filter.

The **TEE advertised** filter matches advertised support for the `antseed-verifier` verifier, not a passing verification verdict. Sellers excluded by this filter have no recognized advertised support in the available metadata; that does not prove that they have no TEE.

AI VPN checks advertising sellers automatically after discovery, including newly discovered sellers. No Verify or Recheck button is needed. Checks run one at a time in the background while the window is visible, with at most one new check every two seconds. Scheduling retains a small retry record per discovered advertising seller and removes it when that seller leaves discovery; sellers beyond the buyer's 512-result cache limit remain eligible, with displayed sellers prioritized. Expired or evicted results refresh for displayed sellers; cache eviction alone does not repeatedly recheck sellers in the background. Request-time verification remains responsible for enforcing the routing policy.

On a model's seller list, a single **TEE** badge appears after the trusted verifier has passed both the seller-node TEE and seller-identity binding claims. Successful results are cached for display for up to **24 hours from the check**, without extending that deadline when viewed. This badge describes a recent seller-node check, not verification of each inference result. Background checks reuse the cached result. Routing separately accepts cached evidence for at most **five minutes**; the one-day display lifetime never extends routing authorization. A newer failed or unavailable check revokes the badge. The in-memory cache is discarded when the buyer restarts or the observed verifier capabilities change. Missing, expired, failed, unavailable, or in-progress checks show no badge; absence is not proof that the seller has no TEE.

Hover or keyboard-focus the badge for the tooltip: “We use TEEs to enhance user privacy.” There are no status messages, check buttons, or technical-details panels in the seller badge. The underlying checks, evidence, and routing enforcement are unchanged.

Unavailable checks retry with exponential backoff starting at 30 seconds, capped at five minutes. Sellers not being viewed receive at most three unavailable-check attempts per app/buyer session or observed capability change; returning to their model resumes retries. Automatic checks never select or pin sellers, install plugins, or change verification policy. A passing seller-node check **does not guarantee that downstream inference runs inside a TEE**; provider, GPU, and measured-image claims are not guaranteed by this badge.

There is no desktop verification routing setting. Automatic checks and the badge do not restart the buyer or change its policy. Existing CLI verification options remain available; see [Verify a seller's TEE](/docs/guides/verify-tee).

Desktop reads verification credentials from its configured buyer data directory, normally `~/.antseed`. When attaching to a buyer started with a custom `--data-dir`, set `ANTSEED_DESKTOP_CONNECT_DATA_DIR` to that same directory before launching desktop. Credentials are never searched for in other directories. Missing credentials leave the badge hidden and produce a runtime diagnostic; they can indicate an older buyer or a directory mismatch, not failed seller attestation. Repeated identical errors are logged once until verification communication succeeds again.

Trusted Execution Environments can add hardware-backed confidentiality when a seller offers a verifiable TEE route. Treat a TEE label as a claim to verify, not as sufficient proof by itself. Verification must bind the attestation to the running workload, seller identity, and expected configuration.

See [Verify a seller's TEE](/docs/guides/verify-tee), [Security](/docs/security), and Intel's [Trust Domain Extensions overview](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html).

## Credits and payments

Antseed is pay per use. Add credits once, then the AI VPN authorizes bounded payment channels with the sellers serving your requests. There is no Antseed subscription required for usage routed through the network.

### Add credits

Open **Profile** and choose **Add Credits**. The available funding methods can include card checkout or USDC transfers, depending on your location and the currently enabled providers.

Credits are USDC on Base held by the AntseedDeposits contract for your AI VPN signing identity. Circle publishes the official [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses); always verify the network and destination shown by the AI VPN before transferring funds.

### Payment channels and reserved funds

When a paid session starts, the AI VPN signs a capped authorization for one seller. Part of your available balance becomes **reserved** for that channel. Each request advances a cumulative spending authorization; the seller can settle only up to the latest amount you signed.

Reserved balance is still yours. Any unspent amount returns to available balance when the channel settles or closes. If a seller disappears, the channel can enter an on-chain close process and release the remaining funds after the grace period.

Open **Profile → Activity** to view active channels, spending history, settlement state, and close actions. See [Payments](/docs/guides/payments) for the full buyer flow and Base contract addresses.

### Withdraw unused credits

Open **Profile** and choose **Withdraw unused credits**. Only available balance can be withdrawn immediately. Amounts reserved by active channels must be released through settlement or channel closure first.

### Signing identity and funding wallet

The AI VPN signing identity authorizes protocol messages and bounded channel spending. It does not need to hold funds in a normal wallet. A separate funding wallet can deposit USDC for that identity without giving the AI VPN control of the funding wallet.

See [Security: signing identity vs funding wallet](/docs/security#signing-identity-vs-funding-wallet) for the security boundaries.

## Rewards

Open **Rewards** in the left sidebar to see ANTS attributed to eligible network usage on the selected chain and access **Manage staking** in your browser. Availability, transferability, and claim behavior depend on the deployed emissions contracts and current network phase. Credit balance, usage statistics, and payment channels remain in **Profile**.

If claims are available, the AI VPN opens a secure browser flow for the authorized wallet signature. A displayed pending amount is not a promise of token value, future emissions, or permanent eligibility. See [Payments: ANTS token emissions](/docs/guides/payments#ants-token-emissions) and the [ANTS token overview](/ants-token).

## Use the local API

While the router is running, the AI VPN exposes a local API at `http://localhost:8377`. OpenAI-compatible clients commonly use `http://localhost:8377/v1` as their base URL, while Anthropic clients use the root URL and append `/v1/messages` themselves.

The proxy binds to your computer rather than exposing the API to your local network. Antseed does not require an API key for this local endpoint, although some clients require any non-empty placeholder such as `antseed` in their API-key field.

For Hermes, OpenClaw, Cursor, or another client running elsewhere, open **Agents**, expand **Define your internet-accessible Antseed endpoint**, and start ngrok or Cloudflare. The public endpoint requires its generated bearer key; see [Connect Agents](/docs/guides/agents) and [Public HTTPS Tunnels](/docs/guides/public-tunnels).

### Browse models with `/v1/models`

Request the model catalog before choosing a model id:

```bash
curl http://localhost:8377/v1/models
```

`GET /v1/models` is answered locally and is not billed. Its `data` array contains the model ids currently advertised across the network. Use one of those ids in the `model` field of a request. To list image services only:

```bash
curl 'http://localhost:8377/v1/models?type=images'
```

### Supported request endpoints

| Endpoint | Use |
|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions clients |
| `/v1/responses` | OpenAI Responses clients such as Codex |
| `/v1/messages` | Anthropic Messages clients such as Claude Code |
| `/v1/images/generations` | OpenAI-compatible image generation |
| `/v1/images/edits` | OpenAI-compatible multipart image editing |
| `/v1/messages/count_tokens` | Local Anthropic token counting; never routed or billed |

For example, send an OpenAI-compatible chat request using a model id returned by `/v1/models`:

```bash
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Select a model or seller through the API

The request's `model` field controls routing:

- `"model": "antseed"` follows the model or seller route currently selected in the AI VPN. Changing the AI VPN picker updates clients that use this alias without rewriting their configuration.
- `"model": "<modelId>"` uses automatic seller selection for that catalog model under your AI VPN Price + Trust preferences.
- `"model": "<peerId>@<modelId>"` hard-pins that request to one seller and disables automatic failover.

If no AI VPN route is selected, the `antseed` alias returns `no_default_route`. Use a concrete model id when you want a request to route independently of the AI VPN picker.

See [Using the API](/docs/guides/using-the-api) for SDK configuration, format translation, response headers, routing overrides, errors, and tool-specific examples.

## Troubleshooting

### No peers or models are listed

1. Confirm the Home power button is on and the status area is healthy.
2. Wait a few seconds for peer discovery.
3. Open **Models** and use **Refresh models**.
4. Check whether local security software is blocking the AI VPN's outbound or inbound network connections.
5. Click **Help** beside the credit balance, then open **Developer mode → Available peers** to inspect discovery directly.

Antseed prefers encrypted TCP for node-to-node traffic and can fall back to WebRTC for compatible peers. Do not troubleshoot the AI VPN as if WebRTC were its only transport.

### A connected app does not send requests

1. Disconnect and reconnect the app from **Connected apps**.
2. Restart the app if its row requests a restart.
3. Check that the app is not overriding the base URL or API settings written by the AI VPN.
4. Confirm the selected model is compatible with the app's API format.
5. Use the integration-specific guide from the [Integrations directory](/integrations).

### An app reports a certificate or SSL error

Open **Connected apps**, expand **HTTPS certificate**, and trust the current certificate. If an older Antseed certificate is still installed, trusting the current certificate replaces it. Restart the affected app afterward.

### Requests fail with payment errors

Open **Credits** and compare available balance with reserved balance. A new paid channel cannot open if there is not enough available balance for its capped authorization.

If a channel budget is exhausted during a session, the AI VPN normally settles it and opens another channel automatically. Retry a request once before changing configuration. Use **Activity** to inspect channels that remain open or are waiting for an on-chain close.

### “Model is not served by this peer”

The app sent a model that the selected seller does not currently advertise. Re-select the model in the AI VPN to synchronize the route. If the error persists, disconnect and reconnect the app so its configuration and model state are refreshed.

If the route is pinned, confirm that the pinned seller still offers that exact model. Remove the pin to allow automatic selection to choose another eligible seller.

### Responses are slow or time out

Seller performance and network paths vary. Open the model's seller list and try another eligible seller, or remove a hard seller pin so automatic routing can fail over after retryable failures.

Large prompts and attachments take longer to upload. The floating window activity pulse and **Activity** view help distinguish active transfer from a stalled request.

### Reserved credits remain unavailable

Open **Activity** and inspect the active channel. Request a cooperative close when the seller is reachable. If it is not, request an on-chain close and follow the displayed grace-period instructions before withdrawing the released balance.

### Collect diagnostics

Click **Help** beside the credit balance (or open **Profile → Help**), enable **Developer mode**, then use:

- **Live logs** for runtime events
- **Available peers** for discovered sellers and services
- **Connection details** for local router status
- **Configuration** for the effective runtime settings
- **Copy diagnostic report** for a versioned summary and recent logs

Review the report for secrets before posting it publicly.

## Get support

For usage questions, join the [Antseed Telegram community](https://t.me/antseed). For reproducible bugs, [open a GitHub issue](https://github.com/AntSeed/antseed/issues/new) with the AI VPN version, operating system, affected app, expected result, actual result, and a redacted diagnostic report.

Follow [Antseed on X](https://x.com/antseed) for release announcements, and review the project [changelog](https://github.com/AntSeed/antseed/blob/main/CHANGELOG.md) before reporting an issue that may already be fixed.
