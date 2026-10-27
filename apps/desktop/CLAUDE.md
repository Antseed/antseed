# @antseed/desktop

A host for one user: the Electron main process (`src/main/`), the renderer (`src/renderer/`), and IPC between them (`src/main/ipc/`, exposed in `preload.cts`). It runs the CLI buyer it bundles (`src/main/runtime/process-manager.ts`) or attaches to a running one (`shared-buyer.ts`, `attach-only.ts`), and reads it through `/_antseed/*`. A feature here works in every runtime mode (`connect`, `system-proxy`, `tunnel`) and when attached, and the same data reads the same on every screen. The renderer reaches the system only through IPC. Card checkout and crypto funding both stay available.

| Rule | Enforced by |
| --- | --- |
| Windows keep `contextIsolation: true` and `nodeIntegration: false`. | review only (`src/main/ui/window.ts`) |
| The identity key is encrypted with `safeStorage` and never reaches the renderer. | no test |

**Ask first:** `src/main/identity.ts`, the preload, `webPreferences`, an IPC channel that exposes keys, files or processes.

**Prove it:** `pnpm --filter @antseed/desktop test` and `typecheck:renderer` (there is no plain `typecheck`). Native modules build for Electron's Node.
