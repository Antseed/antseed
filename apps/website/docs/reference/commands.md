---
title: CLI commands
slug: /commands
description: Every antseed command, grouped by task, with its purpose and the flags you use most.
sidebar_label: Commands
---

# CLI commands

Every command accepts the [global flags](/docs/flags) (`--config`, `--data-dir`, `--verbose`) and `--help`. Run `antseed <command> --help` for the full flag list of any command. Most commands that print data accept `--json`.

You normally configure a node once (`antseed seller setup`, `antseed config …`) and then start it with `antseed buyer start`, `antseed gateway start` or `antseed seller start` without repeating flags. Secrets such as upstream API keys stay in environment variables; everything else lives in `~/.antseed/config.json`.

## Buyer

Run the local buyer proxy (port 8377) that pays sellers. Guides: [Local buyer API](/docs/api), [Buyer configuration](/docs/buyer-config).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed buyer start` | Start the buyer proxy and connect to sellers | See [buyer start flags](/docs/flags#buyer-start-flags) |
| `antseed buyer status` | Show connection status and balance | `--json` |
| `antseed buyer connection get` | Show the running buyer's session peer pin | |
| `antseed buyer connection set` | Pin every request on the running buyer to one seller | `--peer <peerId>` |
| `antseed buyer connection clear` | Clear the session peer pin | |
| `antseed buyer identity create <name>` | Create an extra buyer identity with its own wallet | `--key-from env:<VAR>` or `--key-from file:<path>` |
| `antseed buyer identity list` | List buyer identities | `--balances`, `--json` |
| `antseed buyer identity protect [name]` | Encrypt stored wallet keys with `ANTSEED_PASSPHRASE` (at least 12 characters) | `--all` |
| `antseed buyer identity unprotect [name]` | Store encrypted wallet keys as plaintext again | `--all`, `--yes` |
| `antseed buyer identity remove <name>` | Stop using an identity; its key is archived, not deleted | |
| `antseed buyer activity` | Tokens, spending history, savings, active channels and claimable ANTS | `--days 7\|30\|90`, `--json` |
| `antseed buyer metering` | Channel and usage stats from the local database | `--peer <peerId>`, `--json` |

</CommandTable>

A running buyer can pay as any identity; select one per request with the `x-antseed-buyer-identity` header.

## Gateway

Serve the buyer API to many users with API keys, spend limits, routing policies and the Gateway Console (API on port 8379, console at `/console`). Guides: [Gateway](/docs/gateway), [API keys](/docs/gateway/api), [Budgets](/docs/gateway/budgets), [Routing](/docs/gateway/routing), [Sign-in](/docs/gateway/sign-in), [Activity](/docs/gateway/activity), [Migrate to a server](/docs/gateway/migrate), [Wallet keys](/docs/gateway/wallet-keys), [Management API](/docs/gateway/management-api).

### Run and sign in

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway start` | Run the gateway and its console locally; also starts a buyer | `--port` (8379), `--host` (127.0.0.1), `--public-url <url>`, `--no-buyer`, `--buyer-port`, `--no-console`, `--x402-facilitator <url\|cdp\|payai>`, `--topup-min-usd` (2), `--topup-max-usd` (500) |
| `antseed gateway console-link` | Print the one-time owner setup link, or the console URL once it has an owner | `--recover`, `--member <id\|email>`, `--public-url`, `--port` |
| `antseed gateway peers` | Sellers the running buyer knows, with trust, TEE, prices and this gateway's 24 h stats | `--model <id>`, `--tee` |
| `antseed gateway settings show` | Show buyer and observability settings | `--reveal` |
| `antseed gateway settings set-buyer` | Change buyer settings (price caps, allow/block lists, verifiers, RPC, timeouts) | `--max-input-price`, `--max-output-price`, `--min-trust`, `--allow-peer`, `--block-peer`, `--auto-sweep on\|off`, `--rpc-url` |
| `antseed gateway settings set-observability` | Change OTLP export, content logging and log retention | `--otlp-endpoint`, `--otlp-header name=value`, `--log-content on\|off`, `--retention-days` |

</CommandTable>

