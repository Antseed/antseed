# Sandbox-stack follow-ups found by the factory (not fixed here; for the owner of origin/codex/sandbox-stack)

Found in the format-usdc-negative dry run, scratch worktree `scratch-format-usdc-negative` (sandbox stack a441f1ddc merged with origin/main 16f69246e), on this Debian VPS, headless, `xvfb-run -a`.

## D1: run-with-evidence never exits after a failed desktop launch
- Repro: `.factory/scripts/run-scenario.sh format-usdc-negative probe desktop-chat --xvfb --timeout 240`. The scenario fails at 19:34Z with `[sandbox] Error: page.waitForLoadState: Timeout 30000ms exceeded.` and `[sandbox] FAILED: .../reports/2026-10-18T19-34-09-285Z-desktop-chat/report.json`. The process tree (run-with-evidence, cli, xvfb-run, Xvfb, Electron) keeps running until the factory's 240 s deadline kills it (exit 124, 4 processes, none left). `desktop-main.log` ends with `FATAL:electron_browser_main_parts.cc(504)] Failed to shutdown.`
- The same hang happened in the verify r1 session at 18:54Z (it ran into its own 900 s Bash timeout).
- Wanted: when `launchElectron` (`e2e/sandbox/lib/desktop.mjs`) throws, close or kill the Electron app (`app.close()` with a deadline, then kill `app.process()`), so the scenario's failure exits the run with its own code. run-with-evidence could also add a deadline of its own.

## D2: on this box the desktop window never reaches domcontentloaded under Xvfb. Root cause unverified.
- Without flags, `desktop-main.log` shows `viz_main_impl.cc: Exiting GPU process due to errors during initialization` and `command_buffer_proxy_impl.cc: ContextResult::kTransientFailure`.
- Verified at 19:38Z with `--disable-gpu` added to the launch args in `lib/desktop.mjs` (scratch only, reverted afterwards): the GPU errors are gone, but the load still times out after 30 s (report `2026-10-18T19-38-18-913Z-desktop-chat`). So the GPU errors are noise, not the cause, and `--disable-gpu` does **not** fix the load. The cause is unverified. Next candidates to check: whether the renderer bundle loads at all (DevTools/console via Playwright `page.on('console')` before `waitForLoadState`), `--no-sandbox` interplay under root (`apps/desktop/src/main/linux-sandbox.ts`), and whether `firstWindow()` is a splash or blank window rather than the app window.
- Consequence for the factory: the verify-antseed desktop row (`apps/desktop/**` -> desktop-chat) cannot pass on this VPS today. A factory run that touches the desktop would end in a verify pause.
