---
title: Troubleshooting
slug: /gateway/troubleshooting
description: Error codes and common problems with the Antseed gateway and Gateway Console, what causes them and how to fix them.
---

# Troubleshooting

Find the error code or symptom, then apply the fix. API errors from the gateway have this shape:

```json
{ "error": { "type": "permission_error", "code": "model_not_allowed", "message": "Model \"kimi-k2.6\" is not allowed for this API key" } }
```

## API errors

| Status and code | Cause | Fix |
|---|---|---|
| `401 invalid_api_key` | The key is wrong, or isn't a key of this gateway. | Check the `Authorization: Bearer` header and the base URL. |
| `401 key_revoked`, `401 key_expired` | The key was revoked, its owner was disabled, or it passed its expiry date. | Create a new key, or ask an admin to. See [API keys](/docs/gateway/api). |
| `402 spend_limit_reached` | A budget ran out: the key's, its owner's or its workspace's. `error.limit` says which `level` (`key`, `member` or `workspace`), which `period`, and `resets_at`. | Wait for `resets_at`, or have an admin raise the limit. See [Budgets and spend limits](/docs/gateway/budgets). |
| `403 model_not_allowed` | A routing policy on the key, its owner, its workspace or the gateway has an allow list of models, and the request named another model, or none. | Use an allowed model, or have an admin add it. **Try a request** on the **Routing** page names the level whose rule blocks the model. See [Routing policies and presets](/docs/gateway/routing). |
| `400 preset_not_found` | The request used `@preset/<slug>` with a slug that doesn't exist. | Check the slug on the **Presets** page. |
| `502 buyer_unavailable` | The gateway can't reach its buyer. | Check that the buyer is running (`journalctl -u antseed-buyer` on an installed server) and that `--buyer-port` matches it. |
| `503 spend_tracking_unavailable` | The gateway can't confirm spend with the buyer, so it won't let paid requests through. See [below](#503-spend_tracking_unavailable). | |
| `422 buyer-budget-too-low` | A video costs more than is left under the key's limits. | Use a cheaper or shorter video, or have an admin raise the limit. See [Videos](/docs/gateway/budgets#videos). |
| `404 video_route_not_found` | The video job is unknown, failed, or was created with another key. | Poll and download a video with the key that created it. |
| `429 video_pricing_in_progress` | A video started on the same limit is still being priced and holds what it may cost. | Retry after the `Retry-After` seconds. |
| `503 buyer_upgrade_required` | A key with limits created a video, and the buyer is too old to check the price against the limit. | Upgrade the buyer to the gateway's version. |
| `503 routing_policy_unavailable`, `503 buyer_policy_unsupported` | The key has a policy that restricts sellers, and the buyer can't apply it. | Upgrade the buyer to the gateway's version, and run both with the same data dir. |

Requests the gateway refuses itself (an invalid key, a disallowed model, a spent budget) are not added to the request log.

### 503 spend_tracking_unavailable

The message says which of four causes applies:

- **"The buyer for this API key is not reachable."** The buyer isn't running, or listens on another port. Start it, or point the gateway at it with `--buyer-port`.
- **"…does not report spend to this gateway; the buyer rejected the gateway control secret…"** The gateway and buyer don't share the control secret in `<data-dir>/gateway/buyer-control.secret`. Run both with the same `--data-dir`, or set `ANTSEED_GATEWAY_CONTROL_SECRET` to the same value for both.
- **"…does not report spend; upgrade it to enforce spend limits."** The buyer is older than the gateway. Upgrade the CLI (on a server, re-run the [installer](/docs/gateway/server#upgrade)).
- **"…video jobs could not be stored."** The gateway could not write its database (for example, another process holds it locked). It retries on the next request.

## Console problems

### "Showing last known values — the chain RPC is busy"

**Wallet & Funding** and **Rewards** read balances, deposits and rewards from Base through a JSON-RPC endpoint. The default public endpoint rate limits per IP address; while it throttles, the console shows the last values it read. Requests keep working. For a busy gateway, set your own Base RPC endpoint: see [Base RPC URL](/docs/buyer-config#base-rpc-url), and on an installed server [Chain RPC and rate limits](/docs/gateway/server#chain-rpc-and-rate-limits).

### The console isn't reachable from another computer

By default the gateway listens on `127.0.0.1`, so only its own machine can reach it.

- **On a server**, publish it over HTTPS with `--domain` or a Cloudflare tunnel, or reach it through an SSH port forward. See [Run a gateway on a server](/docs/gateway/server#choose-how-clients-reach-it).
- **On your network**, start it with `--host 0.0.0.0 --public-url http://<this-machine's-name>:8379`, and allow port 8379 through the machine's firewall. This is plain HTTP: API keys cross the network unencrypted. Without `--public-url`, other machines can open the console but can't sign in ("Set the gateway public URL to sign in from another host."). Passkeys don't work over plain HTTP from other machines; people there sign in with a wallet.
- **For a laptop gateway that others should reach from anywhere**, [move it to a server](/docs/gateway/migrate).

### The buyer won't start: "Identity at … is encrypted"

The full message is "Identity at … is encrypted; set ANTSEED_PASSPHRASE or ANTSEED_PASSPHRASE_FILE to unlock it." Wallet keys are encrypted and the process has no passphrase. Give it one, in the environment or a file. On an installed server, run CLI commands with `sudo antseed …`, which loads `/etc/antseed/wallet.env`; without `sudo`, the `antseed` command runs without the passphrase. A message that the passphrase is wrong, or "does not unlock" a key, means it isn't the one the keys were encrypted with. See [Protecting wallet keys](/docs/gateway/wallet-keys).

"An app-encrypted identity already exists at …/identity.enc" means the data dir belongs to the desktop app, whose wallet the CLI can't read. Use another `--data-dir`, or export the key from the desktop app.

## Sign-in problems

| What you see | Cause | Fix |
|---|---|---|
| No **Sign in with a passkey** button | Passkeys need HTTPS or `localhost`. The console is open on an IP address or a plain-HTTP hostname. | Open it at `http://localhost:<port>` on the gateway machine, or serve it over HTTPS. Or sign in with a wallet. |
| "This passkey or wallet is not registered here." | The browser offered a passkey or wallet from another gateway. All gateways on `localhost` share passkeys. | Pick the passkey you made for this gateway. To keep local gateways apart, open each at its own name, such as `http://work.localhost:8379`. If you have none here, use a [recovery link](/docs/gateway/sign-in#recover-access). |
| The browser refuses the passkey, or finds none | The console is open at a different address than the one its passkeys were made on: another domain after a move, an SSH forward, or an address other than `--public-url`. | Open the console at its public URL. After a move, add a passkey with a [recovery link](/docs/gateway/sign-in#recover-access). |
| "The passkey prompt was closed." | The passkey dialog was dismissed or timed out. | Try again. |
| "Set the gateway public URL to sign in from another host." | The gateway has no public URL, and the browser isn't on the gateway machine. | Start the gateway with `--public-url` set to the address you open. |
| "This link is not valid. Check that you copied all of it." on a setup or recovery link | The link is incomplete, was already used, expired (after one hour), or was replaced by a newer one. | On the gateway machine, run `antseed gateway console-link` (or `--recover`) for a new link. |
| "This console is already set up. Sign in instead." | Someone already claimed the console with a setup link. | Sign in. If that wasn't you, stop the gateway and investigate: its owner controls the workspaces' wallets. |
| "This invite link has expired." or "This invite link was already used." | Invites are single use and expire after 72 hours by default. | Ask an admin for a new invite. |
| "This account has not been invited to this console." | Single sign-on or Cloudflare Access worked, but no invite or allowed domain matches the email. | Ask an admin to invite that email, or to add its domain to `ANTSEED_OIDC_ALLOWED_DOMAINS`. |
| "Your Cloudflare Access sign-in is more than 5 minutes old." | A sensitive action needs a fresh sign-in. | Sign out of Cloudflare Access, sign in again, and retry. |
| "Too many attempts. Wait a minute and try again." | Sign-in is rate limited per client address and per account. | Wait, then try again. |

More on each method is on [Sign-in and access](/docs/gateway/sign-in), including [Passkey gotchas](/docs/gateway/sign-in#passkey-gotchas).
