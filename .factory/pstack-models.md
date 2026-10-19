# pstack model configuration for factory runs

This file stands in for `~/.cursor/rules/pstack-models.mdc`, which pstack's skills read in Cursor. The roles and their format come from `setup-pstack`. A skill that names a role reads its line here. A role with more than one model fans out one agent per model, as a panel.

How a model name becomes an `Agent` call in Claude Code:

| Name | Agent call |
| --- | --- |
| `opus` (`claude-opus-5.5`) | the parent model: omit `model` (pstack's `inherit-parent`), or `subagent_type: poteto-agent` |
| `fable` (`claude-fable-5.1`) | `model: "fable"` |
| `astra` (`gpt-6-astra`) | `subagent_type: astra` |
| `sol` (`gpt-6.1-sol`) | `subagent_type: sol` |

A `grok-*` or other Cursor slug named in a skill means the role's line below. Every model goes through the AntSeed buyer pinned to GesundAI, and `start.sh` stops if GesundAI does not serve one of them.

```
feature, refactoring: opus
bug-fix: opus
perf-issue: opus
hillclimb: opus
judgment and prose: opus
hardest tasks: opus
how explorer: astra
how explainer: opus
why investigators: astra, sol
why synthesizer: opus
reflect tooling: astra
reflect judgment, divergent, synthesizer: opus
arena runners: opus, astra
arena cross-judge pool: opus, astra, sol
swarm workers: astra
architect runners: opus, astra, sol
interrogate reviewers: opus, astra, fable, sol
```

Code is written by opus, and the verifier (a swarm worker, per poteto-mode) runs on astra, a different family from the code writer, as Orchestrate asks. Panels mix both vendors (Anthropic: opus, fable. OpenAI: astra, sol). To change a role, edit its line.
