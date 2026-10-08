---
sidebar_position: 4
slug: /guides/gateway-console
title: Gateway Console
description: Manage a self-hosted Antseed gateway from the browser — workspaces, members, keys, budgets, routing policies, presets, funding and usage.
---

# Gateway Console

The gateway console is a web app served by your own [API-key gateway](/docs/guides/gateway-api-keys) at `/console`. It turns one gateway into an organization: people sign in, work in workspaces that each pay from their own wallet, create their own API keys within the budgets you set, choose which models and sellers their requests may use, and see what they spent.

Everything runs on your gateway. There is no hosted Antseed account, no central login service and nothing in the request path besides your gateway, your buyer and the sellers it pays. Sign-in uses passkeys, wallets, or an identity provider you configure yourself.

## Open the console

The console is on by default. `antseed gateway start` (and `antseed tunnel start`) print its address and, until someone has claimed it, a reminder of how to claim it:

```
API-key gateway listening on http://127.0.0.1:8379/v1
Console: http://localhost:8379/console
The console has no owner yet. Get a one-time setup link with `antseed gateway console-link`.
```

The setup link itself is never printed at start-up, because service output ends up in logs that other people may read. Get one on the gateway host:

```bash
antseed gateway console-link
```

```
Console setup link (single use, valid for 1 hour):
  http://localhost:8379/console/setup#…
```

Open it, register a passkey or connect a wallet, and you are the organization's owner. The link works once and expires after one hour; running the command again replaces it. Once the console has an owner, the same command prints the console URL instead. The [server installer](/docs/guides/gateway-server) runs it for you and prints the link at the end of the install.

The gateway needs to know the address people use to reach it, for links, passkeys and single sign-on. Locally that is `http://localhost:<port>`. Behind HTTPS, pass it:

```bash
antseed gateway start --public-url https://llm.example.com
```

or set `ANTSEED_GATEWAY_PUBLIC_URL`. `antseed tunnel start` uses the tunnel's public URL. Run `antseed gateway start --no-console` to serve only the API.

### Running it on your own computer

When the gateway has no public URL (the default for `antseed gateway start` on a laptop), only that computer, or at most your network, can reach it, and keys only work while it is on. Organization owners and admins then see a banner: "This gateway runs on this computer. Keys only work while it's on and can't be reached from other machines." It can be dismissed for the session. **Move to a server (recommended)** opens a page with the steps and copyable commands for [moving the gateway to a server](/docs/guides/gateway-server#move-a-local-gateway-to-a-server), plus the Cloudflare tunnel alternative. The console only shows commands: the bundle with the wallet keys is made and restored by the CLI and never passes through the browser. Members and key holders do not see the banner.

The gateway judges this from its own settings, without probing the network: `GET /console/api/status` reports `exposure.mode` as `local` (listening on loopback with no public URL), `lan` (listening on another address, such as `0.0.0.0`, with no public URL) or `public` (a `--public-url`, domain or tunnel), and `personalComputer` when it runs on macOS, Windows or Linux without systemd outside a container. Organization admins also get the listen address and the reasons.

## Sign-in methods

| Method | Works when | Notes |
|---|---|---|
| Passkey | The console is on `https://…` or `http://localhost` | Browsers refuse passkeys on bare IP addresses such as `http://127.0.0.1`; use `localhost` or a hostname. |
| Wallet | Always | Sign an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) "Sign in with Ethereum" message. No transaction, no gas. |
| Single sign-on (OIDC) | You configure a provider and the console has an `https` public URL | Google Workspace, Okta, Microsoft Entra ID, Keycloak, Authentik and other OpenID Connect providers. |
| Cloudflare Access | The gateway is published through Cloudflare and you configure Access | Cloudflare checks who may reach the gateway; the console trusts its signed identity header. |
| API key | Always | Paste a gateway API key for a read-only view of that key's usage and limits. |

Lost access to every method, for example passkeys after the console moved to another domain? On the gateway machine, `antseed gateway console-link --recover [--member <id|email>]` prints a one-time link (valid for one hour, audited) that lets that member add a new sign-in method.

A member can register several methods and remove them under their profile. The console refuses to remove someone's last method from their own account, so nobody locks themselves out.

