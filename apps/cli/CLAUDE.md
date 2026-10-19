# @antseed/cli

Owns the `antseed` command, the buyer proxy (`src/proxy/`), the gateway (`src/gateway/`, its own `CLAUDE.md`) and plugin loading (`src/plugins/`). Read `README.md` here for the commands.

## Boundaries

- Composes `@antseed/node`, the plugins and the apps. It holds glue, not protocol or payment logic.
- Plugins load through `src/plugins/registry.ts`.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| A subscription plugin (`provider-claude-code`, `provider-claude-oauth`) is never presented as a resale path. | review only |
| Tests and agents never touch `~/.antseed`, the keychain, or port 8377. | the sandbox CLI refusals inside `pnpm sandbox`; outside it, pass `--data-dir` |

## Ask first

- A removed or renamed command or flag, or a changed default (users script against them).
- A change to what the proxy forwards upstream or to which peer.

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/cli test` and `typecheck` always run.
