# Desktop chat

A buyer opens the AntSeed desktop, which attaches to the buyer proxy and shows its port, and chats from the composer. The reply comes from a seller and the chat is paid like any other.

## Sub-features

- `desk-attach` shows `Port: <proxy port>` for the testbench buyer.
- `desk-chat` sends a chat from the composer and shows the seller's reply.
- `desk-pay` signs a nonzero amount on a channel and settles exactly.
- `desk-clean` logs no renderer errors.
- `desk-review` shows a reviewer the changed screen: the run's screenshots and video, or `pnpm testbench desktop` for a hands-on look.

## How to get to it (user POV)

- Open the desktop app, choose `Chat`, type in the composer and send.

## Driving it with tb

Preconditions:

- `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
- On a headless Linux server, prefix the run with `xvfb-run -a`.

- **Scripted proof.** `pnpm testbench run desktop-chat --chain local` (through `run-with-evidence.mjs`). `tb.desktop()` launches the built desktop under Playwright; `ui.sendChat(prompt)`, `ui.screenshot(name)`, `ui.page`. It prints `PASSED`; open `screenshots/` and `video/desktop.webm` and say what they show.
- **A new behavior.** Add `e2e/testbench/scenarios/desktop-<name>.mjs` with `requires: ['desktop']`, role and label selectors, `ui.screenshot(name)` at each state, and `tb.check('no renderer errors', ui.errors.length === 0, ui.errors)`.

Never launch a desktop outside the testbench commands: it would start its own buyer on the operator's state.

## Gotchas

- An unbuilt desktop fails at launch; `doctor` names the missing `dist/` files.
- A chat timeout saves `screenshots/chat-timeout.png` and puts the visible screen text in the error. Read them and the video before changing the scenario.
- On headless Linux, wrap the run in `xvfb-run -a`. Without Playwright's ffmpeg (`pnpm exec playwright install ffmpeg`) `run` refuses a desktop scenario up front.
- The window is visible while it runs. It never reads or writes `~/.antseed`.
