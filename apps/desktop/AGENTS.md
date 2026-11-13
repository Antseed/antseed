# @antseed/desktop

A host for one user: the Electron main process (`src/main/`), the renderer (`src/renderer/`), and IPC between them (`src/main/ipc/`, exposed in `preload.cts`). It talks to a gateway: the local one it starts from the CLI it bundles (`src/main/gateway/service.ts`, which also starts its buyer) or a remote one set in Settings. Chat, connected apps and agent skills all reach the network through that gateway with an API key, and the app reads the gateway and its buyer through their HTTP APIs. A feature here works with a local and a remote gateway, and the same data reads the same on every screen. The renderer reaches the system only through IPC. Card checkout and crypto funding both stay available.

| Rule | Enforced by |
| --- | --- |
| Windows keep `contextIsolation: true` and `nodeIntegration: false`. | review only (`src/main/ui/window.ts`) |
| The identity key is encrypted with `safeStorage` and never reaches the renderer. | no test |

**Ask first:** `src/main/identity.ts`, the preload, `webPreferences`, an IPC channel that exposes keys, files or processes.

**Prove it:** `pnpm --filter @antseed/desktop test` and `typecheck:renderer` (there is no plain `typecheck`). Native modules build for Electron's Node.
