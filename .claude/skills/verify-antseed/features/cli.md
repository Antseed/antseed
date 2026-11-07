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
- A data dir under the run directory or the testbench, never `~/.antseed`.

- **Run.** `node apps/cli/dist/cli/index.js --data-dir <run>/cli <command>`, capturing stdout, stderr and the exit code: `... > <run>/cli/<name>.out 2>&1; echo "exit $?" >> <run>/cli/<name>.out`.
- **Against the testbench.** Commands that need a network use the testbench's buyer dir and config from `pnpm -s testbench status --env`.
- **Proof.** The transcript file: the command, its output and its exit code. For a changed output, show the before and after transcripts.

## Driving it from a scenario

`tb.cli(args)` runs a command on the testbench buyer's data dir and config (`tb.sellerCli(id, args)` on a seller's) in the testbench's isolated environment, returns `{ code, stdout, stderr, json }` and writes the transcript to `events.jsonl` and the HTML report as a `cli` event. `cli-buyer-commands` (buyer read commands next to a running buyer) and `buyer-withdraw-and-exit` (`buyer withdraw`, `channels request-close`, `channels withdraw`) are the worked examples; run them in `cli` mode so the buyer is its own process.

## Gotchas

- No `--data-dir` means `~/.antseed`, the operator's real identity and wallet. The session's deny rules block it; never work around them.
- A long-running command (`buyer start`) needs a background run and an explicit stop.
- Only the buyer commands have scenarios. A change to another command needs a unit test plus a transcript (by hand, or from a scenario with `tb.cli()`).
- `buyer channels <subcommand> --json` prints text: `channels` declares `--json` itself and commander hands it the flag. The scenarios record it as a known issue and read the text transcript; `buyer channels --json` (no subcommand) prints JSON.
