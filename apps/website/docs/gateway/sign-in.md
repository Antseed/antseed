---
title: Sign-in and access
slug: /gateway/sign-in
description: Claim the Gateway Console, choose how people sign in (passkeys, wallets, Google or another OIDC provider, Cloudflare Access), invite members and recover lost access.
---

# Sign-in and access

The Gateway Console signs people in on your own gateway. There is no Antseed account and no central login service: passkeys and wallets work out of the box, and single sign-on uses an identity provider you configure yourself. This page covers claiming the console, each sign-in method, inviting people and getting back in when a sign-in is lost. Roles are explained on [Gateway and console](/docs/gateway#organization-workspaces-members-and-keys).

## Claim the console

A new console has no owner. Whoever opens its one-time **setup link** first becomes the organization's owner, so claim it as soon as the gateway is reachable.

`antseed gateway start` and `antseed tunnel start` print the console address and a reminder while it is unclaimed:

```
API-key gateway listening on http://127.0.0.1:8379/v1
Console: http://localhost:8379/console
The console has no owner yet. Get a one-time setup link with `antseed gateway console-link`.
```

The desktop app's **Internet-accessible endpoint** publishes a console too. While the tunnel runs, its window shows **Gateway console** under **Connection details**: click **Claim console** to open a one-time setup link in your browser. Once claimed, the row shows **Open console** instead. `antseed gateway console-link` on the same computer works as well.

The setup link itself is never printed at start-up, because service output ends up in logs other people may read. Get it on the gateway machine (with `sudo` on a server made by the [installer](/docs/gateway/server)):

```bash
antseed gateway console-link
```

```
Console setup link (single use, valid for 1 hour):
  http://localhost:8379/console/setup#…
```

Open it, choose **Create a passkey**, **Sign in with a wallet** or your single sign-on button, and you are the owner. The link works once and expires after one hour; running the command again replaces it. Once the console has an owner, the command prints the console URL instead.

### The console's address

Passkeys, wallet messages, links and single sign-on all use the address people open the console at. The gateway takes it from, in order:

1. `--public-url https://gateway.example.com` on `antseed gateway start`, or `ANTSEED_GATEWAY_PUBLIC_URL`.
2. The tunnel's public URL, for `antseed tunnel start`.
3. Otherwise the address in the browser, accepted only from the gateway machine itself. Without a public URL, browsers on other machines can't sign in with a passkey or wallet.

`antseed gateway console-link` and `antseed gateway member invite` build links from the address the gateway last started with; `--public-url` overrides it.

## Sign-in methods

| Method | Works when | Notes |
|---|---|---|
| Passkey | The console is on `https://…`, or on `http://localhost` (or `http://<name>.localhost`) | Uses the device's screen lock or a security key. Not offered on IP addresses or plain-HTTP hostnames. See [Passkey gotchas](#passkey-gotchas). |
| Wallet | Always | Signs an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) "Sign in with Ethereum" message. No transaction, no gas. |
| Single sign-on (OIDC) | You configure a provider and the console has an `https` public URL | Google Workspace, Okta, Microsoft Entra ID, Keycloak, Authentik and other OpenID Connect providers. |
| Cloudflare Access | The gateway is published through Cloudflare and you configure Access | Cloudflare decides who may reach the console; the gateway trusts its signed identity. |
| API key | Always | A read-only view of one key's usage and limits. See [API-key view](#api-key-view). |

**Settings → Sign-in** shows which methods are on. They are configured on the gateway host with environment variables, not in the browser.

A member can register several methods under **Account and sign-in** in the account menu, and remove them there. The console refuses to remove someone's last method, so nobody locks themselves out.

Some actions, such as changing your sign-in methods, need a recent sign-in. The console then asks you to **Confirm with a passkey** or **Confirm with a wallet**, using one of your own methods. Confirming refreshes your current session; a passkey or wallet that belongs to another member is refused.

### Set up Google or another OIDC provider

