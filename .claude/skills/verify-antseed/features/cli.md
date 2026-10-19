# CLI

A user runs `antseed` commands to start a buyer, inspect peers and channels, and manage a wallet. Each command reads and writes a data directory.

## Sub-features

- `cli-help` prints usage and exits 0.
- `cli-buyer` starts a buyer on an isolated data dir and serves the proxy.
- `cli-status` reports peers and channels for that data dir.

## How to get to it (user POV)

- `antseed --data-dir <dir> <command>` in a terminal.

## Driving it with a terminal transcript

Preconditions:

- `pnpm run build` (the CLI runs from `apps/cli/dist/cli/index.js`).
- A data dir under the run directory or the sandbox, never `~/.antseed`.

- **Run.** `node apps/cli/dist/cli/index.js --data-dir <run>/cli <command>`, capturing stdout, stderr and the exit code: `... > <run>/cli/<name>.out 2>&1; echo "exit $?" >> <run>/cli/<name>.out`.
- **Against the sandbox.** Commands that need a network use the sandbox's buyer dir and config from `pnpm -s sandbox status --env`.
- **Proof.** The transcript file: the command, its output and its exit code. For a changed output, show the before and after transcripts.

## Gotchas

- No `--data-dir` means `~/.antseed`, the operator's real identity and wallet. The session's deny rules block it; never work around them.
- A long-running command (`buyer start`) needs a background run and an explicit stop.
- No scenario drives the CLI yet. A CLI behavior change needs a unit test plus this transcript.
