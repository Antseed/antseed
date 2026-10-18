#!/usr/bin/env node
// Usage: node .factory/codex/models.mjs <out.json>
// Writes a Codex model catalog: Codex's built-in catalog plus the Claude models GesundAI serves,
// so the lead can spawn_agent with model:"claude-opus-5-5" etc. Slugs match GesundAI's model ids.
// GPT-6 entries ship with tool_mode "code_mode_only" + use_responses_lite, which makes Codex send
// no tools through the buyer proxy; reset both so the lead gets the normal tool set.
// multi_agent_version "v2" hands sub-agents their task as encrypted content, which Claude children
// can't read (they get an empty task); v1 sends plain text.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const claude = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-fable-5", "Claude Fable 5"],
];

const out = process.argv[2];
if (!out) throw new Error("usage: models.mjs <out.json>");
const catalog = JSON.parse(execFileSync("codex", ["debug", "models"], { encoding: "utf8", cwd: "/tmp" }));
const template = catalog.models.find((model) => model.slug === "gpt-5.5");
if (!template) throw new Error("built-in catalog has no gpt-5.5 entry to clone");
for (const model of catalog.models) {
  if (model.tool_mode === "code_mode_only") {
    model.tool_mode = null;
    model.use_responses_lite = false;
  }
  if (model.multi_agent_version === "v2") {
    model.multi_agent_version = null;
    model.multi_agent_reasoning_effort = null;
  }
}
const known = new Set(catalog.models.map((model) => model.slug));

claude.forEach(([slug, name], index) => {
  if (known.has(slug)) return;
  catalog.models.push({
    ...structuredClone(template),
    slug,
    display_name: name,
    description: `${name} on GesundAI (AntSeed).`,
    priority: 50 + index,
    upgrade: null,
    availability_nux: null,
    additional_speed_tiers: [],
    service_tiers: [],
    supported_reasoning_levels: template.supported_reasoning_levels.filter((level) =>
      ["low", "medium", "high"].includes(level.effort),
    ),
    default_reasoning_level: "medium",
    context_window: 200000,
    max_context_window: 200000,
  });
});

writeFileSync(out, JSON.stringify(catalog, null, 2));
console.log(out);
