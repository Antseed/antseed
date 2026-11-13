# @antseed/connected-apps

Connects local AI tools (Codex, Claude Code, Claude Desktop, OpenCode and others) to the buyer proxy by editing each tool's own config file, and undoes it. One copy serves `antseed apps` in the CLI and the desktop's Connected apps screen. Published to npm. Node-only, with no Electron dependency.

## Inside

- `src/config-patch.ts` — the patchers: apply, write, remove and status per format.
- `src/defaults.ts` — `DEFAULT_APP_PROFILES`, the built-in catalog. `src/wsl.ts` — WSL discovery and paths. `src/state.ts` — the desktop's connected-app state file.
- A new tool: a `ConfigPatchDef` variant, a branch in `readConfigPatch`, apply and remove functions dispatched from `writeConfigPatch` and `removeConfigPatch`, paths in `configPatchPaths`, an entry in `DEFAULT_APP_PROFILES`, tests in `src/config-patch.test.ts`. A brand icon goes in `packages/ui/src/brand/BrandIcon.tsx`.

| Rule | Enforced by |
| --- | --- |
| The original config is copied to `<file>.antseed.bak` once, before the first edit. | `src/config-patch.test.ts` |
| Disconnect removes only what Antseed added; a selection the user changed while connected stays. Formats that replace user values (Droid, Claude Code) record them in `<file>.antseed.state.json` and restore them. | `src/config-patch.test.ts` |
| A malformed existing config is left unchanged, and the connect fails. | `src/config-patch.test.ts` |
| Patched configs carry only the `antseed` model alias, never a `<peerId>@<service>`, so a route change needs no config rewrite. | `src/config-patch.test.ts` |
| A CLI tool with an `installProbe` is patched where it is installed (native and WSL); found nowhere, the connect fails instead of creating a config. | `src/config-patch.test.ts`, `src/wsl.test.ts`; review only for the failure |
| Every default profile parses under its declared format, and names are unique. | `src/config-patch.test.ts`, `src/defaults.test.ts` |
| Tests write only under `mkdtemp` directories, never a real tool config. | review only |

## Connections

- Depends on `@antseed/protocol` and `yaml`. Used by `@antseed/cli` (`src/cli/commands/apps/`, `src/telemetry/catalog.ts`) and the desktop main process (`src/main/system-proxy/`); a bump needs the CLI bumped, and the desktop copies it in `apps/desktop/scripts/prepare-dist.mjs`.
- CLI telemetry reports a connected app by its profile `name` and `toolSlugs` (`apps/cli/src/telemetry/telemetry.test.ts` checks new defaults).
- Claude Desktop goes through the desktop's local Claude gateway, not the buyer proxy, so it needs the desktop running. WSL tools under NAT go through the desktop's relay (`apps/desktop/src/main/system-proxy/wsl-relay.ts`).

## Traps

- `system-proxy.desktop.json` belongs to the desktop: change only the two name lists and carry every other field through. The CLI's `system-proxy.state.json` is a different file with a different owner.
- `toolSlugs` match first-wins in conversation attribution; a generic slug such as `claude` would catch T3 Code's `claude-code`. Keep slugs exact.
- Configs patched by older desktop versions must still disconnect cleanly; keep the removal branches for old layouts.
- Droid normalizes its settings after a connect, so removal restores from the state sidecar, not by matching what was written.
- `~/` expands against `homedir()` everywhere; tools that read Windows known folders need `platformConfigPath`.

**Ask first:** a new tool or format; changing what disconnect removes or restores; anything that writes outside the tool's own config files.

**Prove it:** `pnpm --filter @antseed/connected-apps test` (`node --test` on `test-dist/`) and `typecheck`. Then `apps/cli`'s tests for `src/cli/commands/apps/` and `src/telemetry/`, and desktop's `test` when a desktop importer changes.
