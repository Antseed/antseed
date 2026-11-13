---
slug: /desktop
title: Antseed Desktop
sidebar_label: Antseed Desktop
description: Use Antseed Desktop to run a local gateway, connect your AI tools to it, chat, add funds and troubleshoot.
---

# Antseed Desktop

Antseed Desktop runs an Antseed [gateway](/docs/gateway) on your computer and connects your AI tools to it. Each tool talks to the gateway with an API key, and the gateway routes requests to sellers on the network and pays them from your balance.

Usage, history, API keys, limits and routing policy live in the gateway's [Gateway Console](/docs/gateway), which the app opens in your browser. The app itself handles the gateway, your balance, your connected apps and a chat.

## The local gateway

The app starts a local gateway when it opens and stops it when it quits. It is the same gateway as `antseed gateway start`: its API is at `http://127.0.0.1:8379/v1` and its console at `http://127.0.0.1:8379/console`. The gateway supervises the buyer on port 8377 by default, or on `buyer.proxyPort` if you set one in your config.

The gateway uses the same `~/.antseed` data directory and wallet the app used before, so an existing balance carries over.

The app creates an API key named **Desktop** on the gateway and gives it to the chat and to your connected apps. Keys are sent as `Authorization: Bearer <key>`.

### Use a remote gateway instead

In **Settings → Gateway**, choose **Remote gateway** and enter the gateway's URL and an API key that gateway issued. The URL must use `https://`, except for an address on your own machine or private network. The app checks the gateway with that key before switching. Nothing runs locally then: the chat and connected apps use the remote gateway, and funding and keys are managed in that gateway's console.

### API keys

In **Settings → Gateway**:

- **A key per app** gives each connected app its own key, labelled `Desktop · <App>`, so the console shows usage per app. Off by default: every app shares the **Desktop** key.
- **Replace keys** revokes the app's keys, creates new ones and updates every connected app with them.

## Home

The app opens in one window you can resize, down to 920×600. Home has:

