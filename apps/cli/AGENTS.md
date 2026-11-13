# @antseed/cli

The `antseed` command, the buyer proxy (`src/proxy/`), the gateway (`src/gateway/`) and plugin loading (`src/plugins/registry.ts`). It is glue over `@antseed/node`, with no protocol or payment logic of its own. It is also the one buyer both hosts run (`buyer start`). Its local `/_antseed/*` API is how the desktop and the gateway read and steer that buyer. So anything a host needs from the buyer is added here, once, as a route or a command, for both hosts.

Published to npm (bin `antseed`). Node, ES modules. The desktop and Nix ship it as one esbuild bundle instead of the tsc output.

## Inside

- `src/cli/index.ts` — entry. No top-level await: the desktop bundles it as CommonJS. `src/cli/program.ts` builds the command tree.
- A new command is a `register…` function in its group's `src/cli/commands/<group>/index.ts`; a new group is registered in `program.ts`.
- `src/proxy/buyer-proxy.ts` — the buyer proxy: `/v1/*`, routing, failover, payments through the node, and every `/_antseed/*` route. The rest of `src/proxy/` is its parts.
- `src/cli/commands/buyer/start.ts` and `seller/start.ts` — wire the buyer and the seller daemon.
- `src/plugins/` (install, load, drift), `src/system-proxy/` (HTTPS interception), `src/config/` (load, validate, locked edits in `patch.ts`), `src/verifier/`.

| Rule | Enforced by |
| --- | --- |
| The buyer proxy answers only local callers: loopback or IP-literal `Host`, a local `Origin`, no cross-site `Sec-Fetch-Site`. Front doors (gateway, system proxy) strip browser headers before forwarding. | `src/proxy/local-request-guard.test.ts`, `src/proxy/buyer-proxy.test.ts` |
| Gateway-only control routes need a loopback socket and the control secret. A policy header without a valid secret is ignored; a wrong secret fails closed. | `src/proxy/gateway-policy.test.ts` |
| Plugins install with `--ignore-scripts`. A trusted verifier pins an exact version; providers never do. | `src/plugins/registry.test.ts`, `src/plugins/loader.test.ts` |
| A stale "AntSeed Local CA" (same CN, other fingerprint) is classified `stale` and purged on install. | `src/system-proxy/ca-manager.test.ts` (classification only) |
| No duplicate command names or aliases in the tree. | `src/cli/program.test.ts` |

## Connections

- Depends on many workspace packages (see `package.json`) and builds in tier 4; a stale dependency `dist/` makes CLI tests fail. pnpm pins `workspace:*` exactly on publish, so a bump of any of them needs a CLI bump (`scripts/npm-publish-plan.mjs` checks it).
- The desktop spawns this CLI and never imports it; the gateway runs it as a child; e2e imports `src/proxy/buyer-proxy.ts` and `src/plugins/registry.ts` directly.
- Three bundles of `src/cli/index.ts` keep the same externals: `build:bundle` in `package.json`, `flake.nix` and `apps/desktop/scripts/prepare-dist.mjs`. Assets found through `import.meta.url` must be copied next to each bundle. A new dependency makes the `pnpmDeps` hash in `flake.nix` stale (`./scripts/update-nix-hash.sh`).
- Kept in sync by hand: known API paths in `buyer-proxy.ts` and `ALLOWED_ROUTES` in `src/gateway/server.ts`; commands and flags and `apps/website/docs/reference/commands.md`, `flags.md`, `README.md`; the EIP-681 URI in `buyer/deposit.ts` and `packages/wallet-config`; `src/generated/baked-defaults.ts` (null in git) and the root `scripts/bake-*.mjs`.

## Traps

- `--data-dir` does not move `config.json` or `~/.antseed/plugins`, and `buyer start --instance` reads `~/.antseed/config.json` even with `--config`. Isolate a dev run with its own `HOME`.
- `buyer start` and `seller start` run `ensurePluginsUpToDate`: a dev build reinstalls plugins at `@latest` in the shared `~/.antseed/plugins` that a global CLI and the desktop also load. Set `ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1` or use an isolated `HOME`.
- `buyer start` on a port held by something that looks like a buyer logs "reusing existing local proxy" and runs with no listener and no deposit watcher. After a kill and restart, check who owns the port.
- `/_antseed/*` routes ignore `?identity=` without the gateway's control secret once `gateway/buyer-control.secret` exists. A gateway and a buyer on different data dirs disagree on it: the spend feed reports `unauthorized`.
- `buyer connection set` against another data dir changes nothing in the running buyer; the header `x-antseed-pin-peer` always works.
- The buyer sets `session_id` itself (`conversation-identity.ts`) because reverse proxies drop underscore headers. `count_tokens` never reaches a seller; it is estimated locally.
- Tests run on `dist/` through fixed globs in the `test` script: a test in a new top-level `src/` folder does not run until you add its glob.
- The CLI child owns `system-proxy.state.json` and deletes it on shutdown; a host keeps its own file. Never rename `CA_COMMON_NAME`, or the stale-CA purge stops finding old ones (`CERT_SIGNATURE_FAILURE`).
- A priced seller fails closed when the Base RPC does not answer at start. npm 11 global installs need `--allow-scripts=@antseed/node,better-sqlite3,node-datachannel`.

**Ask first:** a new or changed `/_antseed/*` route (both hosts call it); a removed or renamed command or flag, or a changed default (users script them); what the proxy forwards, or to which peer; the plugin install path or flags; a new external in the bundles.

**Prove it:** `pnpm --filter @antseed/cli typecheck` and `pnpm --filter @antseed/cli test` (it builds first; tiers 0 to 3 must be built). One file: `pnpm --filter @antseed/cli build && node --test apps/cli/dist/<path>.test.js`. A change to imports or assets the bundle needs: `pnpm --filter @antseed/cli build:bundle` and `node apps/cli/dist/bundle.mjs --help`.
