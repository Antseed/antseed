---
slug: /desktop
title: Desktop app (AI VPN)
sidebar_label: Desktop app
description: Use the Antseed desktop app to pick models and sellers, connect local AI tools, chat, add credits and troubleshoot.
---

# Desktop app (AI VPN)

The desktop app (AI VPN) runs an Antseed buyer on your computer and puts a UI on it. Your AI tools connect to one local endpoint, and the app picks a seller for each request, pays it from your credits, and lets you change models without reconfiguring every tool.

:::tip Desktop app or Gateway Console?
Use the desktop app when one person wants a UI and one-click setup for coding tools on their own computer. Use the [Gateway Console](/docs/quickstart) when you need API keys, budgets per person or app, usage logs, or access from other machines. Both run the same buyer.
:::

## Start the router

Open **AI VPN** in the sidebar and use the power button to start or stop the local router. When it runs, the status area shows network health, the local proxy port, and how many peers and services are visible.

Discovery takes a few seconds. If **Models** is still empty, open it and select **Refresh models**.

## Choose a model and seller

Open **Models** to browse what sellers currently offer, with live prices and expected savings where a retail comparison exists. Selecting a model sets the route for new sessions; existing conversations keep theirs.

On a model's page, leave **Auto select seller** on to let the app pick the cheapest seller that passes your minimum trust score (trust only breaks ties, and sellers that recently failed are tried last), and fail over after retryable errors. Select a seller to pin it instead. A pin is hard: it never fails over, so remove it before troubleshooting availability.

A seller's trust score is a routing input, not a guarantee of quality, privacy or availability. See [Reputation](/docs/reputation).

## Set routing preferences

Select **Settings** in the header to open **Preferences**:

- **Auto select seller** turns automatic seller selection on or off.
- **Prefer free peers when available** gives zero-cost offers a strong ranking advantage.
- **Minimum trust score** excludes sellers below the threshold.
- **Price preference** ranks offers above your preferred input price lower.

These preferences are saved to the same buyer config the CLI uses, so connected apps, the in-app chat and direct API calls all follow them. See [Buyer configuration](/docs/buyer-config#routing-preferences).

## Chat

Open **Chat** to talk to network models without another tool. The model picker in the chat header controls the current conversation. If it already has messages, the app asks whether to continue on the new model or start a new chat. **View chats** opens your conversation list.

## Connect an AI app

Open **Apps** (the **Connected apps** page) and connect a detected tool. Depending on the tool, the app either edits its configuration file or routes its API traffic through the local proxy. The tool keeps its normal interface.

- When a row shows **Restart**, restart the tool before testing.
- The gear on a row lets you choose which installed application opens, set the client names used to attribute conversations, or remove the integration. Disconnecting restores the configuration the app changed.
- Some tools need HTTPS interception. For those, the app creates a local certificate authority whose private key never leaves your computer. If a tool reports a certificate error, expand **HTTPS certificate**, trust the current certificate and restart the tool.

Tool-specific guides are in the [Integrations directory](/integrations).

### Conversations from connected apps

Requests from connected apps appear under **Recent chats** on the home screen and in **Connected apps**. Each conversation keeps the model that served it, so two sessions of the same tool can use different models. Open a conversation to:

- change only that conversation's model,
- leave **Auto select seller** on, or pin one seller for that conversation only,
- rename it, open the app it belongs to, or delete its entry. An active tool session reappears on its next request.

## Floating window

The floating window stays above other apps and shows your balance, the active model, and token and cost activity. Its dot is red when routing is stopped and pulses while traffic flows. From its menu you can change the default model, change one conversation's model, or open the app behind a conversation. Closing it does not stop the router.

In **Preferences → Floating window**, **Show on traffic** opens it when a connected app starts sending requests, and **Show routed peer** shows which seller served each conversation.

## Use the local API

While the router runs, the app serves the local buyer API at `http://localhost:8377/v1`. Send `"model": "antseed"` to follow the model picked in the app, a model id for automatic routing, or `<peerId>@<model>` to pin a seller. See [Use the local buyer proxy](/docs/api) for endpoints, headers and examples.

For agents or clients on other machines, open **Agents** and set up an **Internet-accessible endpoint**; see [Tunnels](/docs/tunnels) and [Connect agents](/docs/agents). The endpoint also publishes a Gateway Console at `/console`. Claim it straight away: while the tunnel runs, the endpoint window shows **Gateway console** under **Connection details**; click **Claim console** to open a one-time setup link in your browser, then register a passkey or connect a wallet. Once claimed, the same row shows **Open console**. From the CLI, `antseed gateway console-link` on the same computer does the same. The console's **Settings → General → Updates** shows the app's version, and **Update** there has the app download the newest release and restart into it, so you can update it from another machine. The console is unreachable while the app restarts.

## TEE sellers

In **Models**, choose **TEE advertised** in the seller filter to see only sellers that advertise TEE attestation. This only filters the list; it does not change routing. On a model's seller list, a **TEE** badge appears after your buyer has checked that seller and the check passed. The app runs these checks in the background. See [Verify a seller's TEE](/docs/verify-tee) for what the badge means and how to require verification.

