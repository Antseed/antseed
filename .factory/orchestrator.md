# AntSeed orchestrator

This file is the dispatcher, and the factory owns it. It replaces the **Playbooks** section of poteto-mode's `SKILL.md`. Everything else in poteto-mode still binds: Non-negotiables, Principles, Autonomy, Subagents, Writing the reply and Comments. The playbook steps stay pstack's at `{pstack}/skills/poteto-mode/playbooks/`. Never copy them here. This file adds only the routing and the AntSeed additions to named steps.

## 1. Route

Pick one row, log it as the second row of `{run}/decisions.tsv` with its reason, and copy that playbook's steps verbatim into `{run}/todo.md`, per poteto-mode. Then add the matching AntSeed additions from section 3 as todos under the step they name.

| The task | Playbook |
| --- | --- |
| A question to answer, no code change | Investigation (`investigation.md`) |
| A reported defect | Bug fix (`bug-fix.md`) |
| New or changed behavior inside one area | Feature (`feature.md`) |
| Same behavior, new structure | Refactoring (`refactoring.md`) |
| A measured slowness | Perf issue (`perf-issue.md`) |
| An open design fork you can settle by building | Prototype (`prototype.md`), then route again |
| Large or architectural: it crosses an area's rules, adds a dependency between areas, changes a wire format, schema or contract, or touches more than two areas | the **figure-it-out** skill. Its plan goes in `{run}/plan.md` and gets parked as gate `plan` with your default. Keep doing reversible work meanwhile. |

Two rules apply to every row:
- If no row clearly fits, park gate `route` with your pick as the default and go on with that pick.
- If the work turns out bigger than its row (a bug fix whose fix crosses an area's rules, for example), route again and log why.

Rows not listed (Babysit, Shipping, Autopilot, Orchestrate, Worktree cleanup) are the operator's. The factory never pushes, merges or opens a PR.

## 2. Overlays

These apply on top of any playbook.

- **Area rules.** Before the first design or code step, read the root `{tools}/CLAUDE.md` Design principles and Invariants and the `CLAUDE.md` of every area you touch. A change that hits an area's **Ask first** line parks a gate with your default before that code is written. A broken principle or rule is an Act on finding for every reviewer.
- **High blast radius.** A change on verify-antseed's "High blast radius paths" list:
  - run `interrogate` even when the design isn't contested;
  - verify it with swarm lanes (gates, live, diff audit);
  - name the paths in the PR body's `## Blast Radius` section.
- **User-visible.** A change a user sees in the desktop or CLI gets the review evidence verify-antseed names: screenshots, video and an agent-browser walk for the desktop; a transcript for the CLI. It goes in `{run}/review/`.

## 3. Additions per playbook step

| Playbook step | AntSeed addition |
| --- | --- |
| Bug fix 1 (reproduce) | Reproduce through verify-antseed: a unit test when its "Decide what to prove" row allows it, otherwise a sandbox scenario in `{run}/scratch`. |
| Bug fix 5 (red before fix) | The root two-commit invariant: the failing test is its own commit, and `prove.sh` shows it red at its parent and green at the fix. |
| Feature 1 (`how`) | Include the touched areas' `CLAUDE.md` in the `how` scope. |
| Feature 5, Bug fix 4, Refactoring 6 (verify) | verify-antseed decides what proves it. A sandbox run goes through gate `sandbox` (section 4). |
| Refactoring 1 (pin) | The pin is `prove.sh <first commit> pass ...`, and it must also pass at HEAD. |
| Bug fix 3, Feature 2 (plan, `architect`) | The plan names the smallest change that fixes the reported symptom (principle-laziness-protocol). A second writer to shared state, such as a timer or background pass beside live writes, needs a stated reason (principle-separate-before-serializing-shared-state). A limit the smallest change leaves goes in `pr.md` as a known tradeoff. |
| figure-it-out plan | The plan names the areas it crosses, the rules it changes in each, and the verify-antseed rows that will prove each phase. |
| Opening a PR | Write `{run}/pr.md` instead of creating a PR. Follow the root `CLAUDE.md` Changelog policy. |

## 4. Verify and finish

- **Verification.** pstack's order:
  1. Verify yourself on the matching surface (Feature step 5, Bug fix step 4). While iterating, run only the checks for the touched paths (Autopilot-full step 2).
  2. Then interrogate, the deslop stand-in and `/no-comments` per Opening a PR. Together these make the code-ready head.
  3. Then the swarm runs once at that head per Autopilot-full step 4, scaled per Orchestrate's Verification section. Its lanes run the full suites. verify-antseed says what proves the change.
- **Findings.** Per Autopilot-full step 4: every proven finding goes to one fresh fix-forward, with a red test for every site with the same defect. A defect that origin/main shows without the change goes in `pr.md` as a follow-up and does not gate. There is no round limit beyond that rule. Sort findings with interrogate's buckets: one the change does not make worse than origin/main is never Act on, and one whose fix costs more than it protects is Consider, listed in `pr.md` for the operator. When a second fix round answers findings that share one premise (one mechanism keeps producing them), apply principle-attack-the-premise before the next fix: write the premise in `decisions.tsv` and park gate `scope` with the smaller design as the default.
- **A later head.** A minor fix, rebase or conflict resolution gets a single verifier at the new head. A new full swarm runs only for new behavior, a redesign or a large new diff (Autopilot-full step 4, Shipping step 3).
- **Sandbox runs.** Foundry's `forge` can't run in the Bash sandbox, so run each scenario as the bare command `{factory}/sandbox-run.sh {run}/scratch <scenario> --chain local`, which runs outside it (no `cd`, pipe or `&&` around it, or it stays sandboxed and forge fails). A long-running desktop for an agent-browser walk (`pnpm sandbox desktop --cdp-port <port>`) still goes through gate `sandbox`: write it into a script under `{run}` and ask the operator to start it.
- **Done.** Write `{run}/pr.md` per Opening a PR: the title on the first line, and no local paths. Run reflect: it writes `{run}/reflect.md`, applies nothing and files nothing.
  - A reflect row aimed at a pstack file is an upstream proposal for pstack, never a local edit.
  - A row aimed at this file, `RUN.md` or an area `CLAUDE.md` is a proposal for the factory.
- **The reply.** End with the playbook's Reply and the show-me-your-work Attention section.

## 5. Subagents and context

- **Briefs.** Every spawn gets Orchestrate's brief ("The brief"), sized to the unit. Write it to `{run}/briefs/<agent>.md`. STANDING is `{run}/orch/preferences.md` (`orch standing show`), which start.sh seeds. When you restate an instruction, add it first with `orch standing add`.
- **CONTEXT.** File:line pointers, the area `CLAUDE.md` files and the previous agent's report, so the next agent starts where the last one stopped (poteto-mode's Fresh subagents). Never resume-chain an agent for a new round.
- **REPORT.** Short: verdict, head SHA, what ran, findings with file:line, and the paths of the full output. Full logs and reviews stay in files under `{run}`.
- **The lead's context** (principle-guard-the-context-window). The lead never opens screenshots, videos, long logs or full reviews. The agent that made them checks them and writes one line each into its evidence file. If a line is in doubt, a fresh agent answers that one question.
- **Phases.** After each phase (code-ready, verified, gates answered), run Pause safely to `{run}/resume.md`. A fresh `start.sh <slug>` then starts a new lead that runs Session pickup from that file, instead of carrying the old context.
