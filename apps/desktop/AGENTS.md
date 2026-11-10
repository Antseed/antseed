# @antseed/desktop

A host for one user: the Electron main process (`src/main/`), the renderer (`src/renderer/`), and IPC between them (`src/main/ipc/`, exposed in `preload.cts`). It runs the CLI buyer it bundles (`src/main/runtime/process-manager.ts`) or attaches to a running one (`shared-buyer.ts`), and reads it through `/_antseed/*`. A feature here works in every runtime mode (`connect`, `system-proxy`, `tunnel`) and when attached, and the same data reads the same on every screen. The renderer reaches the system only through IPC. Card checkout and crypto funding both stay available.

Private (never on npm). Shipped as installers for macOS, Windows and Linux from GitHub Releases, with electron-updater. The main process is Node ESM compiled by tsc; the renderer is React built by Vite.

## Inside

- `src/main/main.ts` — lifecycle, window, tray, IPC registration, updater. `src/main/app-context.ts` — app names and paths.
- An IPC channel is an `ipcMain.handle` in `src/main/ipc/<area>.ts`, a method in `preload.cts` and its type in `src/renderer/types/bridge.ts`, all three in one change.
- A view is a component in `ui/components/views/`, an entry in `ui/components/viewRegistry.ts` and a name in `ui/types.ts`. Renderer state is `core/state.ts` and `core/store.ts`; logic lives in `modules/<area>/`.
- `src/main/runtime/` spawns or attaches to the CLI; `src/main/chat/` is the chat engine; `src/shared/` is code both sides import.
- Packaging: `npm run dist` runs `scripts/prepare-dist.mjs`, which copies workspace packages into the asar, bundles the CLI as CommonJS into `cli-dist/` and installs the Electron `better-sqlite3` prebuild. `electron-builder.yml` lists what ships.

| Rule | Enforced by |
| --- | --- |
| Windows keep `contextIsolation: true` and `nodeIntegration: false`. | review only (`src/main/ui/window.ts`) |
| The identity key is encrypted with `safeStorage` and never reaches the renderer. | no test |
| `INTERNAL_APP_NAME` never changes: it names the macOS "Safe Storage" keychain entry and the userData path. | review only (`src/main/app-context.ts`) |
| `executableName` in `electron-builder.yml` never changes: the running old version performs the update. | review only |
| The packaged CLI child runs on Electron's own node (`ELECTRON_RUN_AS_NODE=1`), so native modules match its ABI. | review only (`resolveNodeBinary` in `process-manager.ts`) |
| Packaged CLI children never refresh plugins from npm (`ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1`); dev children may. | `src/main/runtime/process-manager.test.ts` |
| Reconnect-at-launch state lives in `system-proxy.desktop.json`; `system-proxy.state.json` belongs to the CLI child. | review only (`src/main/system-proxy/paths.ts`) |
| `latest-mac.yml` lists x64 and arm64 zips and dmgs. | `scripts/mac-update-channel.test.mjs` |

## Connections

- A workspace package the main process imports at runtime must be in `dependencies` and in `WORKSPACE_PACKAGES` in `prepare-dist.mjs`, or the packaged app fails to load it. Renderer-only packages are `devDependencies`.
- Spawns the CLI and never imports it; the CLI flags and `/_antseed/*` routes it uses are a contract with `apps/cli`. Shares `~/.antseed` (config, state files, `plugins/`) with the CLI.
- `electronVersion` in `electron-builder.yml` and the `electron` devDependency stay on the same major: prepare-dist fetches the prebuild for the installed `electron`.
- `ensure:cli-dist` (run by `predev`, `prestart`, `prebuild`) builds only `build:server` of `apps/payments`; the payments web bundle comes from the root `build`. `src/main/generated/baked-defaults.ts` is rewritten by the root `scripts/bake-*.mjs` in CI; committed values stay null.
- Release: `.github/workflows/release-desktop.yml` builds into a draft release; publishing it is manual. Maintainers: bump `version` in `package.json` for every release.

## Traps

- The main process does not hot-reload in dev: restart Electron after a main or preload change.
- A local `npm run dist` leaves the Electron-ABI `better-sqlite3` in the root `node_modules`, and node tests elsewhere fail. Restore with `node apps/desktop/scripts/ensure-runtime-native-modules.mjs`.
- A dev desktop does not set `ANTSEED_SKIP_PLUGIN_UPDATE_CHECK`, so its CLI children can reinstall plugins in the shared `~/.antseed/plugins`.
- `installPluginFromBundle` (`runtime/plugins.ts`) deletes `~/.antseed/plugins/node_modules`, which the CLI also uses. Never propose loading plugins only from the app bundle; the sharing is on purpose.
- Assets the bundled CLI finds through `import.meta.url` resolve next to `cli-dist/cli/index.js`; prepare-dist must copy them there.
- `config-io.ts` writes `config.json` without the CLI's lock. A new writer that can race the CLI or the gateway takes `withFileLock`. `getDaemonStateSnapshot` reads `~/.antseed/daemon.state.json` regardless of data dir overrides.
- macOS can decline to start Squirrel's ShipIt; `main.ts` clears a stale ShipIt job and runs a watchdog. Keep both when touching the install path.
- Windows ships x64 only; listing arm64 produces a universal installer whose arm64 half carries x64 native modules.
- Testbench desktops (`ANTSEED_DESKTOP_ATTACH_ONLY`, `ANTSEED_DESKTOP_ISOLATED_PROFILE`) must not touch the real keychain, OS proxy settings or `~/.antseed`; every spawn path ends in `ProcessManager.start`, which refuses in attach-only mode.

**Ask first:** `src/main/identity.ts`, the preload, `webPreferences`, an IPC channel that exposes keys, files or processes; `INTERNAL_APP_NAME`, `appId`, `executableName`; `electron-builder.yml` targets, `asarUnpack` or `extraResources`; the updater flow.

**Prove it:** `pnpm --filter @antseed/desktop test` and `typecheck:renderer` (there is no plain `typecheck`). Native modules build for Electron's Node. A packaging change: `npm run dist` locally, then restore the native module (Traps).