## Privacy

There is no Antseed account or platform API key. Sellers see a pseudonymous peer address, not your name or email, but a standard seller can read the prompts it serves. Your configuration, signing key (encrypted with the operating system keychain), connected-app setup and activity stay on your device. Traffic between nodes is encrypted; see [Transport](/docs/transport) and [Security](/docs/security).

## Credits and payments

Usage is pay per request from your credits. There is no subscription.

### Add credits

Open **Profile** and select **Add Credits**, or select the balance in the header. Pay by card checkout, where available in your region, or send USDC on Base to the address or QR code shown. One credit is one USDC, held for your app's identity in the Antseed deposits contract.

### Payment channels

When a paid session starts, the app signs a capped authorization for one seller and that amount shows as **reserved**. Each request raises a running total you sign; the seller can only settle up to that total. Unspent reserve returns to your available balance when the channel settles or closes. See [Payments](/docs/payments) for the protocol details.

In **Profile**, the **Payment channels** card opens **Activity**, which lists channels, spending history and close actions.

### Withdraw

Open **Profile** and select **Withdraw unused credits**. Only available balance can be withdrawn; reserved amounts are released when their channels settle or close.

## Rewards

Open **Rewards** to see ANTS attributed to your usage and to open **Manage staking** in your browser. A pending amount is not a promise of value or future eligibility. See [Recognized usage](/docs/recognized-usage).

## Troubleshooting

### No peers or models

1. Check that the router is on and the status area is healthy.
2. Wait a few seconds, then select **Refresh models** in **Models**.
3. Check that security software is not blocking the app's network connections.
4. Select **Help** in the header, enable **Developer mode**, and open **Available peers** to inspect discovery.

### A connected app sends no requests

1. Disconnect and reconnect it in **Connected apps**.
2. Restart it if its row shows **Restart**.
3. Check that the tool is not overriding the base URL or API settings the app wrote.
4. Check that the selected model supports the tool's API format.

### Payment errors

Open **Profile** and compare available and reserved balance. A new channel cannot open without enough available balance for its cap. Use **Activity** to close channels that stay open.

### "Model is not served by this peer"

The tool sent a model the selected seller no longer offers. Select the model again in the app, or remove the seller pin so automatic routing can choose another seller.

### Slow or timed-out responses

Try another seller on the model's page, or remove a hard pin so automatic routing can fail over.

### Collect diagnostics

Select **Help**, enable **Developer mode**, and use **Live logs**, **Available peers**, **Connection details**, **Configuration** or **Copy diagnostic report**. Remove secrets from the report before posting it.

## Get support

Ask in the [Antseed Telegram community](https://t.me/antseed). For bugs, [open a GitHub issue](https://github.com/AntSeed/antseed/issues/new) with the app version, operating system, affected tool, what you expected, what happened, and a redacted diagnostic report.