Some actions need a recent sign-in. When one does, the console asks you to confirm with one of **your own** passkeys or wallets. Confirming refreshes your current session; it never switches accounts, and a passkey or wallet that belongs to another member is refused.

### Set up Google (or another OIDC provider)

Single sign-on uses your own OAuth client, so sign-ins go straight between your users, your provider and your gateway.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), choose a project and open **APIs & Services → OAuth consent screen**. Pick **Internal** to allow only your Google Workspace domain, or **External** for any Google account, and fill in the app name and support email.
2. Open **Credentials → Create credentials → OAuth client ID**, and choose **Web application**.
3. Under **Authorized redirect URIs**, add exactly:

   ```
   https://<domain>/console/api/auth/oidc/callback
   ```

   where `<domain>` is your gateway's public hostname, e.g. `https://llm.example.com/console/api/auth/oidc/callback`.
4. Create the client and copy its **Client ID** and **Client secret**.
5. Give them to the gateway as environment variables:

   ```bash
   ANTSEED_OIDC_ISSUER=https://accounts.google.com
   ANTSEED_OIDC_CLIENT_ID=1234-abc.apps.googleusercontent.com
   ANTSEED_OIDC_CLIENT_SECRET=…
   # Optional: let anyone with a verified email in these domains join without an invite
   ANTSEED_OIDC_ALLOWED_DOMAINS=example.com
   # Optional: the button label (default "Google" for Google, else "Single sign-on")
   ANTSEED_OIDC_LABEL=Google
   ```

   With the server installer, pass `--oidc-issuer`, `--oidc-client-id`, `--oidc-client-secret` and `--oidc-allowed-domains` (the secret preferably as `ANTSEED_OIDC_CLIENT_SECRET` in the environment), or add the lines to `/etc/antseed/gateway.env` and run `systemctl restart antseed-gateway`.

Other providers work the same way: the issuer is the provider's OpenID Connect issuer URL (the address that serves `/.well-known/openid-configuration`), the redirect URI is the one above, and the scopes are `openid email profile`. The gateway uses the authorization code flow with PKCE and accepts only verified email addresses.

Who can sign in with SSO:

- An invited member whose invite has their email joins on their first SSO sign-in.
- A member who opened their invite link can link their SSO account while enrolling, and an existing member can link one from their profile.
- With `ANTSEED_OIDC_ALLOWED_DOMAINS`, anyone with a verified email in those domains (or, for Google, that hosted domain) joins the Default workspace as a member.
- Anyone else is refused.

### Cloudflare Access

