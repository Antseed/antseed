# Antseed Desktop (Electron)

Alternative GUI interface for Antseed on macOS/Linux/Windows.

This app runs Antseed runtime commands in the background (seller start / buyer start / dashboard)
so end users do not need to use terminal commands directly.

## What it controls

- Seller mode (`antseed seller start`)
- Buyer mode (`antseed buyer start`)
- Dashboard server (`antseed dashboard --port <port> --no-open`)
- Embedded dashboard panel inside Electron (no browser tab required)
- Live process logs and daemon state snapshot (`~/.antseed/daemon.state.json`)

## Prerequisites

Use Node 24 for repository development. From the repository root, run
`nvm install && nvm use`, then `pnpm install`. Volta users can use
`volta run --node 24.21.0 pnpm install`; the project also declares a Volta pin.
CI reads the same `.nvmrc`; the Nix shell uses Node 24 with its patch version
determined by `flake.lock`.

Packaged apps still use Electron's embedded Node. This development pin does
not upgrade Electron or change the published SDK's engine range.

1. Install the `antseed` CLI binary so it is available on your `PATH`.

```bash
# example: from this monorepo's cli package
cd ../cli
npm install
npm run build
npm link
```

2. Install desktop dependencies:

```bash
npm install
```

Optional: if your CLI binary is not on `PATH`, set `ANTSEED_CLI_BIN` to an absolute executable path.

```bash
export ANTSEED_CLI_BIN=/absolute/path/to/antseed
```

## Run

Development mode:

```bash
npm run dev
```

Run multiple development worktrees at once while sharing the normal Antseed
buyer, configuration, plugins, and identity:

```bash
# Run from the repository/worktree root after selecting Node 24
pnpm dev:desktop:instance status
pnpm dev:desktop:instance codex
pnpm dev:desktop:instance ui
pnpm dev:desktop:instance feature-x
```

Any instance name receives stable, separate renderer, payments, and system-proxy ports
plus its own temporary Electron Chromium profile and volatile system-proxy
runtime files. The buyer proxy and durable `~/.antseed` data remain shared.
The first instance starts the buyer; later instances validate its Antseed
status endpoint and attach without starting duplicate buyer nodes.
In multi-instance mode, stopping, quitting, or disconnecting any
window does not remove shared Codex/tool config patches or kill the shared
buyer listener. Use the normal single-instance workflow when you intentionally
want the Stop button to shut down the buyer.

Build desktop assets:

```bash
npm run build
```

Start app from built assets:

```bash
npm run start
```

## Linux installers

`npm run dist:linux` and `npm run release:linux` use
`electron-builder.linux.cjs`. The default `npm run dist` also selects this
configuration on Linux. For direct electron-builder invocations, pass
`--config electron-builder.linux.cjs --linux`.

Linux packages keep the visible name **Antseed AI VPN** and branded download
filenames, but use `antseed-ai-vpn` for the executable, desktop/icon identity,
and `/opt/antseed-ai-vpn` installation directory. macOS and Windows retain
their existing installation identities. The Debian package name remains
`antseed-ai-vpn`, so existing installations upgrade rather than installing a
second package.

The Linux packing hook marks `chrome-sandbox` setuid before archiving. Debian
configuration enforces `root:root` ownership and mode `4755`, independently
of whether root can create user namespaces during installation. It does not
disable Chromium sandboxing. Launch the installed application as a normal
user, not root. Docker namespace restrictions can still prevent Chromium
startup even with a correctly configured helper.

### Recovering affected Debian installations

The fixed package's `preinst` narrowly repairs the invalid
`update-alternatives --remove 'AntSeed VPR' ...` command in the previous
package's `postrm` before dpkg invokes it during an upgrade. This also permits
reinstallation from the half-installed / reinstallation-required states
caused by the 0.2.44 package. Other maintainer-script commands are preserved.
New packages manage their own launcher symlink without `update-alternatives`.

Install a fixed build directly with `sudo dpkg -i /path/to/fixed.deb`;
`apt-get -f install` alone cannot repair the legacy script. This applies to
builds containing this fix, not previously published affected installers.

### Package regression tests

`node --test scripts/linux-packaging.test.mjs` validates the real merged
electron-builder configuration, generated desktop entry, maintainer-hook
syntax, sandbox mode hook, and macOS/Windows identity compatibility.

`scripts/linux/test-deb.sh FIXED.deb [LEGACY.deb]` performs destructive package
lifecycle tests and refuses to run outside a root Docker container. It checks
archive and installed sandbox ownership/mode, launcher and icon integration,
fresh install, same-version upgrade, removal, purge, and preservation of an
administrator-replaced launcher. Supplying the affected 0.2.44 archive also
tests an ordinary upgrade and recovery from both broken dpkg states.

For example, from this directory with amd64 artifacts:

```bash
fixed_deb=/absolute/path/to/fixed.deb
legacy_deb=/absolute/path/to/Antseed-AI-VPN-0.2.44-amd64.deb
docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$fixed_deb,target=/fixed.deb,readonly" \
  --mount "type=bind,source=$legacy_deb,target=/legacy.deb,readonly" \
  --mount "type=bind,source=$PWD/scripts/linux/test-deb.sh,target=/test-deb.sh,readonly" \
  ubuntu:24.04 bash -ec '
    apt-get update
    apt-get install -y /fixed.deb desktop-file-utils
    dpkg --purge antseed-ai-vpn
    bash /test-deb.sh /fixed.deb /legacy.deb
  '
```

Use `linux/arm64` with matching arm64 artifacts. These lifecycle tests do not
claim to verify a native graphical session or Ubuntu AppArmor policy.

## Notes

- This is phase 1 desktop integration: it shells out to the existing `antseed` runtime for parity and reliability.
- Keychain usage and network port handling follow the same behavior as the existing runtime stack.
- macOS may prompt for firewall/network permissions when listener ports are opened.
- On system sleep, runtime processes can pause; app should be expected to recover on wake.
