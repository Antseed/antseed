---
name: verify-feature
description: Check that a finished change does what the user asked and makes sense to someone using it. Turn the plan's acceptance checks into real runs (sandbox scenarios, the real CLI, the desktop under Playwright), run them, look at the output and screenshots, and judge the result as a user would. Use as the factory's verify step, or when asked "does this actually work", "try it like a user", "verify the feature".
---

# Verify a feature

Review asks "is the code right". Verify asks "does the feature work for a user, and does it make sense". Run the real thing. Unit tests do not count here; they already ran.

## 1. Know what was promised

Read the task (`.factory/tasks/<slug>/task.md`), the brief's acceptance criteria and decisions (`brief.md`), and the plan's **Acceptance checks**. Each check is one sentence a user could observe, for example "when the buyer is stopped, `antseed apps connect codex` still connects and prints one warning line". If the plan has none, write them from the task's acceptance criteria before running anything, and note that the plan missed them.

Add the checks the plan forgot that a user would hit:
- the main path works
- the obvious failure path gives a clear message (what happened, what to do next)
- nothing that worked before broke (neighbouring commands, other apps, other screens)

## 2. Pick how to run each check

| Change touches | Run it with |
|---|---|
| buyer proxy, routing, payments, `packages/node`, sellers, plugins | `sandbox-test`: the mapped scenarios with `pnpm sandbox run <scenario>` (no `--strict`: KNOWN results are tracked issues, report them as known, not as failures) |
| CLI commands | the built CLI (`node apps/cli/dist/cli/index.js ...`) against the sandbox buyer (`eval "$(pnpm -s sandbox status --env)"`) or a stopped/broken buyer for failure paths, with `HOME` pointed at a temp dir so no real config is touched |
| desktop UI | `sandbox-test` desktop QA: an existing `desktop-*` scenario, or a new `e2e/sandbox/scenarios/desktop-<feature>.mjs` that clicks through the feature, takes screenshots and `sb.check`s the result |
| docs, CHANGELOG only | nothing to run; say so |

Prefer a scenario file when the check will matter again (it becomes a regression test). A one-off shell run is fine for a CLI message.

Never touch `~/.antseed`, the real wallet, the keychain or real app configs. Never use `--live`.

## 3. Run and collect evidence

Run each check and keep the evidence under `.factory/tasks/<slug>/verify/`:
- the exact command and its full output (`<check>.txt`)
- for sandbox runs, the report directory (`index.html`, `report.json`, screenshots, `video/desktop.webm`)

Look at every screenshot and every output yourself. Write down what you saw, not what you expected.

## 4. Judge it as a user

For each check, answer:
- **Works?** The observed result matches the promise exactly.
- **Makes sense?** Would a user understand the message or screen without reading the code? Is the wording consistent with the rest of the product (CLI style, desktop copy)? Is anything confusing, noisy or missing (no next step, a stack trace, a raw error code, a warning on success)?
- **Safe?** No secrets or wallet data printed, no real config touched, nothing left running.

A "makes sense" problem with a concrete fix (wrong wording, missing next step, confusing order) counts as a failure: send it back. Taste-only notes go under "notes" and do not fail the step.

## 5. Report

Write `.factory/tasks/<slug>/verify.json`:

```json
{
  "passed": true,
  "checks": [{"check": "...", "how": "command or scenario", "result": "pass|fail", "saw": "what the output/screen showed", "evidence": "path"}],
  "sense_findings": ["concrete, fixable problems a user would hit"],
  "notes": ["taste-only remarks"],
  "report": "path to sandbox index.html or null",
  "video": "path or null"
}
```

and a short plain-language `verify.md` for the human (use `unslop`): what was tried, what happened, where the evidence is.

Clean up: `pnpm sandbox down` for any sandbox you started, temp dirs removed, no processes left behind.
