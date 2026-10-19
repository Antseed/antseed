# Desktop chat

A buyer opens the AntSeed desktop, which attaches to the buyer proxy and shows its port, and chats from the composer. The reply comes from a seller and the chat is paid like any other.

## Sub-features

- `desk-attach` shows `Port: <proxy port>` for the sandbox buyer.
- `desk-chat` sends a chat from the composer and shows the seller's reply.
- `desk-pay` signs a nonzero amount on a channel and settles exactly.
- `desk-clean` logs no renderer errors.
- `desk-review` shows a reviewer the changed screen, driven by hand.

## How to get to it (user POV)

- Open the desktop app, choose `Chat`, type in the composer and send.

## Driving it with sb and agent-browser

Preconditions:

- `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
- On a headless Linux server, prefix the run with `xvfb-run -a`.

- **Scripted proof.** `pnpm sandbox run desktop-chat --chain local` (through `run-with-evidence.mjs`). `sb.desktop()` launches the built desktop under Playwright; `ui.sendChat(prompt)`, `ui.screenshot(name)`, `ui.page`. It prints `PASSED`; open `screenshots/` and `video/desktop.webm` and say what they show.
- **A new behavior.** Add `e2e/sandbox/scenarios/desktop-<name>.mjs` with `requires: ['desktop']`, role and label selectors, `ui.screenshot(name)` at each state, and `sb.check('no renderer errors', ui.errors.length === 0, ui.errors)`.

### agent-browser (review evidence)

agent-browser drives the sandbox desktop over CDP. The scripted proof still runs; this shows a reviewer what changed.

- **Launch** with a sandbox up: `pnpm sandbox desktop --cdp-port 9333` (any free port from 1024; it refuses 8377, the desktop's own ports and a busy port, and listens on 127.0.0.1 only). Needs `npm i -g agent-browser`.
- **Connect**: `agent-browser connect 9333`, then `agent-browser tab` and pick the `http://127.0.0.1:<renderer port>/` tab with `agent-browser tab t<n>`. Dev mode also opens DevTools and float windows, and agent-browser may switch to them; re-check the tab when a snapshot shows DevTools.
- **Check it is the sandbox**: `agent-browser snapshot -i` shows `Add credits, balance $10.00` (the sandbox deposit) and the reply line names the sandbox seller's peer id from `pnpm sandbox status`.
- **Record** with `agent-browser record start <run>/review/desktop.webm` before the first action and `agent-browser record stop` after the last.
- **Act** by ref or role: `agent-browser click @e4` (Chat), `agent-browser fill @<composer> "..."`, `agent-browser press Enter`, re-snapshotting after each state change.
- **Show** each changed state with `agent-browser screenshot <run>/review/<state>.png`, and put the images and the recording in `pr.md`'s Verification with what each shows.
- **Stop**: `agent-browser close`, Ctrl-C the desktop, then `pnpm sandbox down`.

Never launch a desktop outside the sandbox commands to get a port: it would start its own buyer on the operator's state.

## Gotchas

- An unbuilt desktop fails at launch; `doctor` names the missing `dist/` files.
- A chat timeout saves `screenshots/chat-timeout.png` and puts the visible screen text in the error. Read them and the video before changing the scenario.
- On headless Linux under `xvfb-run -a`, `desktop-chat` has timed out at `page.waitForLoadState`; give it a hard deadline and report a timeout as blocked.
- The window is visible while it runs. It never reads or writes `~/.antseed`.