- **Anonymous / Private**, above the prompt. **Anonymous** (the default) routes to any seller your routing policy allows; sellers see a pseudonymous address, never your name or email. **Private** adds **TEE sellers only** to the owner routing policy of the app's **Desktop** key, so the chat and every app using that key go only to sellers that advertise TEE attestation, and the model pickers list only models a TEE seller serves. Other settings on that key's policy are kept, and the key's admin policy is never changed. With a remote gateway, set this in its console. See [Verify a seller's TEE](/docs/verify-tee) for what the attestation checks.
- **The prompt**, in the middle: pick a model and, optionally, a seller (only sellers your gateway's routing policy allows), type and press Enter to start a chat.
- **Use it with your agent** (also in **Agents & apps**, along with [connected apps](#connect-an-ai-app)): add Antseed's skills to an AI agent you already use, so it keeps its own model and calls Antseed only when you ask, for example "using Antseed, generate an image of…", "make a video of…" or "ask Kimi on Antseed for a second opinion". Select an agent (Claude Code, Codex, OpenCode, Pi, Hermes or Droid) to add the `antseed-ask`, `antseed-images` and `antseed-videos` skills to its skills folder; select it again to remove them. The skills use your gateway: its URL is written into them and its API key is saved in `~/.antseed/agent-skills.key`, readable only by you. Start a new agent session after adding them. **Copy for any agent** copies instructions with the gateway URL and key to paste into any other agent.

The sidebar has **New chat** (⌘N or Ctrl+N), your recent chats with search, your balance with **Add funds**, and **Settings**. The top right of each page has **Help** and **API keys**, which opens the Gateway Console in your browser.

### Claim the console

The first time, **API keys** opens the local gateway's one-time owner setup link. Add a passkey or connect a wallet there once; after that, sign in with it. See [Sign-in and access](/docs/gateway/sign-in).

## Rewards

**Rewards** shows the $ANTS your gateway's wallet earned from usage. Claiming needs the wallet's operator signature, so **View rewards in your gateway** opens the Gateway Console's Rewards page, where you claim and see each epoch.

## Add funds

Select your balance in the top bar, or **Add funds** in **Settings → Wallet**. Pay by card checkout, where available in your region, or send USDC on Base to the address or QR code shown, for example from an exchange withdrawal or another wallet. You do not need to own crypto beforehand. Usage is pay per request from your balance; there is no subscription.

For withdrawals and payment channels, use the Gateway Console; see [Funding](/docs/gateway/funding) and [Payments](/docs/payments).

## Connect an AI app

Open **Agents & apps** and connect a detected tool. The app edits the tool's own configuration file so it points at the gateway (base URL and a real API key) and lists the gateway's text models. Pick and switch models inside each tool, as you normally would.

- When a row shows **Restart**, restart the tool before testing.
- **Disconnect** restores the tool's original configuration.
- With the local gateway, the app removes its changes when it quits and applies them again at launch. With a remote gateway, the changes stay.
- **Zed** keeps API keys in its keychain, so the app can't add the key for you. Its row shows **Paste key in Zed** until you copy the key from Zed's settings here, paste it into the Antseed provider in Zed, and choose **I've pasted it**. The row asks again if the key or the gateway changes.
- **Claude Code** is not in this list: its model list only takes Claude-named models, so it can't offer the network's. If an earlier version connected it, the app restores its original settings. You can still add Antseed's skills to it under **Use it with your agent**.
- **Codex** gets its model list from a catalog the app writes next to its config. A Codex inside WSL keeps its own list.
- **Telegram Bot** lets you message the agent on your computer from your phone. Create a bot with [@BotFather](https://t.me/BotFather), paste its token in the **Telegram Bot** row, then open the pairing link; the bot answers only you. It uses `/new`, `/model` and `/stop`, asks you in Telegram before running a tool, and only answers while the app is open. Its chats are billed like any chat in the app and follow your Anonymous or Private choice.
- **Claude Desktop** is no longer supported: its model picker only lists Claude's own model names, so it cannot offer the network's models. If an earlier version connected it, the app restores Claude Desktop's original configuration at launch.

### Use with any other tool

The **Use with any other tool** card copies the gateway's base URL (ending in `/v1`) and an API key, for any tool that speaks the OpenAI or Anthropic API. See [Gateway API](/docs/gateway/api) and the [Integrations directory](/integrations).

## Chat

Open **Chat** to talk to network models without another tool. The chat is a plain client of the gateway: it uses the same base URL and key, and its model dropdown lists the gateway's models from `/v1/models`.

## Settings

**Settings** is at the bottom of the sidebar:

- **Gateway**: local or remote gateway, **A key per app** and **Replace keys**.
- **Wallet**: **Add funds**, back up or import the signer key, and codes for the [staked free tier](/docs/staked-free-tier).
- **Privacy**, **Appearance** and **Help**.

## Updating from an earlier version

The first launch after the update:

- re-points apps you had connected to the gateway, with the new key,
- restores the operating system's proxy setting if an earlier version left it pointing at its system proxy (`127.0.0.1:8378`).

The floating window and the thin window, the HTTPS interception and **Add custom app**, the **Internet-accessible endpoint** and **Agents**, staking, the **Models** and model pages, **Peers**, **Activity**, **Profile** and the power button were removed. Seller routing preferences (minimum trust, price, allow and block lists) are now the gateway's routing policy, set in the Gateway Console. Connected tools no longer follow a model or seller picked in the app; choose the model in each tool. Chats in the app keep their model, and a chat that was pinned to a seller before the update keeps that seller.

## Privacy

There is no Antseed account or platform API key. Sellers see a pseudonymous peer address, not your name or email, but a standard seller can read the prompts it serves. Your configuration, signing key (encrypted with the operating system keychain) and connected-app setup stay on your device. Traffic between nodes is encrypted; see [Transport](/docs/transport) and [Security](/docs/security).

## Troubleshooting

### A connected app sends no requests

1. Check the gateway status at the bottom of the window.
2. Disconnect and reconnect the app in **Agents & apps**.
3. Restart it if its row shows **Restart**.
4. Check that the tool is not overriding the base URL or API key the app wrote.
5. Check that the model you picked in the tool supports the tool's API format.

### A key stopped working

Select **Replace keys** in **Settings → Gateway**. With a remote gateway, check that the key is still active in that gateway's console.

### Usage, limits or routing

Open **API keys**. Usage, history, per-key limits and routing policy are in the Gateway Console.

## Get support

Ask in the [Antseed Telegram community](https://t.me/antseed). For bugs, [open a GitHub issue](https://github.com/Antseed/antseed/issues/new) with the app version, operating system, affected tool, what you expected, what happened, and a redacted diagnostic report.
