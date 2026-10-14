---
title: Gateway and console
slug: /gateway
description: What the self-hosted Antseed gateway and its web console are, where to run them, and how organizations, workspaces, members and keys fit together.
---

# Gateway and console

The gateway is an API server you run yourself with `antseed gateway start`. It gives every person or app its own Antseed API key, checks budgets and routing policies on each request, and passes the request to a buyer that pays sellers on the Antseed network. It serves an OpenAI- and Anthropic-compatible API on port 8379 at `/v1`.

The **Gateway Console** is the web app the same gateway serves at `/console`. People sign in to it to create keys, fund wallets, set budgets and routing policies, chat with models and see what they spent. It is on by default; `--no-console` serves only the API.

There is no hosted Antseed account. The console, its sign-in, its data and the request path all live on your gateway: your gateway, your buyer and the sellers it pays. Sign-in uses passkeys, wallets, or an identity provider you configure yourself (see [Sign-in and access](/docs/gateway/sign-in)).

To set one up from scratch, follow the [quickstart](/docs/quickstart). Installation options are on [Install](/docs/install).

## Where to run it

| Where | Start it with | Good for | Limits |
|---|---|---|---|
| Your own computer | `antseed gateway start` | Trying it out, personal use | Keys only work while the computer is on. Other machines can't reach it, unless you listen on your network with `--host 0.0.0.0` (plain HTTP). |
| A Linux server | The [server installer](/docs/gateway/server) | Teams, CI, hosted tools: anything that should always work | Needs a small server with systemd and, for HTTPS, a domain name. |
| Your computer, behind a tunnel | `antseed tunnel start`, or **Agents → Internet-accessible endpoint** in the desktop app | A public HTTPS address without moving anything | Keys still stop working when the computer sleeps or goes offline. See [Public tunnels](/docs/tunnels). |

A tunnel also publishes the console, including the desktop app's tunnel. Claim it straight away, before anyone else can: in the desktop app, click **Claim console** in the **Internet-accessible endpoint** window; from the CLI, run `antseed gateway console-link` on the same computer and open the one-time link (see [Sign-in and access](/docs/gateway/sign-in#claim-the-console)).

You can start on your computer and move later: [Move a local gateway to a server](/docs/gateway/migrate) carries every key, member, workspace and wallet across.

## Organization, workspaces, members and keys

One gateway is one **organization**.

- **Workspaces** split the organization. Each workspace pays from its own **workspace wallet**, with its own deposits, payment channels, budgets and routing policy. Every organization has a **Default** workspace, which pays from the buyer's default wallet. Creating a workspace creates its wallet.
- **Members** are the people who sign in. Each has an organization role, and a role in each workspace they belong to.
- **API keys** belong to a workspace and usually to a member. Requests made with a key are paid from that workspace's wallet and count against the key's, its owner's and the workspace's budgets.

| Organization role | Can |
|---|---|
| **Owner** | Everything, including making other owners and authorizing a workspace's withdrawal wallet. An organization always keeps at least one owner. |
| **Admin** | Manage members, workspaces, budgets, the gateway-wide routing policy, presets, settings, management tokens and the audit log. Sees every workspace. Only an owner can invite an owner or change one. |
| **Member** | Open the workspaces they belong to, create and revoke their own keys there (up to a per-member limit you can set), and see their own usage. |

Inside a workspace, a member is either a workspace **admin**, who manages that workspace's keys, members, wallet and routing policy, or a plain **member**. Organization owners and admins act as admins in every workspace.

## A tour of the console

The first time someone opens the console, a short tour shows where everything is. Replay it from the account menu with **Take the tour**. The navigation shows only the pages your role can open:

- **Overview**: spend, budgets and warnings for the open workspace.
- **Chat**: talk to any model on the network, paid by your own key. See [Chat](/docs/gateway/chat).
- **Activity** and **Logs**: spend and requests by model, key and member, and a searchable request log. See [Logs, usage and audit](/docs/gateway/activity).
- **Keys**: create, limit and revoke API keys. See [API keys](/docs/gateway/api).
- **Presets**: named model configurations used as `@preset/<slug>`. See [Routing policies and presets](/docs/gateway/routing).
- **Wallet & Funding** and **Rewards**: add funds by card or USDC, the authorized wallet, and ANTS rewards. See [Funding](/docs/gateway/funding).
- **Providers** and **Models**: the sellers and models on the network, with copyable `<peerId>@<model>` ids. See [Models and providers](/docs/gateway/models).
- **Routing**: which sellers may serve requests, and a route preview. See [Routing policies and presets](/docs/gateway/routing).
- **Members** and **Workspaces**: invite people and organize them. See [Sign-in and access](/docs/gateway/sign-in) and [Budgets](/docs/gateway/budgets).
- **Audit log**: who changed what. See [Logs, usage and audit](/docs/gateway/activity).
- **Settings**: **General**, **Buyer**, **Observability**, **Management tokens** and **Sign-in**. See [Management API and observability](/docs/gateway/management-api).

The top bar of every page shows the gateway's API base URL with a copy button.

Everything the console manages can also be done from a shell on the gateway machine with `antseed gateway …`. See [CLI commands](/docs/commands).

Next: follow the [Quickstart](/docs/quickstart), or [run the gateway on a server](/docs/gateway/server).