### API keys

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway key create` | Create an API key; the secret is shown once | `--label`, `--workspace`, `--owner <member>`, `--identity <name>`, `--new-identity [name]`, `--daily-limit`, `--weekly-limit`, `--monthly-limit`, `--total-limit`, `--expires-in-days`, `--allow-topup` |
| `antseed gateway key list` | List keys with spend and limits | `--all`, `--workspace`, `--member` |
| `antseed gateway key show <id>` | Show a key's usage, both limit layers and policies | |
| `antseed gateway key limits <id>` | Change a key's admin-layer spend caps (`none` removes one) | `--daily-limit`, `--weekly-limit`, `--monthly-limit`, `--total-limit` |
| `antseed gateway key update <id>` | Change label, admin and owner limits, expiry, owner or top-ups | `--owner-daily-limit`, `--owner-weekly-limit`, `--owner-monthly-limit`, `--owner-total-limit`, `--owner <member\|none>`, `--expires-in-days`, `--no-expiry`, `--topup on\|off` |
| `antseed gateway key topup <id> on\|off` | Allow or stop x402 top-ups of the key's wallet | |
| `antseed gateway key rotate <id>` | Issue a new secret; the old one stops working | |
| `antseed gateway key revoke <id>` | Revoke a key immediately | |
| `antseed gateway key policy show <id>` | Show both policy layers and the effective policy | `--preset <slug>` |
| `antseed gateway key policy set <id>` | Set a key's routing policy | `--layer admin\|owner`, [policy flags](#routing-policy-flags) |
| `antseed gateway key policy clear <id>` | Remove a key's policy at one layer | `--layer admin\|owner` |

</CommandTable>

### Members and management tokens

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway member invite` | Print a single-use invite link | `--label`, `--email`, `--role member\|admin\|owner`, `--workspace <id\|name[:admin]>`, `--expires-in-hours` (72) |
| `antseed gateway member invites` | List open invites | |
| `antseed gateway member cancel-invite <inviteId>` | Cancel an open invite | |
| `antseed gateway member list` | List console members | |
| `antseed gateway member show <member>` | Show role, workspaces, limits, key quota, policy and sign-in methods | |
| `antseed gateway member update <member>` | Change name, email, org role, spend caps across their keys, key quota | `--role`, `--max-keys`, `--daily-limit`, `--monthly-limit`, `--total-limit` |
| `antseed gateway member policy show\|set\|clear <member>` | A member's routing policy, applied to every key they own | [policy flags](#routing-policy-flags) |
| `antseed gateway member disable <member>` | End their sessions and revoke the keys they own | |
| `antseed gateway member enable <member>` | Re-enable a member (revoked keys stay revoked) | |
| `antseed gateway member credentials list <member>` | List a member's sign-in methods | |
| `antseed gateway member credentials remove <member> <credentialId>` | Remove a sign-in method and end their sessions | `--allow-last` |
| `antseed gateway admin-token create` | Create a management token for `/console/api` | `--label`, `--scope read\|admin`, `--expires-in-days` (90, max 365), `--no-expiry` |
| `antseed gateway admin-token list` | List active management tokens | |
| `antseed gateway admin-token revoke <id>` | Revoke a management token | |

</CommandTable>

