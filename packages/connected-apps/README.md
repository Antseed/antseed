# @antseed/connected-apps

Connects local AI tools to the AntSeed buyer proxy by editing each tool's own
config file. One copy is shared by the CLI (`antseed apps …`) and the desktop
app's Connected apps screen.

| Module | Contents |
|---|---|
| `config-patch` | `applyConfigPatch` / `writeConfigPatch` / `removeConfigPatch` for every format (opencode, codex, droid, pi, crush, goose, hermes, zed, claude-code, t3code, claude-desktop), plus read-only `isConfigPatchInstalled` / `isConfigPatchConnected` |
| `defaults` | `DEFAULT_APP_PROFILES`, the built-in app catalog, and `mergeWithDefaultAppProfiles` |
| `wsl` | WSL discovery and the applied-WSL-targets memory used on Windows |
| `status` | Typed catalog (`loadConnectedAppProfiles`) and per-app status snapshots |
| `state` | Read/update the desktop's `system-proxy/system-proxy.desktop.json` so CLI changes appear in the desktop UI |

Behaviour guarantees (unchanged from the desktop implementation it was moved
from): the original config is copied to `<file>.antseed.bak` once before the
first edit; disconnect removes only what AntSeed added; formats that replace
user values (Droid, Claude Code) record them in a `<file>.antseed.state.json`
sidecar and restore them on disconnect; WSL installs on Windows are patched
and unpatched too; configs patched by older desktop versions disconnect
cleanly.

The patched configs carry only the `antseed` model alias, which the buyer
resolves to its current default route. The Claude Desktop profile points at
the desktop app's local Claude gateway, so it needs the desktop app running.

This package is Node-only and has no Electron dependency.
