---
name: tdd-factory
description: Plan a task (Prime, from the shaped brief if there is one), build it test-first (Codex, gpt-6.1-sol), review it (scripted checks plus one Claude Code reviewer), then verify the feature like a user in the AntSeed sandbox (Claude Code). Review or verify failures loop back to build.
version: 10
author: alex
---

# tdd-factory

plan -> plan-check -> build -> review -> verify. plan-check reads plan.md from disk (`scripts/plan-check.mjs`): a final plan goes to build, a draft or missing plan sends plan back once to continue from its draft, so an empty or cut-off planner reply loses nothing. review -> build and verify -> build on failure (at most 3 builds). See `.factory/README.md` for the skills each step uses and `.factory/models.md` for models.

Put the task in `.factory/current-task.md`, then from interactive Prime at the repo root:

    exec(open(".factory/scripts/factory_run.py").read()); print(await factory_go())

(`factory-start.sh` sends exactly that. It also starts a watcher that notifies you when the run ends, fails or pauses, and writes `.factory/tasks/<slug>/outcome.md`.)

```machine-spec
{
  "run": {
    "budget_ms": 7200000,
    "failure_policy": "escalate",
    "max_parallel": 2,
    "max_transitions": 12
  },
  "states": [
    {
      "id": "plan",
      "entry": true,
      "subagent": {
        "prompt": "You are the planner. The task slug is the `Factory slug:` line in .factory/current-task.md. Do NOT edit any file outside .factory/. Work in this order, and keep your own context small: you get cut off if it grows too big, so save often.\n\n1. Read .factory/current-task.md and .factory/models.md. If the task names a shaped brief, read it and its design/ folder. The brief is already researched: treat every line under Decisions as fixed (by user, territory or agent-for-user alike), take its Recommendation where Decisions are silent, and research only what it leaves open. Never change the meaning of the human's words: every acceptance criterion from the task and the brief must appear in your Acceptance checks quoted word for word, each with how verify will check it.\n2. Save the starting state: `mkdir -p .factory/tasks/<slug>/scouts && git diff > .factory/tasks/<slug>/baseline.patch && git ls-files --others --exclude-standard | grep -v '^.factory/' > .factory/tasks/<slug>/baseline.untracked` (keep existing baseline files).\n3. Write the draft within your first five tool calls. If .factory/tasks/<slug>/plan.md already exists, an earlier attempt was cut off: read it and continue from it, don't start over. Otherwise write it now from the task and brief alone: first line `Status: draft`, then every section listed below, with `TODO: <what is missing>` where you don't know yet. Update plan.md after every finding, so a cut-off loses nothing. Each reply you write is capped at about 20,000 words including tool-call code, so never write plan.md in one big call: edit one section at a time.\n4. Fill the TODOs. Never print a whole file: read with `rg -n` and line ranges of at most 120 lines. Leave wide reading to scouts (the `how` skill): spawn read-only scouts with rlm.spawn in pairs, the same question to `gesundai/claude-sonnet-5.5` with thinking `high` AND `gesundai/gpt-6.1-sol` with thinking `medium`, in parallel, at most 4 scouts at once. Name each one `scout-<area>-<sonnet|gpt>-<HHMMSS of now>` (names must be new) and have it write its report to `.factory/tasks/<slug>/scouts/<area>-<sonnet|gpt>.md`. Before scouting an area, look in scouts/: if a report for that area already exists, read it instead of scouting again. Merge a pair: a fact both report is settled; a fact only one reports, or where they disagree, you check yourself with a narrow read before relying on it. If one model fails, use the other's answer alone and say so in plan.md.\n5. Use `blast-radius` to find what the change could break and prove the one safety fact by running real code.\n6. When no TODO is left, replace the first line with `Status: final`. Only then give your final answer.\n\nRead and follow these skills: `.agents/skills/how/SKILL.md` `.agents/skills/blast-radius/SKILL.md` `.agents/skills/principle-model-the-domain/SKILL.md` `.agents/skills/principle-subtract-before-you-add/SKILL.md`.\n\nplan.md sections: Goal; Data shape (where it lives); Files to change; Delete first; Out of scope; Failing tests to add (file + case names, behavior not implementation); User-facing copy (every message, warning, label or error text the user will see, written out exactly, one per case or state: e.g. each failure reason with its next step. Review and verify check against this, so decide it here); Gate commands (narrow test + package typecheck + build if needed, exact commands, each on its own line in backticks, no prose around them); Acceptance checks (2-5 one-sentence behaviors a user can observe, each with HOW verify will run it: a sandbox scenario from `.agents/skills/sandbox-test/SKILL.md`'s path map, the built CLI against the sandbox buyer, or a desktop scenario; a new `e2e/sandbox/scenarios/desktop-<feature>.mjs` if UI changes and none covers it); Safety fact (claim, proof level 1-5, proof command + output); Visual target (UI tasks only: the chosen mockup path from the brief's design/ folder and the current screenshot path, or `none`; if the task changes UI and has no mockup, make one with `.agents/skills/ui-mockup/SKILL.md`).\n\nFINAL ANSWER RULE: your very last message must be exactly one line and nothing else: `PLAN <slug> .factory/tasks/<slug>/plan.md`.",
        "model": "gesundai/claude-opus-5.5",
        "thinking": "high"
      },
      "outputs": [
        {
          "name": "plan",
          "type": "text"
        }
      ],
      "retries": 1,
      "budget_ms": 1200000,
      "max_entries": 2,
      "failure_policy": "continue"
    },
    {
      "id": "plan-check",
      "subagent": {
        "prompt": "You are the plan-check runner. You never plan and never edit any file. Run exactly this command and wait for it to exit (it can take up to 40 minutes while the planner finishes; do not interrupt it):\n\nnode .factory/scripts/plan-check.mjs\n\nIts output ends with a line starting with `ANSWER `. Your final answer is the rest of that line, copied exactly. If there is no ANSWER line, answer `PLAN_MISSING unknown plan-check did not run`.\n\nFINAL ANSWER RULE: your very last message must be exactly one line and nothing else.",
        "model": "gesundai/claude-sonnet-5.5",
        "thinking": "low"
      },
      "outputs": [
        {
          "name": "plan",
          "type": "text"
        }
      ],
      "max_entries": 2,
      "budget_ms": 2700000,
      "retries": 1
    },
    {
      "id": "build",
      "subagent": {
        "prompt": "You are the build runner. You never do the build work yourself and never edit any file. Take <slug> from the plan line below. Run exactly this command and wait for it to exit:\n\nnode .factory/scripts/native-step.mjs --step build --slug <slug> --agent codex --model gpt-6.1-sol --effort medium --template .factory/prompts/build.md --var sent_back=\"{review} {verify}\" --answer-file .factory/tasks/<slug>/build.md --timeout-min 45\n\nIts output ends with a line starting with `ANSWER `. Your final answer is the rest of that line, copied exactly. If there is no ANSWER line, answer `BUILD <slug> RED`.\n\nPlan line: {plan}\nReview line: {review}\n\nFINAL ANSWER RULE: your very last message must be exactly one line and nothing else.",
        "model": "gesundai/claude-sonnet-5.5",
        "thinking": "low"
      },
      "inputs": [
        {
          "name": "plan",
          "type": "text",
          "from": "plan-check.plan"
        },
        {
          "name": "review",
          "type": "text",
          "from": "review.review",
          "optional": true
        },
        {
          "name": "verify",
          "type": "text",
          "from": "verify.verify",
          "optional": true
        }
      ],
      "outputs": [
        {
          "name": "build",
          "type": "text"
        }
      ],
      "max_entries": 3,
      "budget_ms": 3000000,
      "retries": 1
    },
    {
      "id": "review",
      "subagent": {
        "prompt": "You are the review runner. You never do the review work yourself and never edit any file. Take <slug> from the plan line below. Run exactly this command and wait for it to exit:\n\nnode .factory/scripts/native-step.mjs --step review --slug <slug> --agent claude --model claude-opus-5.5 --effort high --template .factory/prompts/review.md  --answer-file .factory/tasks/<slug>/review.md --timeout-min 30\n\nIts output ends with a line starting with `ANSWER `. Your final answer is the rest of that line, copied exactly. If there is no ANSWER line, answer `REVIEW <slug> REVIEW_FAIL review`.\n\nPlan line: {plan}\n\nFINAL ANSWER RULE: your very last message must be exactly one line and nothing else.",
        "model": "gesundai/claude-sonnet-5.5",
        "thinking": "low"
      },
      "inputs": [
        {
          "name": "plan",
          "type": "text",
          "from": "plan-check.plan"
        },
        {
          "name": "build",
          "type": "text",
          "from": "build.build"
        }
      ],
      "outputs": [
        {
          "name": "review",
          "type": "text"
        }
      ],
      "max_entries": 3,
      "budget_ms": 2400000,
      "retries": 1
    },
    {
      "id": "verify",
      "subagent": {
        "prompt": "You are the verify runner. You never do the verify work yourself and never edit any file. Take <slug> from the plan line below. Run exactly this command and wait for it to exit:\n\nnode .factory/scripts/native-step.mjs --step verify --slug <slug> --agent claude --model claude-opus-5.5 --effort medium --template .factory/prompts/verify.md  --answer-file .factory/tasks/<slug>/verify.md --timeout-min 45\n\nIts output ends with a line starting with `ANSWER `. Your final answer is the rest of that line, copied exactly. If there is no ANSWER line, answer `VERIFY <slug> VERIFY_FAIL no-answer`.\n\nPlan line: {plan}\n\nFINAL ANSWER RULE: your very last message must be exactly one line and nothing else.",
        "model": "gesundai/claude-sonnet-5.5",
        "thinking": "low"
      },
      "inputs": [
        {
          "name": "plan",
          "type": "text",
          "from": "plan-check.plan"
        },
        {
          "name": "build",
          "type": "text",
          "from": "build.build"
        },
        {
          "name": "review",
          "type": "text",
          "from": "review.review"
        }
      ],
      "outputs": [
        {
          "name": "verify",
          "type": "text"
        }
      ],
      "max_entries": 3,
      "budget_ms": 2400000,
      "retries": 1
    }
  ],
  "transitions": [
    {
      "from": "plan",
      "to": "plan-check"
    },
    {
      "from": "plan-check",
      "to": "build",
      "when": {
        "output": "plan",
        "op": "contains",
        "value": [
          "PLAN "
        ]
      }
    },
    {
      "from": "plan-check",
      "to": "plan",
      "when": {
        "output": "plan",
        "op": "contains",
        "value": [
          "PLAN_MISSING"
        ]
      }
    },
    {
      "from": "build",
      "to": "review",
      "when": {
        "output": "build",
        "op": "contains",
        "value": [
          "BUILD "
        ]
      }
    },
    {
      "from": "review",
      "to": "build",
      "when": {
        "output": "review",
        "op": "contains",
        "value": [
          "REVIEW_FAIL"
        ]
      }
    },
    {
      "from": "review",
      "to": "verify",
      "when": {
        "output": "review",
        "op": "contains",
        "value": [
          "PASS"
        ]
      }
    },
    {
      "from": "verify",
      "to": "build",
      "when": {
        "output": "verify",
        "op": "contains",
        "value": [
          "VERIFY_FAIL"
        ]
      }
    }
  ]
}
```
