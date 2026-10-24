# AntSeed verification map

This directory is the maintained source for verifying what an AntSeed user sees: a buyer chatting through the proxy, routing to sellers, paying on-chain, using the desktop, and running the CLI. Read this index, then use the matching feature file as the recipe. The table in `../SKILL.md` maps a changed path to a feature file here.

## Baseline preconditions

- This worktree's sandbox, started by the run: `pnpm sandbox run <scenario> --chain local` or `pnpm sandbox up --chain local` (see `../SKILL.md` Launch). Never drive a sandbox another worktree started.
- `../scripts/doctor.mjs` shows no `FAIL`.
- Sandbox sellers answer `Hello from sandbox seller <id>`. Every chat, channel and settlement stays on the sandbox chain.

## Driving conventions

- Scripted proof uses the sandbox harness (`sb`, scenarios in `e2e/sandbox/scenarios/`). Run it through `../scripts/run-with-evidence.mjs`.
- Interactive UI review uses agent-browser over CDP on a sandbox desktop (see [desktop-chat.md](./desktop-chat.md)). The harness proves. agent-browser shows a reviewer what changed.
- Prefer ARIA roles and accessible names (`getByRole`, `getByLabel`, agent-browser `find role`). Add an `aria-label` when an element has none.
- Never run the CLI without `--data-dir` inside the sandbox or the run directory.

## Proof and skip reporting

- Capture the action and the resulting state: what the buyer signed (`sb.channels()`), what settled (`sb.settledEvents()`), what the upstream served (`sb.mockRequests()`). An HTTP 200 alone proves nothing about payments.
- UI proof: the report's `screenshots/` and `video/desktop.webm`, or agent-browser screenshots and a recording, with the sandbox port visible.
- CLI proof: the command, stdout, stderr and exit code.
- Report an unreachable entry point with the command tried and the unmet precondition. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>` (starts with `Preconditions:`), `Gotchas`.

## Features

- [Proxy chat](./proxy-chat.md) covers the catalog, non-streaming and streaming chats with usage, and receipts on one channel.
- [Routing](./routing.md) covers pinned `<peerId>@<model>` and auto-routed chats across sellers.
- [Payments](./payments.md) covers reserve, cumulative SpendingAuth, settle-on-disconnect, reconnect and on-chain settlement.
- [Desktop chat](./desktop-chat.md) covers attaching the desktop to the sandbox buyer and chatting from the composer.
- [CLI](./cli.md) covers buyer commands run against an isolated data dir.

Not mapped yet (no driver, see `../SKILL.md` Gaps): the gateway and its console, card checkout and the desktop wallet flows, the website.
