# Factory models

**Hardcoded for now: every agent uses GesundAI only.** GesundAI is one AntSeed seller (peer `983e9de990b9ac8d36d373db5d0b49a4d7f7d826`). The `gesundai` provider in `~/.prime/agent/models.json` sends `x-antseed-pin-peer` with every request, so the buyer never routes to another peer. If GesundAI is offline, requests fail instead of falling back.

Selector format: `gesundai/<model-id>` for Prime steps. Native steps get the plain model id and the same pin from `scripts/native-step.mjs`: Claude Code through `ANTHROPIC_CUSTOM_HEADERS`, Codex through a `gesundai` model provider (`wire_api = "responses"`, `http_headers` with the pin). Do not use `antseed/...` selectors in this factory.

| Role | Model | Thinking | Fallback (same peer) |
|---|---|---|---|
| shape (before the run) | Claude Code `claude-opus-5.5`, effort high | high | `claude-opus-5` |
| plan | `gesundai/claude-opus-5.5` | high | `gesundai/claude-opus-5` |
| explorer (read-only scouts, sent in pairs) | `gesundai/claude-sonnet-5.5` high + `gesundai/gpt-6.1-sol` medium, same question in parallel | high / medium | if one fails, the other alone |
| explainer | `gesundai/claude-opus-5.5` | medium | `gesundai/claude-sonnet-5.5` |
| build | Codex `gpt-6.1-sol`, effort medium | medium | `gpt-6-sol` |
| review | Claude Code `claude-opus-5.5`, effort high (one reviewer) | high | `claude-opus-5` |
| verify | Claude Code `claude-opus-5.5`, effort medium | medium | `claude-sonnet-5.5` |
| runners (plan-check, build, review, verify) | `gesundai/claude-sonnet-5.5` | low | `gesundai/claude-sonnet-5` |

GesundAI models (tested with the pin on 2026-10-11): `claude-opus-5.5`, `claude-opus-5`, `claude-sonnet-5.5`, `claude-sonnet-5`, `claude-fable-5.1`, `claude-fable-5` (Anthropic Messages), and `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna` (OpenAI Responses; Codex and Prime both work). GesundAI's Responses endpoint rejects a bare string `input` with an upstream 400; Codex and Prime send message lists, which work.

## Images (exception to the GesundAI pin)

GesundAI serves no image models, so mockups are the one place the factory uses other peers. `scripts/mockup.mjs` picks the cheapest peer with reputation >= 60 for the model (one that accepts image input when editing a screenshot), caps each image at $0.25 and each task at 8 images, and logs model, peer and price in `design/images.jsonl`. Checking images (`scripts/describe-image.mjs`) stays on GesundAI with `claude-opus-5` (`gpt-6.1-sol` returned an empty answer on images).

| Use | Model | Peer and price (2026-10-11) |
|---|---|---|
| edit from a screenshot (default) | `gpt-image-2.5-flare` | D5V1N2, $0.175, 25 s; keeps the real UI, clean text |
| text only, new screens | `gpt-image-2.5-flare` | Venice, $0.035, 19 s, 1024x768 |
| alternatives | `nano-banana-pro` ($0.08 text, $0.33 edit), `gpt-image-2` ($0.12 text, $0.74 edit), `qwen-image-2-pro` ($0.05) | same peers |

Edits must use `size=auto` (the edit peer rejects exact sizes); mockup.mjs does that. Model ids can show with `.` or `-` (`gpt-image-2.5-flare` / `gpt-image-2-5-flare`) depending on which peers are online; mockup.mjs accepts both.

Rules:
- Scouts go in pairs from two model families. The planner trusts what both found and checks anything only one found, or where they disagree, itself.
- Only `gesundai/...` selectors. Prime's default model and sub-agent default model point at `gesundai` in `~/.prime/agent/settings.json`.
- One reviewer for now. Builder and reviewer are different model families (GPT builds, Claude reviews), which gives the independent second look.
- To change a model, edit this table and the matching `model` field in `machines/tdd-factory/MACHINE.md`, then re-import the machine.
- To undo the pin: restore `~/.prime/agent/models.json.pre-gesundai.bak` and `settings.json.pre-gesundai.bak`, and switch selectors back to `antseed/...`.
