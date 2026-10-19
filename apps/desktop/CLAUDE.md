# @antseed/desktop

Owns the Electron app: the main process (`src/main/`), the renderer (`src/renderer/`) and the IPC between them (`src/main/ipc/`). It runs the CLI and dashboard it builds.

## Boundaries

- The renderer reaches the system only through the preload (`src/main/preload.cts`) and the IPC handlers. Windows keep `contextIsolation: true` and `nodeIntegration: false` (`src/main/ui/window.ts`).
- Native modules are rebuilt for Electron's Node version, not the development Node.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| The identity key is encrypted at rest with Electron `safeStorage` (`src/main/identity.ts`) and never reaches the renderer. | no test (verify-antseed notes this) |
| Card checkout and crypto funding both stay available; the app is never crypto-only. | review only |

## Ask first

- `src/main/identity.ts`, the preload, or a new IPC channel that exposes keys, files or processes.
- A changed `webPreferences` setting.

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/desktop test` and `typecheck` always run.