### Workspaces

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway workspace list` | List workspaces with wallets, members, keys and budgets | |
| `antseed gateway workspace create` | Create a workspace with a new wallet, or an existing identity | `--name`, `--identity`, `--daily-limit`, `--weekly-limit`, `--monthly-limit`, `--total-limit` |
| `antseed gateway workspace show <workspace>` | Show wallet, budgets, spend, policies and members | |
| `antseed gateway workspace update <workspace>` | Rename a workspace or change its budgets | `--name`, `--daily-limit`, `--monthly-limit`, `--total-limit` |
| `antseed gateway workspace delete <workspace>` | Delete a workspace with no active keys or funds | |
| `antseed gateway workspace policy show\|set\|clear <workspace>` | Workspace routing policies | `--layer workspace\|org`, [policy flags](#routing-policy-flags) |
| `antseed gateway workspace member list <workspace>` | List a workspace's members and roles | |
| `antseed gateway workspace member add <workspace> <member>` | Add a member | `--role admin\|member` |
| `antseed gateway workspace member role <workspace> <member> <role>` | Change a member's workspace role | |
| `antseed gateway workspace member remove <workspace> <member>` | Remove a member; their keys in it are revoked | |
| `antseed gateway workspace operator show <workspace>` | Show the workspace wallet's authorized wallet, read from the chain | |
| `antseed gateway workspace operator authorize <workspace> [address]` | Sign the authorization for an authorized wallet, or open the wallet page | `--browser`, `--no-open`, `--yes` |
| `antseed gateway workspace operator transfer <workspace> [address]` | Hand the authorized-wallet role on (the workspace wallet pays gas) | `--clear`, `--yes` |

</CommandTable>

### Routing, peer lists and presets

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway routing show` | Show the gateway default policy, or the effective policy for a key, workspace, member or preset | `--key`, `--workspace`, `--member`, `--preset` |
| `antseed gateway routing set` | Set the gateway default policy every key inherits | [policy flags](#routing-policy-flags) |
| `antseed gateway routing clear` | Remove the gateway default policy | |
| `antseed gateway routing preview` | Rank the sellers a request would route to, with exclusion reasons | `--model <peerId@model>`, `--key`, `--workspace`, `--member`, `--preset`, `--all` |
| `antseed gateway peer-list list` | List named seller lists | |
| `antseed gateway peer-list show <list>` | Show a list's sellers | |
| `antseed gateway peer-list create` | Create a seller list | `--name`, `--description`, `--peer <peerId>` |
| `antseed gateway peer-list update <list>` | Rename, describe or replace a list's sellers | `--name`, `--description`, `--peers` |
| `antseed gateway peer-list add\|remove <list> <peerIds...>` | Add or remove sellers | `--confirm-empty` |
| `antseed gateway peer-list delete <list>` | Delete a list | `--confirm-empty` |
| `antseed gateway preset list` | List presets | `--workspace` |
| `antseed gateway preset show <preset>` | Show a preset | `--workspace <id\|name\|org>` |
| `antseed gateway preset create` | Create a preset, called as model `@preset/<slug>` | `--slug`, `--name`, `--model`, `--workspace`, `--system-prompt`, `--system-prompt-file`, `--param key=value`, `--params-file`, [policy flags](#routing-policy-flags) |
| `antseed gateway preset update <preset>` | Change a preset | `--in-workspace`, `--slug`, `--name`, `--model`, `--clear-policy`, [policy flags](#routing-policy-flags) |
| `antseed gateway preset delete <preset>` | Delete a preset | `--workspace <id\|name\|org>` |

</CommandTable>

#### Routing policy flags

`key policy set`, `member policy set`, `workspace policy set`, `routing set` and `preset create|update` share these flags:

| Flag | Effect |
|---|---|
| `--file <path>` | Read the policy as JSON; other flags override its fields |
| `--merge` | Start from the current policy instead of replacing it |
| `--allow-peer <peerId>`, `--block-peer <peerId>` | Allow only, or never route to, a seller (repeatable) |
| `--allow-list <list>`, `--block-list <list>` | Allow only, or block, the sellers in a peer list (repeatable) |
| `--allow-model <model>` | Allow only these models (repeatable) |
| `--min-trust <score>`, `--min-reputation <score>` | Minimum seller trust score or reputation, 0–100 |
| `--max-input-price`, `--max-output-price`, `--max-cached-input-price` | Price caps in USD per million tokens |
| `--require-tee`, `--require-verified` | Only sellers advertising TEE attestation, or whose responses pass a verifier |
| `--prefer-free` | Rank free sellers first |
| `--sort balanced\|price\|latency\|trust` | How eligible sellers are ranked |
| `--confirm-empty`, `--accept-narrowed` | Save even if no seller could serve, or if levels above allow less |

### Usage, logs and moving a gateway

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed gateway usage` | Spend, requests and tokens over a period (default: last 30 days) | `--workspace`, `--key`, `--member`, `--model`, `--from`, `--to`, `--group-by day\|model\|key\|member\|peer\|workspace\|user` |
| `antseed gateway logs [list]` | Recent requests, newest first | `--status`, `--search`, `--limit` (50, max 200), `--before`, `--follow`, `--interval` (2000 ms) |
| `antseed gateway logs show <tag>` | One request in full, with bodies when content logging is on | |
| `antseed gateway audit` | Audit log of console and CLI changes | `--action <verb>`, `--actor <id>`, `--limit` (100, max 500) |
| `antseed gateway export` | Export the request log as CSV (never bodies) | `--output <file>`, same filters as `logs` |
| `antseed gateway export --out <file>` | Write the whole gateway to a password-encrypted bundle | `--password-file`, `--force` |
| `antseed gateway import <bundle>` | Restore a bundle into this machine's data dir (gateway and buyer stopped) | `--password-file`, `--public-url`, `--port`, `--force` |

</CommandTable>

## Tunnel

Publish the gateway (API and, by default, the console) through a public HTTPS tunnel endpoint. Guide: [Public tunnels](/docs/tunnels).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed tunnel start` | Expose the local gateway through an authenticated HTTPS tunnel | `--provider cloudflare\|ngrok`, `--gateway-port` (8379), `--buyer-port` (8377), `--no-buyer`, `--no-console` |
| `antseed tunnel status` | Show tunnel status | `--json` |
| `antseed tunnel stop` | Stop the tunnel | |

</CommandTable>

## Chat

Chat with an agent through a gateway from the terminal. Web search, web pages and scratch files run on the gateway, which keeps the history. Guide: [Console chat](/docs/gateway/chat).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed chat` | Start a terminal chat through a gateway | `--gateway <url>`, `--key <apiKey>`, `--workspace`, `--model <id>`, `--peer <peerId\|any>`, `--resume <threadId>`, `--history` |

</CommandTable>

## Apps and tool wrappers

Point local AI tools at the buyer proxy. Guides: [Desktop app](/docs/desktop), [Local buyer API](/docs/api).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed apps status` | List supported apps: installed, connected, config path | `--json` |
| `antseed apps connect <app>` | Point an app's config at the buyer proxy (backs up the original) | `--port <buyerPort>` |
| `antseed apps disconnect <app>` | Remove only what Antseed added to an app's config | |
| `antseed claude [args...]` | Run Claude Code through the buyer proxy | `--model <service-id>`, `--antseed-base-url <url>` |
| `antseed codex [args...]` | Run Codex through the buyer proxy | `--model <service-id>`, `--antseed-base-url <url>` |
| `antseed opencode [args...]` | Run OpenCode through the buyer proxy | `--model <service-id>`, `--antseed-base-url <url>` |
| `antseed system-proxy install-ca` | Generate and trust the local CA certificate | |
| `antseed system-proxy ca-trust-state` | Report whether the OS trusts the local CA (JSON) | |
| `antseed system-proxy start` | Start the local System Proxy | `--peer <peerId>`, `--default-model`, `--served-model`, `--port` (8378), `--buyer-port` (8377), `--profile`, `--system-proxy` |
| `antseed system-proxy stop` | Stop the System Proxy | |
| `antseed system-proxy status` | Show System Proxy status | |

</CommandTable>

The wrappers forward unknown flags to the tool. `--model` falls back to `ANTSEED_MODEL`.

## Seller

Offer AI services on the network. Guides: [Become a provider](/docs/provide), [Provider configuration](/docs/provide/config), [Monitoring](/docs/provide/monitoring).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed seller setup` | Interactive setup: configure a provider and add services | |
| `antseed seller start` | Start providing services | `--provider <names>`, `--input-usd-per-million`, `--output-usd-per-million`, `--reserve`, `--dht-port` (6881), `--signaling-port` (6882), `--min-settle-delta <usdc>`, `--base-rpc-url`, `--verifiers <ids>`, `--no-dashboard`, `--dashboard-port` (3120), `--skip-prereq-check` |
| `antseed seller status` | Show node status and readiness | `--json` |
| `antseed seller register` | Register your peer identity on-chain (ERC-8004) | `--agent-id <id>`, `--metadata <uri>` |
| `antseed seller doctor` | Diagnose the announced seller endpoint | `--timeout-ms` (3000), `--json` |
| `antseed seller dashboard` | Open the local seller dashboard: the running seller's, or one served by this command | `--port` (3120), `--host` (127.0.0.1), `--no-open` |
| `antseed seller events` | Recent seller events: starts and stops, models failing or recovered, gas, alerts | `--limit` (25), `--json` |
| `antseed seller usage` | Requests, tokens and revenue per UTC day | `--days` (14, up to 30), `--json` |
| `antseed seller logs` | Served requests, newest first, or everything kept about one request | `--limit` (50), `--cursor`, `--model`, `--buyer`, `--since <30m\|6h\|2d\|date>`, `--errors`, `--id <id>`, `--json` |
| `antseed seller market` | Your prices against other sellers of the same models | `--model <id>`, `--refresh`, `--json` |
| `antseed seller reputation` | Trust score, its parts, and on-chain standing | `--refresh`, `--json` |
| `antseed seller promote` | Promotion info and a shareable seller card | `--card <file>` (SVG), `--json` |
| `antseed seller verify` | Domain and GitHub identity claims | `--add-domain`, `--add-github <user[/repo]>`, `--remove <claim>`, `--check`, `--json` |
| `antseed seller settings` | Show the seller's settings | `--json` |
| `antseed seller settings set` | Change settings (validated; written to config.json, or saved over it in the data dir when it is read-only) | `--display-name`, `--max-buyers`, `--health <on\|off>`, `--health-interval`, `--health-failures`, `--gas <on\|off>`, `--gas-min <eth>`, `--free-per-address`, `--free-per-ip`, `--free-window-hours`, `--free-stakers-only`, `--free-stake-tiers`, `--model-free-tier`, `--countries`, `--price <[provider/]model=in/out[/cached]>`, `--unit-price <[provider/]model[match]=usd>`, `--model-off`, `--model-on`, `--json` |
| `antseed seller settings add-model <[provider/]model>` | Add a model billed by tokens under a configured provider | `--input`, `--output`, `--cached`, `--upstream`, `--categories`, `--json` |
| `antseed seller settings remove-model <[provider/]model>` | Remove a model from the config (use `set --model-off` to keep its settings) | `--json` |
| `antseed seller settings reset` | Remove the settings saved over a read-only config.json; it applies alone from the next restart | `--json` |
| `antseed seller alerts` | Where alerts go and their last delivery | `--json` |
| `antseed seller alerts set` | Configure Telegram and webhook alerts (secrets from stdin only) | `--telegram-token-stdin`, `--telegram-chat <id>`, `--clear-telegram-token`, `--webhook-url-stdin`, `--clear-webhook`, `--idle <minutes\|off>`, `--cooldown`, `--low-balance <usd\|off\|default>`, `--min-severity`, `--json` |
| `antseed seller alerts test` | Send a test alert | `--channel <telegram\|webhook>`, `--json` |
| `antseed seller alerts find-chat` | Find the Telegram chat id after messaging your bot | `--token-stdin`, `--json` |
| `antseed profile show` | Show your peer profile | |
| `antseed profile set` | Create or update your peer profile | `--name`, `--description`, `--tags`, `--capabilities`, `--region`, `--languages`, `--website` |

</CommandTable>

## Payments and channels

Fund the buyer and manage payment channels. Guides: [Gateway funding](/docs/gateway/funding), [Seller payouts](/docs/provide/payments), [Payments protocol](/docs/payments).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed buyer deposit` | Show your USDC funding address and QR code; incoming funds are deposited automatically (gasless) | `--amount <usdc>`, `--no-watch` |
| `antseed buyer deposit --onchain <usdc>` | Legacy: deposit directly from the buyer wallet (needs ETH for gas) | |
| `antseed buyer sweep` | Sweep wallet USDC into your deposits balance via relayers (fixed USDC fee) | `--amount <usdc>`, `--timeout` (120 s) |
| `antseed buyer balance` | Show your deposits balance | `--json` |
| `antseed buyer withdraw <amount>` | Withdraw USDC from the deposits contract | |
| `antseed buyer set-authorized-wallet` | Authorize an external wallet in the browser, or the buyer wallet itself | `--self`, `--no-open`, `--identity <name>` |
| `antseed buyer authorized-wallet-status` | Show the buyer's authorized wallet (operator) and nonce, read-only | `--json`, `--identity <n>` |
| `antseed buyer free-tier add <code>` | Add a free-tier code a staker created for this buyer in the ANTS dashboard | `--identity <name>` |
| `antseed buyer free-tier share` | Sign in the browser to share a wallet's ANTS stake with this buyer for staked free tiers | `--no-open`, `--identity <name>` |
| `antseed buyer free-tier list` | List the stakers sharing with this buyer and the stake each seller pool counts, with when it runs down | `--identity <name>`, `--no-stake` |
| `antseed buyer free-tier remove <staker>` | Stop sending a staker's delegation | `--identity <name>` |
| `antseed buyer channels [list]` | List payment channels from the local store | `--status active\|settled\|timeout\|ghost`, `--limit` (20) |
| `antseed buyer channels close <channelId>` | Ask the seller to close a channel now | `--no-auth` |
| `antseed buyer channels request-close <channelId>` | Start a timeout close so reserved funds can be withdrawn after the grace period | |
| `antseed buyer channels withdraw <channelId>` | Release reserved funds after the grace period | |
| `antseed payments` | Print the commands that replaced the retired payments portal | |

</CommandTable>

## Staking and ANTS

Stake ANTS and claim rewards. Guides: [Staking](/docs/provide/staking), [Recognized usage](/docs/recognized-usage), [Legacy emissions](/docs/legacy-emissions).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed ants` | Open the local ANTS staking dashboard | `--port` (3119), `--no-open`, `--address <address>` |
| `antseed ants status` | Protocol phase, epoch, balances, stake and claimable rewards | |
| `antseed ants positions` | List your lANTS staking positions | |
| `antseed ants stake <amount>` | Stake ANTS into a seller agent pool | `--agent <agentId>`, `--epochs <n>` (1 epoch = 1 week) |
| `antseed ants move <ids...>` | Move positions to another pool | `--to <agentId>` |
| `antseed ants split <id> <amount>` | Split ANTS out of a position | |
| `antseed ants merge <ids...>` | Merge positions with the same pool and lock end | |
| `antseed ants extend <id>` | Extend a lock | `--epochs <n>` |
| `antseed ants max-lock <id>` | Enable max lock on a position | `--off` |
| `antseed ants withdraw <ids...>` | Withdraw positions (early exits burn part of the principal) | `--preview`, `--accept-slashing`, `--yes` |
| `antseed ants rewards` | View rewards (staker, seller usage, buyer usage, legacy, locked) | |
| `antseed ants rewards claim` | Claim rewards into the wallet | `--staker`, `--seller`, `--buyer`, `--legacy`, `--locked`, `--recipient <address>` |
| `antseed ants rewards restake [ids...]` | Restake staker rewards into a new locked position | `--epochs <n>` |
| `antseed ants rewards compound` | Restake every restakable reward | `--epochs <n>`, `--to <agentId>` |
| `antseed ants rewards stake-usage` | Claim usage rewards straight into a locked position | `--side seller\|buyer`, `--epochs <n>`, `--agent <agentId>` |
| `antseed ants pools` | Compare seller pools | |
| `antseed ants pool <agentId>` | Show one seller pool | |
| `antseed ants usage` | Your usage points per epoch and network totals | `--epochs` (8) |
| `antseed ants emissions` | Emission schedule, gate buckets and reward shares | |
| `antseed ants addresses` | Contract addresses in use | |
| `antseed ants seller` | Seller staking state: identity binding, eligibility, starter grant | |
| `antseed ants seller register` | Bind your agent ID in the seller registry (same as `antseed seller register`) | `--agent-id <id>` |
| `antseed ants verify [seller]` | Wash-trading verification status | |
| `antseed ants verify submit <artifact>` | Stage, authenticate and finalize a seller proof (resumable) | `--yes` |
| `antseed ants verify proof <proofId>` | Show a proof's progress | |
| `antseed seller stake <amount>` | Stake ANTS into your own seller pool | `--epochs <n>` (required) |
| `antseed seller pool positions` | List your seller-pool positions | |
| `antseed seller pool withdraw <ids...>` | Withdraw seller-pool positions | `--accept-slashing`, `--yes` |
| `antseed seller rewards` | View all seller ANTS rewards | |
| `antseed seller rewards claim` | Claim all pending seller ANTS rewards | |
| `antseed buyer emissions info` | Current epoch and pending buyer emissions | `--legacy-only`, `--new-only` |
| `antseed buyer emissions claim` | Claim pending buyer ANTS emissions | `--legacy-only`, `--new-only` |

</CommandTable>

### Legacy

These commands apply only to the pre-upgrade USDC staking. See [Legacy emissions](/docs/legacy-emissions).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed seller legacy stake <amount>` | Legacy: stake USDC (`10` = 10 USDC) | `--agent-id <id>` |
| `antseed seller legacy unstake` | Legacy: withdraw USDC stake (subject to slash conditions) | |
| `antseed seller legacy claim-starter` | Claim the legacy-seller starter ANTS position | |
| `antseed ants seller claim-starter` | Same as `antseed seller legacy claim-starter` | |

</CommandTable>

## Network

Browse sellers and run network infrastructure. Guides: [Routing and catalog](/docs/api/routing), [Discovery](/docs/discovery).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed network browse` | Browse peers: prices, services and on-chain settlements | `--service <name>`, `--tag <tags>`, `--services`, `--sort score\|volume\|sessions\|price\|recent`, `--top` (20), `--json` |
| `antseed network peer <peerId>` | Full details for one peer | `--tag <tags>`, `--json` |
| `antseed peer <peerId>` | Show a peer's profile | |
| `antseed network bootstrap` | Run a dedicated DHT bootstrap node (no provider, no payments) | `--port` (6881), `--bootstrap <host:port,...>` |

</CommandTable>

## Config

Read and change `~/.antseed/config.json`. Guides: [Buyer configuration](/docs/buyer-config), [Provider configuration](/docs/provide/config).

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed config init` | Create a config file with defaults | |
| `antseed config show` | Show the configuration (credentials redacted) | |
| `antseed config set <key> <value>` | Set a value at an existing key path, for example `seller.reserveFloor 20`. Unknown keys are rejected; see [Seller configuration](/docs/provide/config#edit-the-configuration-from-the-cli) | |
| `antseed config buyer show` | Show buyer configuration | |
| `antseed config buyer set <key> <value>` | Set a buyer value, for example `maxPricing.defaults.inputUsdPerMillion 25` | |
| `antseed config seller show` | Show seller configuration | |
| `antseed config seller set <key> <value>` | Set a seller value | |
| `antseed config seller add-provider <name>` | Add a provider (installs its plugin) | `--plugin <name>`, `--base-url`, `--input`, `--output`, `--cached` |
| `antseed config seller remove-provider <name>` | Remove a provider | |
| `antseed config seller add-service <provider> <serviceId>` | Add a service under a provider | `--upstream`, `--input`, `--output`, `--cached`, `--categories`, `--capabilities <json>`, `--unit-billing-models <json>`, `--base-url` |
| `antseed config seller remove-service <provider> <serviceId>` | Remove a service | |

</CommandTable>

## Other

<CommandTable>

| Command | Purpose | Key flags |
|---|---|---|
| `antseed metrics serve` | Serve Prometheus metrics ([guide](/docs/provide/metrics)) | `--role buyer\|seller\|both\|auto`, `--host` (127.0.0.1), `--port` (9108), `--path` (/metrics), `--instance`, `--include-chain` |
| `antseed dev` | Run a seller and a buyer locally for development | `--port <buyerPort>` |
| `antseed agent dev <agentDir>` | Test an ant agent locally in an interactive chat | `--endpoint <url>`, `--api-key`, `--model` |
| `antseed update` | Install the latest CLI the way this copy was installed ([details](#updating)) | `--check` (only report), `--json` |
| `antseed help [command]` | Show help for a command | |

</CommandTable>

### Updating

`antseed update` asks the npm registry for the latest `@antseed/cli` and runs the matching command for how the CLI was installed: `npm install -g`, `pnpm add -g`, `yarn global add`, `bun add -g` or `volta install`. A global npm install in a root-owned prefix, Nix, npx, a project dependency or a source checkout only prints the command to run. On a server set up by the [gateway installer](/docs/gateway/server#upgrade) it hands the install to the root update service, which also restarts the buyer and gateway. Restart any running buyer, seller or gateway you started yourself to use the new version.

Nothing updates by itself. Interactive commands print a one-line notice on stderr when a newer version is out. The registry is asked at most every 30 minutes, in the background, so the notice appears from the next run. It stays quiet with `--json`, when stderr is not a terminal, and in CI.

A running `antseed seller start` or `antseed buyer start` asks the registry every 30 minutes and logs one line the first time it sees each newer version, also when it runs as a service:

```text
Antseed 0.1.195 is available (this seller runs 0.1.193). Run antseed update, then restart the seller.
```

A gateway does the same and also shows it in its console (see [Upgrade](/docs/gateway/server#upgrade)). Set `NO_UPDATE_NOTIFIER` or `ANTSEED_NO_UPDATE_CHECK` to turn all of these off. `ANTSEED_NPM_REGISTRY` (or npm's `npm_config_registry`) points the check at a mirror.
