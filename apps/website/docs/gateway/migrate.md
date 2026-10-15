---
title: Move a local gateway to a server
slug: /gateway/migrate
description: Move a gateway from your computer to a Linux server with its keys, members, workspaces, wallets and usage history.
sidebar_label: Move to a server
---

# Move a local gateway to a server

A gateway started with `antseed gateway start` on your computer only works while that computer is on, and other machines can't reach it. Moving it to a server keeps everything: API keys (they keep working), members, workspaces, routing policies, presets, usage history, wallets and open payment channels. Your apps only need the new base URL.

The console shows organization owners and admins a banner while the gateway has no public address ("This gateway runs on this computer…"). Its **Move to a server (recommended)** button opens a page with these same steps and copyable commands. The console only shows commands: the bundle with the wallet keys is made and restored by the CLI and never passes through the browser.

**Prerequisites:**

- A Linux server that meets the [server installer's requirements](/docs/gateway/server), with a DNS name pointing at it and ports 80 and 443 open.
- SSH access to the server.
- If your wallet keys are encrypted, the same `ANTSEED_PASSPHRASE` on the server (see [Protecting wallet keys](/docs/gateway/wallet-keys)).

## Steps

1. **Export the gateway on your computer.** This writes a password-protected bundle:

   ```bash
   antseed gateway export --out antseed-gateway.bundle
   ```

   It asks for a password of at least 10 characters, twice (`--password-file <file>` reads it from the first line of a file instead). The databases are copied as a consistent snapshot even while the gateway runs, and the file is readable only by you (mode 0600). It is encrypted with AES-256-GCM under a key derived from the password with scrypt, and every file in it is integrity-checked on import. The command prints what it exported (workspaces, active keys, members, wallet addresses) and any warnings.

   The bundle holds the wallet keys: keep the password apart from the file.

2. **Copy it to the server:**

   ```bash
   scp antseed-gateway.bundle user@your-server:/tmp/antseed-gateway.bundle
   ```

3. **Install on the server with `--import`:**

   ```bash
   curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
     | sudo bash -s -- --domain gateway.example.com --import /tmp/antseed-gateway.bundle
   ```

   The installer asks for the bundle password on the terminal before it changes anything, restores the bundle as the `antseed` user before the services start, and does not create a new API key. If your wallet keys are encrypted, add `ANTSEED_PASSPHRASE='…'` after `sudo`, as on [Run a gateway on a server](/docs/gateway/server#encrypt-wallet-keys-at-rest). All the installer's other options work as usual.

4. **Point your apps at the new base URL**, `https://gateway.example.com/v1`. API keys are unchanged.

5. **Stop the gateway on your computer.** Press Ctrl+C where `antseed gateway start` runs, which also stops the buyer it started (stop a buyer you run yourself too). Then delete the bundle from both machines:

   ```bash
   rm antseed-gateway.bundle
   ```

:::warning
Never run both gateways. Two buyers paying from the same wallet conflict over its payment channels.
:::

## Unattended and repeated imports

| Option | Effect |
|---|---|
| `--import-password-file <file>` | Reads the bundle password from the first line of a file, for installs without a terminal. Without it, an import with no terminal stops. |
| `--import-force` | Imports over a server that already has a gateway or wallet. The old data dir is moved aside to `.antseed.backup-<time>`, never deleted. Without it, the import refuses. |
| `--dry-run` | Shows what would happen, without changing anything. |

The same settings exist as environment variables: `ANTSEED_GATEWAY_IMPORT`, `ANTSEED_GATEWAY_IMPORT_PASSWORD_FILE` and `ANTSEED_GATEWAY_IMPORT_FORCE=1`.

## Without the installer

On any machine with the CLI, stop the gateway and buyer there, then:

```bash
antseed gateway import antseed-gateway.bundle --public-url https://gateway.example.com
```

It takes the same `--password-file` and `--force` (move an existing data dir and config aside to `<dir>.backup-<time>`), plus `--port` for the gateway port. It refuses to run while something listens on the buyer or gateway port. It prints the workspaces, key and member counts and wallet addresses it restored, never a secret.

## What the bundle does not carry

- **Wallets whose key comes from `--key-from env:…` or `file:…`.** Their keys are not in the bundle, and export warns about each one. Provide the same variable or file on the server.
- **A default wallet encrypted by the desktop app** (`identity.enc`, protected by the OS keychain). The CLI can't read it, so export stops. Export the private key from the desktop app, save it as `identity.key` in the data dir, and export again.
- **Wallet keys encrypted with `ANTSEED_PASSPHRASE`** are copied as they are, still encrypted. The server needs the same passphrase.

## Sign in after the move

The import ends every console session; everyone signs in again on the new address.

- **Wallet sign-in** keeps working.
- **Single sign-on** keeps working once you add the new redirect URI (`https://gateway.example.com/console/api/auth/oidc/callback`) to your OIDC client.
- **Passkeys** do not move. A passkey is bound to the domain it was made on, so passkeys made on `localhost` or an old domain don't work on the new one. The import says so when it happens.

To add a passkey on the new address, create a one-time recovery link on the server and open it:

```bash
sudo antseed gateway console-link --recover                          # the owner
sudo antseed gateway console-link --recover --member bob@example.com # another member
```

Recovery links are explained on [Sign-in and access](/docs/gateway/sign-in#recover-access).

## Keep it on your computer instead

If you don't want a server, `antseed tunnel start --provider cloudflare` gives the gateway on your computer a public HTTPS address without moving it:

```bash
CLOUDFLARED_TUNNEL_TOKEN=<tunnel-token> ANTSEED_TUNNEL_PUBLIC_URL=https://gateway.example.com \
  antseed tunnel start --provider cloudflare
```

Run it instead of `antseed gateway start`. It needs a Cloudflare account and a named tunnel whose public hostname points at `http://localhost:8379`. Keys still stop working whenever the computer sleeps, loses its connection or restarts, and all traffic runs through your own connection. See [Public tunnels](/docs/tunnels).

Next: [Sign-in and access](/docs/gateway/sign-in).