If the gateway is published through Cloudflare (a [Cloudflare Tunnel](/docs/guides/public-tunnels#cloudflare-tunnel), for example), you can put the console behind a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) application and let Access decide who may reach it:

1. In Cloudflare Zero Trust, create a self-hosted application for `https://<domain>/console` with the policies you want.
2. Copy the application's **Application Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`).
3. Set them on the gateway:

   ```bash
   ANTSEED_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ANTSEED_CF_ACCESS_AUD=<aud-tag>
   ```

   or pass `--cf-access-team-domain` and `--cf-access-aud` to the server installer.

The gateway verifies the `Cf-Access-Jwt-Assertion` header against your team's signing keys and maps the email in it to a member: an active member with that email, an invited one (who joins), or, with `ANTSEED_OIDC_ALLOWED_DOMAINS`, a new member from an allowed domain. Leave `/v1` outside the Access application, so API clients keep using their keys.

## Organization, roles and workspaces

One gateway is one organization. It always has a **Default** workspace, which pays from the buyer's `default` wallet.

| Role | Can |
|---|---|
| Owner | Everything, including making other owners. An organization always keeps at least one owner. |
| Admin (organization) | Manage members, workspaces, budgets, the gateway-wide routing policy, each workspace's organization policy, presets, settings, management tokens and the audit log. Sees every workspace. |
| Member | Open the workspaces they belong to, create and revoke their own keys there (up to a per-member key limit you can set), see their own usage. |

Within a workspace, a member is either a workspace **admin**, who manages that workspace's keys, members and routing policy, or a plain **member**.

Invite people from **Members**, or from the server:

```bash
antseed gateway member invite --label "Alice" --email alice@example.com --workspace "Research:admin"
antseed gateway member list
antseed gateway member disable <id>
antseed gateway member enable <id>
```

An invite is a single-use link, valid for 72 hours by default. Disabling a member ends their console sessions and revokes the keys they own.

### Workspaces and wallets

Each workspace pays from its own buyer identity: a wallet with its own deposits, payment channels and spend. Creating a workspace creates its wallet, or you can attach an existing [buyer identity](/docs/guides/gateway-api-keys#buyer-identities).

```bash
antseed gateway workspace create --name "Research" --monthly-limit 200
antseed gateway workspace list
antseed gateway key create --label "ci" --workspace Research --weekly-limit 10
```

## Budgets

Budgets cap the USDC actually paid to sellers, per UTC day, week (starting Monday), calendar month or lifetime. You can set them on a workspace, on a member (all keys they own) and on a key. A request runs only if every level has room. When one is reached, the gateway answers `402` with `spend_limit_reached` and says which level and period ran out:

```json
{
  "error": {
    "type": "insufficient_quota",
    "code": "spend_limit_reached",
    "message": "This API key's workspace reached its weekly spend limit of $50.00.",
    "limit": { "level": "workspace", "period": "weekly", "limit_usd": "50.000000", "spent_usd": "50.112000", "resets_at": "2026-10-12T00:00:00.000Z" }
  }
}
```

The way spend is counted, and its small gaps, are described in [Spend limits](/docs/guides/gateway-api-keys#spend-limits).

## Routing policies

A routing policy says which sellers may serve a request and how the eligible ones are ranked:

| Field | Meaning |
|---|---|
| Allowed / blocked sellers | Only these peers may serve, or these never do. Policies can also name saved **peer lists**; they refer to the list, so editing a list changes every policy that uses it. |
| Minimum trust score, minimum reputation | 0–100 |
| Require verified | Only sellers whose responses pass a verifier, such as a TEE attestation |
| TEE sellers only | Only sellers that advertise running models in a trusted execution environment (TEE). This checks what the seller advertises, so it works whether or not your buyer verifies responses |
| Price caps | Maximum input, output and cached-input USD per million tokens, and per image |
| Allowed models | Only these models; requests for others get `403 model_not_allowed` |
| Sort | `balanced` (default), `price`, `latency` or `trust`; optionally free sellers first |
| Per-model routes | An ordered list of sellers to try first for a model, optionally the only ones allowed |

Policies can be set at several levels, applied in order:

1. The buyer's own configuration (price caps, minimum reputation, in **Settings**)
2. The gateway default (**Routing**)
3. The workspace's organization policy, set by organization admins
4. The workspace's own policy, set by its workspace admins
5. The member who owns the key
6. The key
7. The preset, if the request uses one

A workspace therefore has two policies. Organization admins set the **organization policy** (for example, TEE sellers only, or a price cap) and workspace admins cannot change it; workspace admins set the **workspace policy**, which can only narrow it further. On the **Network** page, **Allow**, **Block** and **Prefer** add one seller to the policy at the scope you choose (gateway, a workspace's organization policy, a workspace, a member or a key) and keep everything else in that policy.

Each level can only narrow the ones above it: allow lists intersect, block lists add up, minimums take the higher value, caps the lower one, and "require verified" and "TEE sellers only" stay on once any level sets them. Ranking choices (sort, free-first, per-model routes) take the most specific level that sets them. A member can therefore never give their own key more than their workspace allows.

The gateway enforces allowed models itself and hands the combined policy to the buyer with each request, authenticated by a secret only the gateway and buyer share (`<data-dir>/gateway/buyer-control.secret`). The buyer applies it to automatic routing and to pinned requests alike (`<peerId>@<model>` or the `x-antseed-pin-peer` header), so a client cannot get around it by pinning a seller.

**Route preview** (on the **Routing** page) shows, for a model and a workspace, member, key or preset, which sellers would serve and why the others were excluded (blocked, over a price cap, below the trust minimum, and so on). **Network** lists the sellers the buyer knows, with prices, trust and reputation, and the latency this gateway measured.

## Presets

A preset is a named model configuration: a model, an optional system prompt, default request parameters and an optional routing policy. Organization admins create organization-wide presets; workspace admins create presets for their workspace. Clients use one by sending its slug as the model:

```bash
curl https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer antseed_…" \
  -H "Content-Type: application/json" \
  -d '{"model": "@preset/code-review", "messages": [{"role": "user", "content": "Review this diff: …"}]}'
```

The gateway replaces the model with the preset's (for example `qwen3-coder`), puts the preset's system prompt before the client's, and merges its parameters under the client's own. Presets work on `/v1/chat/completions`, `/v1/messages` and `/v1/responses`.

## Funding and rewards

Each workspace's **Wallet & Funding** page shows its credits (available and reserved), USDC waiting in the wallet, and its payment channels with sellers. To add funds:

- **Card**: enter an amount and continue to the card checkout (Crossmint or Stripe, depending on your region). The USDC is delivered to the workspace's wallet.
- **USDC on Base**: send it to the workspace's address, shown with a QR code, from an exchange withdrawal or another wallet.

The running buyer deposits incoming USDC into the wallet's credits automatically. See [Payments](/docs/guides/payments) for how deposits and channels work.

**Rewards** shows the ANTS the workspace's wallet has earned per epoch. Claiming needs the workspace's authorized wallet: connect that wallet in the browser to claim.

Balances, rewards and the authorized wallet are read from Base through the gateway's chain RPC endpoint. The default public endpoint rate limits per IP address, so the gateway batches and caches these reads; while the endpoint is throttling, Wallet & Funding and Rewards show the last known values with the note "Showing last known values — the chain RPC is busy". To use your own endpoint, set `ANTSEED_BASE_RPC_URL` for the buyer and the gateway (see [Chain RPC and rate limits](/docs/guides/gateway-server#chain-rpc-and-rate-limits)).

### Authorized wallet

Each workspace wallet has at most one **authorized wallet** (the `operator` in the AntseedDeposits contract). It is the only address that can withdraw the workspace's deposits and claim its ANTS rewards, and both go to it. Requests keep working whether or not one is set: the gateway spends the balance with the workspace wallet itself. The **Authorized wallet** panel on **Wallet & Funding** reads it from the chain and shows how it relates to you:

| State | What it means | What you can do |
|---|---|---|
| Not set | Nobody can withdraw or claim yet. | An organization owner authorizes one of their own wallets (see below). Everyone else sees it read-only. |
| Your wallet | One of your sign-in wallets. | Connect it to withdraw, claim, hand the role to another wallet, or remove it. |
| A member's wallet | Another member's sign-in wallet (owners and admins see whose). | Only that wallet can withdraw, claim, transfer or remove it. |
| Unrecognized | No member signs in with this address. | Shown as a warning: withdrawals and rewards go to that address and only it can change the role. The gateway and the owner cannot take it back. Ask whoever controls it to transfer it, or move to a new workspace with a fresh wallet. |
| Workspace wallet | The workspace wallet authorizes itself (`antseed buyer set-authorized-wallet --self`). | Hand it to a personal wallet from the gateway host with `antseed gateway workspace operator transfer`. |

Authorizing a wallet when none is set is restricted:

- Only an organization **owner** can authorize it, from a console session (not with a management token or an API key).
- The wallet must be one of the owner's own sign-in methods, added at least 24 hours earlier. The panel lists the owner's wallets and when each becomes eligible.
- The owner must have signed in within the last five minutes, with a sign-in method other than that wallet when they have one. Otherwise the console asks them to confirm with their passkey or another wallet first.

The gateway reads the current authorized wallet and the contract's operator nonce from the chain right before it signs, and refuses (`409 operator_already_set`) when one is already set. The owner submits the signed authorization from the connected wallet, which pays the gas; the console switches the wallet to Base if needed, re-checks the nonce and simulates the transaction first, and fetches a fresh authorization if the nonce moved. Each signature is valid once.

Once set, only the authorized wallet can change it: connect it and use **Transfer or remove**. Transferring hands the role to another address straight away; removing it leaves the workspace without one until an owner authorizes a wallet again through the gateway. After a transaction confirms, the console has the gateway re-read the chain, records the change in the audit log, and refreshes balances and rewards. If the chain answers that the state changed in the meantime (for example `OperatorAlreadySet`, `InvalidNonce` or `NotAuthorized`), the panel says so and shows the current state.

**Overview** warns when a workspace budget is 80% used or reached and, for workspace admins, when the balance is running low: when it would last less than a week at last week's spending, or is under $1 with no recent spend.

## Usage, logs and export

**Activity** totals requests, tokens and USDC by day, model, key, member, seller, workspace or end user, for any date range. **Logs** lists individual requests with their model, seller, status, latency, tokens and cost, and can be searched by model, key, end user, seller, path or error. Open a request to see its details, including the error code and message of a failed request and, when content logging is on, its request and response bodies. Both pages can be exported as CSV.

Requests the gateway refuses before they reach the buyer (an invalid key, a disallowed model, a budget that ran out) get an error response but are not added to the log.

To attribute requests to your own end users, send the OpenAI-style `user` field in the request body, or an `x-antseed-end-user` header. The gateway records it and does not forward the header.

Members see the usage of their own keys, workspace admins that of their workspace, and organization admins everything. Someone signed in with an API key sees only that key.

## Audit log

**Audit log** (organization admins and owners) records who changed what: sign-ins and refused sign-ins, confirmations of a session, invites, members, workspaces, keys, routing policies, peer lists, presets, operator authorizations, channel closes, settings and management tokens, with the time, the actor and their IP address. Filter it by person or by kind of action. Management tokens can read it through `GET /console/api/audit`.

## Management API

Everything the console does goes through its JSON API under `/console/api`. For scripts and dashboards, create a management token:

```bash
antseed gateway admin-token create --label "reporting" --scope read
antseed gateway admin-token list
antseed gateway admin-token revoke <id>
```

or under **Settings → Management tokens**. A `read` token can only make `GET` requests; an `admin` token can do what an organization admin can, except create more tokens. The token is shown once.

Tokens expire after 90 days unless you choose otherwise (`--expires-in-days`, up to 365; 30 days, 90 days or 1 year in the console). Only an owner can create a token that never expires (`--no-expiry`). A token also stops working when the person who created it is disabled or is no longer an admin.

```bash
TOKEN=antseed_admin_…

# Spend by model this month
curl "https://llm.example.com/console/api/usage?groupBy=model&from=$(date -u -d "$(date -u +%Y-%m-01)" +%s)000" \
  -H "Authorization: Bearer $TOKEN"

# Create a key in a workspace with a weekly budget and an allow list of models
curl -X POST https://llm.example.com/console/api/keys \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"label": "batch-jobs", "workspaceId": "<workspaceId>",
       "limits": {"daily": null, "weekly": "25", "monthly": null, "total": null},
       "routingPolicy": {"allowedModels": ["deepseek-v3.1", "qwen3-coder"], "sort": "price"}}'
```

Amounts are USD as decimal strings and timestamps are milliseconds since the epoch. Errors are `{"error": {"code": "…", "message": "…"}}`.

## Observability

Under **Settings → Observability** you can:

- Send one OpenTelemetry trace per request to any OTLP/HTTP endpoint (Grafana, Honeycomb, Datadog, Langfuse and others), with custom headers for authentication. Spans carry the model, status, latency, key, workspace, member, end user and seller.
- Store request and response bodies in the request log, and include them in exported traces. This is off by default.
- Delete request log entries older than a number of days.

## Settings

**Settings** also holds the buyer's price caps and minimum seller reputation. Saving them restarts the buyer to apply them: it exits with code 75 and its supervisor starts it again. The buyer only restarts itself when it knows a supervisor will bring it back: under systemd (as with the server installer), or when started with `ANTSEED_SUPERVISED=1` under another supervisor such as Docker with a restart policy, launchd or pm2. Otherwise the settings are saved and the console tells you to restart the buyer yourself.

## CLI reference

Everything the console manages can also be done from a shell on the gateway machine with `antseed gateway …`. The CLI works on the gateway's data directly (the same data directory as `antseed gateway start`, so pass the same `--data-dir`), applies the same rules as the console (budgets and policies only narrow, the last owner stays, a workspace with funds cannot be deleted) and records every change in the audit log as `antseed CLI`. Commands that list or show something take `--json` for scripts. Members, workspaces, peer lists and presets can be named by id or by name (members by email, presets by slug).

Commands that need the running buyer (`peers`, `routing preview`, `workspace delete`, `settings set-buyer`) find it on `buyer.proxyPort` from your config, or `--buyer-port`.

**Keys**

| Command | Example |
| --- | --- |
| `key create` | `antseed gateway key create --label "CI" --workspace Research --weekly-limit 25 --owner alice@example.com` |
| `key list` | `antseed gateway key list --workspace Research --all` |
| `key show` | `antseed gateway key show <keyId> --json` |
| `key update` | `antseed gateway key update <keyId> --monthly-limit 50 --owner-daily-limit 2 --expires-in-days 30` |
| `key limits` | `antseed gateway key limits <keyId> --daily-limit 5 --total-limit none` |
| `key topup` | `antseed gateway key topup <keyId> on` |
| `key rotate` | `antseed gateway key rotate <keyId>` |
| `key revoke` | `antseed gateway key revoke <keyId>` |
| `key policy show` | `antseed gateway key policy show <keyId>` |
| `key policy set` | `antseed gateway key policy set <keyId> --allow-model qwen3-coder --allow-list Trusted --sort price` |
| `key policy clear` | `antseed gateway key policy clear <keyId> --layer owner` |

`key update` and `key policy set` change the admin layer; the `--owner-*-limit` flags and `--layer owner` change the key owner's own layer, which can only narrow the admin layer.

**Members and invites**

| Command | Example |
| --- | --- |
| `member invite` | `antseed gateway member invite --label "Bob" --email bob@example.com --workspace Research:admin` |
| `member invites` | `antseed gateway member invites` |
| `member cancel-invite` | `antseed gateway member cancel-invite <inviteId>` |
| `member list` | `antseed gateway member list` |
| `member show` | `antseed gateway member show bob@example.com` |
| `member update` | `antseed gateway member update bob@example.com --role admin --max-keys 3 --monthly-limit 100` |
| `member policy show` / `set` / `clear` | `antseed gateway member policy set bob@example.com --require-tee --max-input-price 2` |
| `member disable` / `enable` | `antseed gateway member disable bob@example.com` |
| `member credentials list` | `antseed gateway member credentials list bob@example.com` |
| `member credentials remove` | `antseed gateway member credentials remove bob@example.com <credentialId>` |

Removing a sign-in method ends all of that member's console sessions. Their last one is kept unless you add `--allow-last`.

**Workspaces**

| Command | Example |
| --- | --- |
| `workspace list` | `antseed gateway workspace list` |
| `workspace create` | `antseed gateway workspace create --name Research --monthly-limit 500` |
| `workspace show` | `antseed gateway workspace show Research` |
| `workspace update` | `antseed gateway workspace update Research --name "Research Lab" --weekly-limit 150` |
| `workspace delete` | `antseed gateway workspace delete Research` |
| `workspace policy show` / `set` / `clear` | `antseed gateway workspace policy set Research --layer org --min-trust 40` |
| `workspace member list` | `antseed gateway workspace member list Research` |
| `workspace member add` | `antseed gateway workspace member add Research bob@example.com --role admin` |
| `workspace member role` | `antseed gateway workspace member role Research bob@example.com member` |
| `workspace member remove` | `antseed gateway workspace member remove Research bob@example.com` |

`--layer org` sets the organization's policy for the workspace; without it, the workspace's own policy, which can only narrow the organization's.

**Routing, peer lists and presets**

| Command | Example |
| --- | --- |
| `routing show` | `antseed gateway routing show --key <keyId>` (without a target: the gateway default) |
| `routing set` | `antseed gateway routing set --min-trust 30 --max-input-price 5` |
| `routing clear` | `antseed gateway routing clear` |
| `routing preview` | `antseed gateway routing preview --model qwen3-coder --workspace Research --all` |
| `peer-list list` / `show` | `antseed gateway peer-list show Trusted` |
| `peer-list create` | `antseed gateway peer-list create --name Trusted --peer <peerId> --peer <peerId>` |
| `peer-list add` / `remove` | `antseed gateway peer-list add Trusted <peerId>` |
| `peer-list update` | `antseed gateway peer-list update Trusted --name "TEE sellers"` |
| `peer-list delete` | `antseed gateway peer-list delete Trusted` |
| `preset list` / `show` | `antseed gateway preset show coder` |
| `preset create` | `antseed gateway preset create --slug coder --name Coder --model qwen3-coder --system-prompt-file prompt.txt --param temperature=0.2` |
| `preset update` | `antseed gateway preset update coder --model deepseek-v3.1 --clear-policy` |
| `preset delete` | `antseed gateway preset delete coder` |

Every `policy set` command (and `routing set`, `preset create|update`) takes the same flags: `--allow-peer`, `--block-peer`, `--allow-list`, `--block-list` (peer list ids or names), `--allow-model`, `--min-trust`, `--min-reputation`, `--max-input-price`, `--max-output-price`, `--max-cached-input-price`, `--require-tee`, `--require-verified`, `--prefer-free` and `--sort balanced|price|latency|trust`, or a whole policy as JSON with `--file policy.json`. A set replaces the policy at that level unless you add `--merge`. As in the console, a policy that would leave no seller allowed needs `--confirm-empty`, and one that asks for more than the levels above allow needs `--accept-narrowed`.

**Usage, logs, export and audit**

| Command | Example |
| --- | --- |
| `usage` | `antseed gateway usage --group-by model --from 2026-10-01 --workspace Research` |
| `logs` | `antseed gateway logs --status error --search rate_limited --limit 20` |
| `logs --follow` | `antseed gateway logs --follow --key <keyId>` |
| `logs show` | `antseed gateway logs show <requestTag>` |
| `export` | `antseed gateway export --csv --from 2026-10-01 --output october.csv` |
| `audit` | `antseed gateway audit --action key --limit 50` |

**Settings, sellers and tokens**

| Command | Example |
| --- | --- |
| `settings show` | `antseed gateway settings show` (`--reveal` shows OTLP header values) |
| `settings set-observability` | `antseed gateway settings set-observability --otlp-endpoint https://otel.example.com/v1/traces --otlp-header "authorization=Bearer …" --retention-days 30` |
| `settings set-buyer` | `antseed gateway settings set-buyer --max-input-price 3 --min-reputation 20` |
| `peers` | `antseed gateway peers --model qwen3-coder` |
| `admin-token create` / `list` / `revoke` | `antseed gateway admin-token create --label reporting --scope read` |
| `console-link` | `antseed gateway console-link` |

`settings set-buyer` edits only the changed fields of your config file and asks the buyer to restart, as the console does.

Funding stays with the buyer commands. A workspace pays from its buyer identity (`antseed gateway workspace show` prints it and its address): send USDC on Base to that address, or show it as a QR code with `antseed --data-dir <data-dir>/buyer-identities/<identity> buyer deposit --no-watch` (the Default workspace uses your data dir itself). Card checkout is console-only. For the authorized wallet, `antseed gateway workspace operator show <workspace>` reads it from the chain and says whose it is; `operator authorize <workspace> <address>` signs the authorization for an address when none is set and prints the signature, the calldata and a `cast send` example to submit it from any wallet (or `--browser` opens the local wallet page for the workspace's wallet, like `antseed buyer set-authorized-wallet --identity <identity>`); `operator transfer <workspace> <address>|--clear` hands over the role when the workspace wallet authorizes itself, paying gas from that wallet. `authorize` and `transfer` print a warning and ask for confirmation unless you pass `--yes`, and are recorded in the audit log as `antseed CLI`.

## Security notes

- API keys, management tokens, invite and setup links, and sessions are stored only as SHA-256 hashes.
- Session cookies are `HttpOnly`, `SameSite=Strict` and `Secure` (except on plain `http://localhost`), and state-changing browser requests need a custom header, so other sites cannot act on a signed-in user's behalf.
- Sign-in endpoints are rate limited per client and per account.
- Setup links are printed only by `antseed gateway console-link`, never in service logs, and expire after one hour.
- Authorizing a withdrawal (operator) wallet needs an owner with a fresh sign-in, and the wallet must be one of the owner's own sign-in methods, added at least 24 hours earlier. Once set, only that wallet can change it.
- Serve the console over HTTPS whenever it is reachable from another machine.