Single sign-on uses your own OAuth client, so sign-ins go straight between your users, your provider and your gateway.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), choose a project and open **APIs & Services → OAuth consent screen**. Pick **Internal** to allow only your Google Workspace domain, or **External** for any Google account, and fill in the app name and support email.
2. Open **Credentials → Create credentials → OAuth client ID**, and choose **Web application**.
3. Under **Authorized redirect URIs**, add exactly:

   ```
   https://<domain>/console/api/auth/oidc/callback
   ```

   where `<domain>` is your gateway's public hostname, for example `https://gateway.example.com/console/api/auth/oidc/callback`.
4. Create the client and copy its **Client ID** and **Client secret**.
5. Give them to the gateway as environment variables and restart it:

   ```bash
   ANTSEED_OIDC_ISSUER=https://accounts.google.com
   ANTSEED_OIDC_CLIENT_ID=1234-abc.apps.googleusercontent.com
   ANTSEED_OIDC_CLIENT_SECRET=…
   # Optional: let anyone with a verified email in these domains join without an invite
   ANTSEED_OIDC_ALLOWED_DOMAINS=example.com
   # Optional: the button label (default "Google" for Google, else "Single sign-on")
   ANTSEED_OIDC_LABEL=Google
   ```

   On a server made by the installer, re-run it with `--oidc-issuer`, `--oidc-client-id`, `--oidc-client-secret` and `--oidc-allowed-domains` (the secret preferably as `ANTSEED_OIDC_CLIENT_SECRET` in the environment), or add the lines to `/etc/antseed/gateway.env` and run `sudo systemctl restart antseed-gateway`.

The sign-in page then shows **Continue with Google** (or your label). Without an `https` public URL, the gateway logs that OIDC sign-in is disabled and leaves the button out.

Other providers work the same way: the issuer is the provider's OpenID Connect issuer URL (the address that serves `/.well-known/openid-configuration`), the redirect URI is the one above, and the scopes are `openid email profile`. The gateway uses the authorization code flow with PKCE and accepts only verified email addresses.

Who can sign in with single sign-on:

- An invited member whose invite has their email joins on their first sign-in, while the invite is valid.
- A member who opened their invite link can link their account while enrolling, and an existing member can link one with **Link Google** under **Account and sign-in**.
- With `ANTSEED_OIDC_ALLOWED_DOMAINS`, anyone with a verified email in those domains (or, for Google, that Workspace domain) joins the Default workspace as a member.
- Anyone else is refused with "This account has not been invited to this console."

### Cloudflare Access

If the gateway is published through Cloudflare (for example a Cloudflare tunnel), you can put the console behind a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) application and let Access decide who may reach it:

1. In Cloudflare Zero Trust, create a self-hosted application for `https://<domain>/console` with the policies you want. Leave `/v1` outside it, so API clients keep using their keys.
2. Copy the application's **Application Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`).
3. Set them on the gateway and restart it:

   ```bash
   ANTSEED_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ANTSEED_CF_ACCESS_AUD=<aud-tag>
   ```

   or pass `--cf-access-team-domain` and `--cf-access-aud` to the server installer.

The gateway verifies the `Cf-Access-Jwt-Assertion` header against your team's signing keys and maps its email to a member: an active member with that email, an invited one (who joins), or, with `ANTSEED_OIDC_ALLOWED_DOMAINS`, a new member from an allowed domain.

So that rate limits and the audit log record the real client address, the gateway can trust the `CF-Connecting-IP` header. `antseed tunnel start --provider cloudflare` and the installer's Cloudflare tunnel option turn this on for you. Behind any other Cloudflare setup, set `ANTSEED_TRUST_CLOUDFLARE_HEADERS=1` yourself, and only when every request reaches the gateway through Cloudflare; otherwise a client could forge the header.

Members who signed in through Access have no passkey or wallet of their own. Add one under **Account and sign-in** to approve sensitive actions such as authorizing a withdrawal wallet.

### API-key view

Anyone with a gateway API key can paste it into the **API key** field on the sign-in page and choose **View key usage**. They get a read-only page for that key: its status, spend per period and over the last 30 days, its limits and routing policy, and its requests. They see nothing else in the organization. To create or manage keys, sign in as a member.

## Invite people

Organization owners and admins invite people from **Members → Invite member**: fill in **Name**, **Email (optional)**, **Organization role**, the role in each workspace and **Link expires after**, then **Create invite link**. Or, on the gateway machine:

