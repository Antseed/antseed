# Desktop chat

A user sends a chat from the desktop app and gets the seller's reply. In the sandbox the desktop runs attach-only: it uses the sandbox buyer and wallet and starts no buyer of its own, so the chat is paid on the sandbox chain.

## Sub-features

- `desktop-attach` attaches the desktop to the sandbox buyer proxy.
- `desktop-send` sends a chat from the composer and shows the reply.
- `desktop-paid` pays the desktop chat through a signed channel that settles exactly.
- `desktop-clean` produces no renderer errors.

## How to get to it (user POV)

- Open the desktop, choose **Chat**, type in the composer, and choose **Send message**.
- If the seller has a low reputation, choose **Continue anyway**.

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- The desktop is built from the code under test (`pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`). Doctor prints `OK   desktop built`.
- A display. On a headless Linux server, prefix the run with `xvfb-run -a`.
- One seller. The shipped scenario is `desktop-chat`, with `requires: ['desktop', 'mockControl']`.

- **Launch.** Call `const ui = await sb.desktop()`. The **Chat** button appears within 60 seconds. `await ui.screenshot('launched')` saves `screenshots/launched.png`.
- **Attached.** Read `await ui.text()`. It contains `Port: <proxy port>`, the port of `sb.proxyUrl`.
- **Send.** Call `await ui.sendChat('desktop-chat <timestamp>')`. It opens the chat, fills the first `textarea`, chooses `Send message`, chooses `Continue anyway` if shown, and waits for the mock reply. `chat.reply` contains `seller <id>`.
- **Paid.** `sb.mockRequests(seller.id)` has at least one `/v1/chat/completions` entry, and `sb.channels()` holds a channel with `cumulativeSigned > 0`.
- **No errors.** `ui.errors` is empty.
- **Settled.** Call `await ui.close()`, `sb.closeAll()`, then `sb.assertSettlementMatchesSigned()`.
- **Proof.** Run `xvfb-run -a .claude/skills/verify-antseed/scripts/run-with-evidence.mjs desktop-chat --chain local` (drop `xvfb-run -a` when a display exists). Open `screenshots/launched.png`, `screenshots/reply.png` and `video/desktop.webm` from the report directory and say what they show. Read `desktop-main.log` for main-process errors.

## Gotchas

- The desktop runs the built `apps/desktop/dist`. A renderer or main-process edit is invisible until you rebuild.
- A chat that times out saves `screenshots/chat-timeout.png`, and the error text includes the visible screen. Look at that file and the video before you change the scenario.
- Each launch resets `desktop-automation/`, so no chat history carries over between runs.
- Prefer `getByRole` and `getByLabel`. If an element has no accessible name, add an `aria-label` in the component as part of the change.
- For a remote reader, serve the report (`pnpm sandbox report --serve --port 8799`) and give them the `ssh -L 8799:127.0.0.1:8799 <host>` tunnel.
