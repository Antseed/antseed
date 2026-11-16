---
title: Privacy Policy
description: Antseed Privacy Policy
slug: /privacy-policy
last_update:
  date: 2026-11-16
---

# Antseed - Privacy Policy

**Last Updated: November 16, 2026**

This Privacy Policy explains what information is collected when you use the Antseed websites (antseed.com and download.antseed.com), Antseed Desktop, the Antseed CLI (including the buyer proxy and the self-hosted gateway and its console), and the Antseed peer-to-peer protocol, and how that information is used. It should be read together with our [Terms of Service](/terms-of-service).

The short version:

- **There is no Antseed account.** We don't ask for your name or email to use the website, the desktop app or the CLI.
- **Product telemetry is opt-in and off by default.** The desktop app, the buyer and the gateway send no usage data unless you turn telemetry on. Section 2 explains how to turn it on or off and exactly what it sends.
- **Your prompts and responses never reach us.** They travel peer-to-peer to the provider that serves them.
- **We don't sell personal information.**

## 1. Websites

### antseed.com

antseed.com loads Google Tag Manager, which runs Google Analytics 4. This records standard analytics data: pages viewed, device and browser type, referral source, approximate location that Google derives from your IP address, and a few interaction events: download button clicks (`download_vpr`, with the platform the installer is for), "get started" clicks, and clicks on outbound links. Google Analytics sets cookies (such as `_ga`) for this. Tag Manager can also load other measurement tags configured in its container, such as advertising conversion tags. You can block these with your browser's cookie and tracker settings or the [Google Analytics Opt-out Browser Add-on](https://tools.google.com/dlpage/gaoptout).

Some pages show live public data, which your browser fetches directly from the Antseed network explorer (antscan.co), OpenRouter's public model and ranking APIs (openrouter.ai), and a public Base RPC endpoint (mainnet.base.org). Like any web request, these disclose your IP address to those services. The fetched data is cached in your browser's local storage.

### Installer downloads (download.antseed.com)

Desktop installers are served from download.antseed.com, a Cloudflare Worker. For each download it records which installer was requested (platform, architecture, file and release), the country Cloudflare reports for the request, your browser's or tool's user-agent string (first 100 characters), Cloudflare's verified-bot category if any, whether it was a partial (range) request, whether the transfer completed, the file size and how long it took. Events are named `download_started`, `download_completed`, `download_aborted` and `download_unresolved`.

These events are written to the Worker's logs and sent to the same Google Analytics 4 property as the website. When you click a download button on antseed.com, the link carries your Google Analytics client and session ids (read from the `_ga` cookies), so the download is attributed to your website visit; otherwise a random id is used. Your IP address is not included in these events. Cloudflare, as the network operator, processes connection data (including IP addresses) under [its own privacy policy](https://www.cloudflare.com/privacypolicy/).