```bash
antseed gateway member invite --label "Alice" --email alice@example.com --workspace "Research:admin"
```

An invite is a single-use link of the form `https://gateway.example.com/console/invite#…`, valid for 72 hours by default (`--expires-in-hours` changes it). It is shown once: send it to the person. Open invites appear under **Pending invites**, where **Revoke invite** stops a link working. Only an owner can invite an owner. An email on the invite lets the person join with single sign-on instead of the link.

### Accepting an invite

1. Open the invite link. The page says **You are invited** and which role you will join with.
2. Choose how you sign in: **Create a passkey**, **Sign in with a wallet**, or the single sign-on button.
3. You land in the console as a member of the workspaces in the invite.

If the page says the link has expired or was already used, ask an admin for a new invite. To sign in later, open the console address and use the same method.

### Disable a member

Disabling a member (on **Members**, or `antseed gateway member disable <id|email>`) ends their console sessions and revokes the API keys they own and the management tokens they created. Enabling them again does not bring revoked keys back.

## Recover access

When a member has lost every sign-in method (for example passkeys after the console moved to a new domain, a lost device, or a removed wallet), create a one-time **recovery link** on the gateway machine:

```bash
antseed gateway console-link --recover                         # the owner
antseed gateway console-link --recover --member bob@example.com
```

1. Run the command on the gateway machine (with `sudo` on an installed server). Without `--member`, it targets the owner; with several owners, name one.
2. Send the printed `…/console/recover#…` link to that member only. Anyone holding it can sign in as them until it is used.
3. The member opens it, sees **Add a sign-in method**, and adds a passkey, wallet or single sign-on on the current address.

A recovery link can only be created from the CLI on the gateway machine. It works once, expires after one hour, replaces that member's earlier unused link, and is recorded in the audit log when it is created and when it is used.

Admins can also remove a member's broken method from the CLI: `antseed gateway member credentials list <member>` and `antseed gateway member credentials remove <member> <credentialId>`. Removing a method ends all of that member's console sessions, and a member's last method is kept unless you add `--allow-last`.

## Passkey gotchas

A passkey belongs to a hostname (its relying party), not to a gateway. Most passkey problems come from that.

- **Bare IP addresses never work.** Browsers refuse passkeys on `http://127.0.0.1:8379` or `http://192.168.1.20:8379`, and the console doesn't offer them there. Use `http://localhost:8379` on the gateway machine, or a hostname with HTTPS.
- **Plain HTTP works only on `localhost`.** A gateway served to your network with `--host 0.0.0.0` over plain HTTP can't use passkeys from other machines. People there sign in with a wallet instead, and the gateway needs `--public-url` set to the address they open (for example `--public-url http://gateway.lan:8379`), or it refuses sign-in from other hosts.
- **The address must match `--public-url`.** With a public URL set, passkeys are created for that hostname. Opening the console through another address (an IP, `localhost`, an SSH forward) makes the browser refuse the passkey.
- **Every `localhost` gateway shares passkeys.** Two gateways on `localhost`, even on different ports, are the same relying party, so the browser may offer a passkey from the other one and the console answers "This passkey or wallet is not registered here." To keep them apart, open each at its own name, such as `http://work.localhost:8379` and `http://home.localhost:8390`.
- **Passkeys don't follow a move.** After a gateway moves to a new domain, passkeys from the old one don't work. Use a [recovery link](#recover-access).

For error messages and their fixes, see [Troubleshooting](/docs/gateway/troubleshooting#sign-in-problems).

## Security notes

- API keys, management tokens, invite, setup and recovery links, and sessions are stored only as SHA-256 hashes.
- Sessions end after 12 hours without use, and after 14 days at most.
- Session cookies are `HttpOnly`, `SameSite=Strict` and `Secure` whenever the console is reached over HTTPS. State-changing browser requests need a custom header, so other sites can't act on a signed-in user's behalf.
- Sign-in endpoints are rate limited per client address and per account.
- Serve the console over HTTPS whenever it is reachable from another machine.

Next: [Models and providers](/docs/gateway/models).
