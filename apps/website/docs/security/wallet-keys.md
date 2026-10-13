---
title: Protecting wallet keys
slug: /gateway/wallet-keys
description: Encrypt the gateway's wallet keys at rest with ANTSEED_PASSPHRASE, supply the passphrase to services, and change it safely.
---

# Protecting wallet keys

Every wallet the gateway pays from has a private key on disk: `identity.key` in the data dir (the default wallet) and in each `buyer-identities/<name>/` (workspace and other wallets). By default these files are unencrypted and readable only by their owner. Give the buyer and the gateway a passphrase, and they are encrypted at rest instead.

## Encrypt the keys

1. Set the passphrase, at least 12 characters:

   ```bash
   export ANTSEED_PASSPHRASE='a long passphrase'
   ```

2. Encrypt the keys that already exist:

   ```bash
   antseed buyer identity protect --all     # every wallet key, archived ones included
   antseed buyer identity list              # the Key column shows "data dir, encrypted"
   ```

3. Start the buyer and gateway with the same passphrase. From now on every new wallet key, including the ones the console creates for new workspaces, is written encrypted.

Without `--all`, `protect` encrypts one identity (`default` unless you name one). `antseed gateway start` warns at start-up while any wallet key is still stored unencrypted.

On a server made by the [installer](/docs/gateway/server), pass `ANTSEED_PASSPHRASE` to the installer and run the commands above with `sudo antseed …`, which loads the stored passphrase.

## Supply the passphrase

The buyer and the gateway need the passphrase every time they start. Without it an encrypted key can't be read, and the buyer refuses to start rather than create another wallet.

- **`ANTSEED_PASSPHRASE`.** The process reads it once at start and removes it from its own environment, so nothing it runs inherits it. `antseed gateway start` hands it to the buyer it starts over stdin, never through the buyer's environment.
- **`ANTSEED_PASSPHRASE_FILE`.** The path of a file whose first line is the passphrase. You choose where it lives and who can read it, for example a tmpfs or a mount your secrets manager provides.
- **The server installer.** `curl … | sudo ANTSEED_PASSPHRASE='…' bash -s -- …` writes `/etc/antseed/wallet.env` (owned by root, mode 0600) containing `ANTSEED_PASSPHRASE='…'`. Both services load it, and so does the `antseed` command when run as root (`sudo antseed …`). The installer rejects a passphrase containing a single quote or a line break.
- **The terminal.** When neither variable is set and an encrypted key is found, `antseed buyer start` and `antseed gateway start` ask for the passphrase without echoing it, up to three times. `antseed buyer identity protect` asks twice when no key is encrypted yet. The answer is never stored. Nothing is asked when there is no terminal (a service, a pipe, cloud-init): the command fails as it would without the passphrase.

A configured passphrase that doesn't open the keys already encrypted in the data dir is refused at start, so all of a data dir's keys stay under one passphrase.

## Rules

- A passphrase that encrypts keys must be at least 12 characters. Keys encrypted earlier with a shorter one still open.
- The passphrase is normalized (Unicode NFKC) before use, so the same text typed on different systems gives the same key. Leading and trailing spaces count.
- A wrong passphrase fails the AES-GCM authentication check and the key is refused. There is no fallback to plaintext.
- There is no reset. If you lose the passphrase, the encrypted wallets and any funds in them can't be recovered.

## Change or remove the passphrase

To go back to plaintext keys:

```bash
antseed buyer identity unprotect --all --yes
```

`--yes` confirms writing the private keys to disk unencrypted.

To change the passphrase on an installed server:

1. Decrypt the keys with the current passphrase:

   ```bash
   sudo antseed buyer identity unprotect --all --yes
   ```

2. Re-run the installer with the new passphrase and `--replace-passphrase` (or `ANTSEED_GATEWAY_REPLACE_PASSPHRASE=1`):

   ```bash
   curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
     | sudo ANTSEED_PASSPHRASE='new passphrase' bash -s -- --domain gateway.example.com --replace-passphrase
   ```

3. Encrypt the keys again:

   ```bash
   sudo antseed buyer identity protect --all
   ```

Re-running the installer with the same passphrase leaves `wallet.env` as it is. With a different one and no `--replace-passphrase`, it stops while keys are encrypted with the stored passphrase, since the services could no longer open them.

## What the file looks like

An encrypted `identity.key` is one line of JSON, shown here formatted, with made-up values:

```json
{
  "v": 1,
  "address": "0x000000000000000000000000000000000000dEaD",
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "ZXhhbXBsZS1zYWx0LTE2Yg==" },
  "cipher": "aes-256-gcm",
  "iv": "ZXhhbXBsZS1pdjEy",
  "ct": "ZXhhbXBsZS1jaXBoZXJ0ZXh0LTMyLWJ5dGVzLWxvbmc=",
  "tag": "ZXhhbXBsZS10YWctMTZieQ=="
}
```

The wallet address is kept in clear so listings work without the passphrase. An unencrypted key is just the private key as 64 hex characters.

## What it protects

Encryption protects the keys in a copy of the data dir, a backup, the `.backup-<time>` directory an import with `--import-force` leaves behind, or a [migration bundle](/docs/gateway/migrate) whose password leaked. A bundle carries encrypted keys as they are, so the target server needs the same passphrase.

It does not protect against root on the host, or anyone who can read `wallet.env`. To keep the two apart, point `ANTSEED_PASSPHRASE_FILE` at a mount that is only present at boot, or inject `ANTSEED_PASSPHRASE` from a secrets manager, and don't pass it to the installer.

## The desktop app

The desktop app (AI VPN) protects its default wallet differently: it encrypts the key with Electron's safe storage, whose key is held by the operating system's keychain, and stores it as `identity.enc`. `ANTSEED_PASSPHRASE` doesn't apply to it, and the CLI can't read it: a CLI command that finds `identity.enc` in its data dir refuses to create a second wallet there. To use that wallet from the CLI or move it to a gateway server, export its private key from the desktop app and save it as `identity.key`, or give the CLI a different `--data-dir`. See [Desktop app](/docs/desktop).