You can download installers directly from [GitHub releases](https://github.com/Antseed/antseed/releases) instead.

## 2. Product telemetry (Desktop, buyer and gateway)

Product telemetry is **opt-in and off by default** in every Antseed product. Nothing is sent until you turn it on, and turning it off stops it immediately.

### How to turn it on or off

- **Antseed Desktop:** Preferences → Privacy → Product telemetry. The switch also covers the buyer the desktop runs.
- **CLI buyer and gateway:** `antseed telemetry enable`, `antseed telemetry disable`, and `antseed telemetry status` (shows whether it is on and why). This sets `telemetry.enabled` in your config file; only an explicit `true` sends anything.
- **Gateway console:** Settings → Privacy → Product telemetry (organization owners and admins). It changes the same setting for the gateway and its buyer.
- **Any product:** setting `DO_NOT_TRACK=1` or `ANTSEED_TELEMETRY=0` in the environment always turns telemetry off. Antseed Desktop also honors `TELEMETRY_ENABLED=false`.

Telemetry is also always off in development builds, in CI environments, and in builds from source (including `nix build`), which contain no telemetry destination.

### Where it goes and how it is identified

When on, events are sent over HTTPS to PostHog, our product analytics provider. Each event is associated with your buyer wallet's public on-chain address. Each launch also gets a random session id, and each request a random request id. Every event disables PostHog's location lookup from your IP address (`$geoip_disable`) and its person profiles. Like any HTTPS request, the upload itself discloses your IP address to PostHog. If no wallet is loaded, nothing is sent.

Every event carries the product (desktop, gateway or buyer), app version, operating system, CPU architecture and install method (for example `dmg`, `npm` or `nix`).

### What is sent when it is on

- **Antseed Desktop:** its own screens and setup funnel: first open and each launch, how long the network, peer discovery and first model took to appear, fixed product actions from a predefined list (for example opening chat or connecting an app, never typed text or arbitrary clicks), setup completion, steps of the add-credits flow and the funding method chosen, deposit milestones and amounts in coarse buckets, the first chat, model selections (as a public model id from a reviewed list), chat request outcomes with fixed failure categories and coarse timing buckets, discovery failures, and whether the app closed cleanly or crashed.
- **Buyer** (whichever runs it: the desktop, the gateway, or `antseed buyer start`): when it starts, deposits credited (in amount buckets), and one event per model request with its API protocol, public model id, routing mode, the coding tool or connected app that sent it (from a fixed list, otherwise `custom`), the outcome and a fixed failure reason, HTTP status, attempt and fallback counts, exact timings in milliseconds, exact input, cached input and output token counts as the seller reported them, an estimated cost at the seller's listed price, why the answer ended (for example `stop` or `length`), the conversation turn number in buckets, and the public peer id of each seller the request was sent to.
- **Gateway:** only its setup funnel, one step name at a time: gateway started, console claimed, workspace created, key created, member invited, invite accepted, signed in. Never the actor, target, details or IP address from the audit log.

### What is never sent

Prompts, chat messages or responses; files, attachments, file names or paths; API keys, gateway members, workspaces, end users, or their names, emails or labels; exact balances or deposit amounts; transaction hashes; raw error messages, logs, stack traces, command lines, environment variables or config values; peer ids other than the sellers a request was sent to; location; session recordings, screenshots or automatic click capture.

Every property passes a strict allowlist on your device before it is queued: unknown properties are dropped, strings are truncated, and numbers are bounded. The full list of events and properties is published in the repository at [docs/telemetry.md](https://github.com/Antseed/antseed/blob/main/docs/telemetry.md).

Sellers (the `antseed seller` side) send no product telemetry.

## 3. Antseed Desktop and the CLI on your device

Antseed Desktop and the CLI run locally on your machine.

- **Keys and credentials.** Your wallet key is stored on your device. Antseed Desktop encrypts it with your operating system's secure storage; the CLI keeps it in its data directory, optionally encrypted with a passphrase. API keys and bot tokens you configure stay on your device. None of these are sent to us.
- **Local history.** Desktop chats are stored in the app's data folder (by default `~/.antseed/chat`). The buyer keeps a local list of conversations from connected tools (`conversations.json` in its data directory), including each conversation's first prompt as a label, plus local records of usage and payments. These stay on your device.
- **Update checks.** Antseed Desktop checks GitHub releases for updates periodically, and the CLI (including running buyers, sellers and gateways) checks the npm registry every 30 minutes. These requests disclose your IP address to GitHub and npm, under their own privacy policies.
- **Network and blockchain reads.** The software reads public data: peer discovery through Antseed's DHT bootstrap nodes (dht1.antseed.com, dht2.antseed.com), connectivity checks through Google's public STUN servers, Base blockchain reads through public RPC providers (by default base.gateway.tenderly.co, with base.drpc.org, base-public.nodies.app and mainnet.base.org as fallbacks), and public network statistics from network.antseed.com and antscan.co. These requests disclose your IP address, and blockchain reads disclose which wallet addresses are being looked up.
- **Voice input.** Desktop voice transcription runs locally with whisper.cpp. The speech model is downloaded once from Hugging Face; your audio is not uploaded.
- **Optional integrations.** If you connect a Telegram bot, the desktop exchanges messages with Telegram's Bot API using your bot token. If you use the desktop with a remote gateway, your requests go to that gateway and its operator (see section 4).

## 4. Self-hosted gateway and console

The Antseed gateway and its console are software you, or your organization, run yourself (`antseed gateway start`). There is no hosted Antseed account: the console, its sign-in, its data and the request path all live on the gateway's own server. **The gateway's operator, not Antseed, controls this data.** If you use a gateway someone else runs, ask its operator how they handle your data.

On the gateway's own machine, the console stores:

- Members: name, an optional email, organization and workspace roles, and how they sign in (passkeys, wallet sign-in, or an identity provider the operator configures, such as Google or Cloudflare Access). API keys, management tokens, invite and recovery links, and sessions are stored only as SHA-256 hashes.
- A request log: model, key, end user (if the client sends one), provider peer id, status, timings, token counts and cost. Request and response bodies are not stored unless an organization admin turns on content logging; admins can also set a retention period.
- An audit log of who changed what, with the time, the actor and their IP address.
- Console chats, and deposit records, including the name and email of whoever approves a deposit.

Depending on the operator's settings, the gateway may also send request traces to an OpenTelemetry endpoint the operator chooses, or settle key top-ups through an x402 facilitator the operator configures (such as Coinbase CDP or PayAI). These are off unless the operator sets them up.

## 5. Funding

You can fund a buyer wallet by card or with USDC on Base. You don't need to own cryptocurrency already.

- **Card checkout (Antseed Pay).** The desktop app and the gateway console open Antseed's hosted pay page (antseed-pay.com) with a signed link containing your buyer wallet address, the currency (USD) and the amount. The card payment itself is handled by **Crossmint**, or by **Outerfound, powered by Stripe** (US only), which receive your payment details under their own privacy policies. The purchased USDC is delivered on Base to your wallet. Card checkout is not available in every region.
- **Meridian.** Opens Meridian's page (antseed.mrdn.finance) with your buyer wallet address, to deposit USDC from other chains.
- **Peer Pay.** The desktop app sends a signed request with your wallet address and amount to the Peer Pay checkout service (antseed-checkout.pay.zkp2p.xyz) and opens the checkout it returns.
- **USDC on Base.** You send USDC to your wallet address from any wallet or exchange; this involves only the blockchain and the wallet or exchange you use.

## 6. The protocol

Antseed is a peer-to-peer network. This design means:

- **Providers see what they serve.** When you send a request, the provider (seller) peer that serves it receives the request content, such as your prompt, in order to process it, and may pass it to upstream services it uses. Providers also see your peer id and the network address you connect from. How a provider handles your data is up to that provider, as with any AI service; choose providers accordingly.
- **Connections are encrypted.** Peers connect over WebRTC (DTLS) or an encrypted TCP transport. Older peer software that does not support encryption may still connect over plain TCP.
- **Peer identifiers are pseudonymous.** Peers are identified by their on-chain wallet addresses, not names or emails.
- **Payments are on-chain.** Deposits, payment channels and settlements happen on the Base blockchain. Like all blockchain transactions, they are public, permanent and linkable to the addresses involved, including which buyer paid which seller and how much. Request content never goes on-chain.

## 7. What we share

We do not sell personal information. Data is processed by the services named above, each under its own privacy policy: Google (website analytics and Tag Manager), Cloudflare (download delivery), PostHog (opt-in product telemetry), GitHub and npm (releases and update checks), and the payment providers you choose to use. Aggregate, non-identifying statistics (such as total downloads or network usage) may be published.

## 8. Data retention

Website analytics and download events are kept according to our Google Analytics settings and Google's retention controls. Opt-in product telemetry is kept according to our PostHog project settings. Data stored by the desktop app, the CLI or a self-hosted gateway stays on that device or server until you or its operator delete it.

## 9. Your choices and rights

Depending on where you live (for example under the GDPR or CCPA), you may have rights to access, correct or delete personal data. Because we don't operate accounts, the data we hold is limited to website analytics, download events and, if you turned it on, product telemetry tied to your wallet address. For any privacy question or request, email legal@antseed.com (include your wallet address for telemetry requests) or open an issue at [github.com/Antseed/antseed](https://github.com/Antseed/antseed/issues).

You can also turn product telemetry off at any time (section 2), browse with cookies disabled or cleared, and download installers directly from GitHub.

## 10. Children

The Services are not directed at children under 16, and we do not knowingly collect personal information from them.

## 11. Changes

We will update this policy as the Services change and update the "Last Updated" date above.
