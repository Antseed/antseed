/**
 * Single source of truth for Antseed integration entries.
 *
 * Both `/integrations` (the public hub) and `/llms-connect.txt` (the crawler-readable
 * guide) are generated from this file. The desktop app's "External clients"
 * view should also migrate to this list — see TODO in
 * apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx.
 *
 * When adding a new tool / SDK / partner, add an entry below and the page
 * appears at /integrations/<slug> automatically (the route is registered by
 * apps/website/plugins/integrations-pages.ts).
 */

/**
 * Wire format the tool sends to the buyer proxy. Antseed's @antseed/api-adapter
 * transparently translates between any pair of these, so a tool that speaks
 * `anthropic-messages` can still talk to a peer whose service is natively
 * `openai-chat-completions` (and vice versa).
 *
 * Translation is lossless for the common case but adds a small overhead and
 * has a few edge cases (notably: `openai-responses` services REQUIRE streaming,
 * so non-streaming requests against them fail). For best-fit, prefer services
 * whose advertised `protocols` array in `providerServiceApiProtocols`
 * contains the tool's wire format.
 *
 * NOTE: a peer's `provider` field is a seller-plugin label (`anthropic`,
 * `openai`, `local-llm`, ...) and is NOT the wire format. Always look at the
 * service-level `protocols` array.
 */
export type IntegrationFormat =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'multi';

/** Buyer-proxy endpoint each wire format hits. */
export const FORMAT_ENDPOINT: Record<IntegrationFormat, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  multi: '(varies)',
};

/**
 * The canonical protocol identifier that Antseed peers advertise per service
 * in `providerServiceApiProtocols` and that
 * @antseed/api-adapter uses internally as `ServiceApiProtocol`. This is the
 * value to look for when judging whether a peer is a *native* fit for a tool.
 *
 * The `provider` field on a peer is just a seller-side plugin name (e.g.
 * `anthropic`, `openai`, `local-llm`) — a label, NOT the wire format. The wire
 * format lives in `protocols`.
 */
export const FORMAT_TO_PROTOCOL: Record<
  Exclude<IntegrationFormat, 'multi'>,
  string
> = {
  'anthropic-messages': 'anthropic-messages',
  'openai-chat': 'openai-chat-completions',
  'openai-responses': 'openai-responses',
};

export type IntegrationCategory =
  | 'coding-agent'
  | 'framework'
  | 'agent-platform'
  | 'cli';

export type IntegrationStatus = 'verified' | 'community' | 'coming-soon';

export type ConfigBlock =
  | { kind: 'env'; vars: Record<string, string>; note?: string }
  | { kind: 'file'; path: string; language: string; snippet: string; note?: string }
  | { kind: 'code'; language: string; snippet: string; note?: string }
  | { kind: 'gui'; instructions: string; note?: string };

export type Step = {
  /** One short imperative line. */
  label: string;
  /** Optional shell command or code block. */
  command?: string;
  /** Language for syntax highlighting if `command` is present. Default: bash. */
  language?: string;
  /** Optional explanatory paragraph below the command. */
  note?: string;
  /** Optional example output — rendered as a muted code block under the command
   * so users know what to expect on success. */
  output?: string;
  /** Label for the output block. Default: 'Example output'. */
  outputLabel?: string;
};

export type Integration = {
  slug: string;
  name: string;
  /** Path under /logos/ — falls back to a text glyph if missing. */
  logo?: string;
  /** Short fallback shown when no logo exists yet. */
  glyph?: string;
  category: IntegrationCategory;
  format: IntegrationFormat;
  setupMinutes: number;
  status: IntegrationStatus;
  /**
   * `<title>` text, rendered as `<seoTitle> | Antseed`. Keep it 40–50 chars so
   * the full tag lands in the 50–60 Google renders without truncating.
   * Falls back to `name`, which on its own carries no query intent.
   */
  seoTitle?: string;
  /** Page `<h1>`. Falls back to `name`. */
  headline?: string;
  /** ≤ 90 chars. Shown on the hub card. */
  oneLiner: string;
  /** 1–3 short paragraphs. Shown at top of the integration page. */
  description: string[];
  /** Things the user needs before starting (besides Antseed itself). */
  prereqs?: string[];
  /** "Install <tool>" — only this tool's install steps. Antseed install is shared. */
  install: Step[];
  /** "Configure <tool>" — point it at the local Antseed proxy. */
  configure: ConfigBlock[];
  /** "Pick a model" hints. */
  modelHints?: {
    /** Recommended network model ids the user can try first. */
    suggested: string[];
    /** Free-form note about model selection in this tool. */
    note?: string;
  };
  /** "Test it" command(s). */
  test?: Step[];
  /** Known issues + fixes. */
  troubleshooting?: { problem: string; fix: string }[];
  /** Things that don't work / partially work / are coming. */
  caveats?: string[];
  /** External links: upstream docs, our skill, partner page. */
  links?: { label: string; href: string }[];
  /** Agent-friendly machine summary used by /llms-connect.txt. */
  agentSummary?: string;
  /** Command that installs this tool's Antseed skill. Defaults to the generic `join-buyer` skill. */
  agentSkill?: string;
};

const ANT_PORT = 8377;

/* ------------------------------------------------------------------ *
 * The list. Order here = order on the hub (within each category).
 * ------------------------------------------------------------------ */

export const integrations: Integration[] = [
  /* ---------------- Coding agents ---------------- */
  {
    slug: 'claude-code',
    name: 'Claude Code',
    logo: 'anthropic.png',
    category: 'coding-agent',
    format: 'anthropic-messages',
    setupMinutes: 2,
    status: 'verified',
    seoTitle: 'Run Claude Code on any model, no subscription',
    headline: 'Run Claude Code on any model',
    oneLiner: "Anthropic's official CLI agent - launch through Antseed with `antseed claude`.",
    description: [
      'Claude Code is the official CLI coding agent from Anthropic. It speaks the Anthropic Messages API natively, so it slots into Antseed through the `antseed claude` wrapper or by pointing `ANTHROPIC_BASE_URL` at your local proxy.',
      '`antseed claude` resolves the active buyer proxy, sets the placeholder Anthropic API key for the child process, and forwards the rest of your Claude Code flags unchanged. Manual environment variables still work if you want to run `claude` directly.',
      'No real Anthropic API key is needed - the Antseed proxy authenticates each request with your local identity (`ANTSEED_IDENTITY_HEX`) and settles payments on-chain. The `ANTHROPIC_API_KEY` value is required by the Anthropic SDK only as a non-empty placeholder.',
      'When Claude Code calls the Messages API, the proxy selects the highest-ranked eligible offer under the shared Price + Trust preferences. Stable session metadata gives the conversation soft affinity to the seller that actually served it, with failover when needed. Every model on the network (listed by <code>GET /v1/models</code>) is a valid <code>--model</code> value; prefix it with a peer id (<code>&lt;peerId&gt;@&lt;service-id&gt;</code>) only when you want to force a specific seller.',
    ],
    install: [
      { label: 'Install Claude Code globally', command: 'npm install -g @anthropic-ai/claude-code' },
      {
        label: 'Verify it runs',
        command: 'claude --version',
        output: '1.4.2 (Claude Code)',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: 'antseed claude --model kimi-k2.6',
        note:
          'Recommended: the wrapper reads the active buyer proxy from `buyer.state.json` or config, sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for Claude Code, and forwards extra Claude args. Add `--antseed-base-url http://host:port` only when your proxy is somewhere else. To route to a specific peer, prefix the model with its peer id: `antseed claude --model <peerId>@kimi-k2.6`.',
      },
      {
        kind: 'env',
        vars: {
          ANTHROPIC_BASE_URL: `http://localhost:${ANT_PORT}`,
          ANTHROPIC_API_KEY: 'antseed',
        },
        note: 'Manual equivalent if you want to run `claude` directly instead of through `antseed claude`.',
      },
    ],
    modelHints: {
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'minimax-m2.7', 'glm-5'],
      note: "`antseed claude --model <model-id>` passes the value to Claude Code unchanged. Use a model id returned by `curl http://localhost:8377/v1/models`. You can also route to a specific peer per session with `--model <peerId>@<service-id>`.",
    },
    test: [
      {
        label: 'List every model on the network',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"deepseek-v4-flash"
"gpt-oss-120b"
"kimi-k2.6"
"minimax-m2.7"`,
        note:
          'Any id here works with `--model` - the proxy applies the shared Price + Trust ranking and keeps soft conversation affinity after the first successful route. To force a specific seller, use `--model <peerId>@<service-id>` or `antseed buyer connection set --peer <peerId>`.',
      },
      {
        label: 'Start a Claude Code session through the wrapper',
        command: 'antseed claude --model kimi-k2.6',
        note: 'Manual equivalent after exporting the env vars above: `claude --model kimi-k2.6`. To pin a specific peer for the session: `antseed claude --model <peerId>@kimi-k2.6`.',
      },
    ],
    troubleshooting: [
      {
        problem: '"invalid x-api-key" or 401 from Anthropic SDK',
        fix: '`antseed claude` sets `ANTHROPIC_API_KEY=antseed` for you. If you run `claude` directly, set the variable to any non-empty string; the proxy ignores the value.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'With a model set, no pin is needed. Check the proxy is running and has discovered peers: `antseed buyer status` and `curl -s localhost:8377/_antseed/status`. If a stale session pin points at an offline peer, clear it with `antseed buyer connection clear`.',
      },
      {
        problem: '`model_not_found` for a model name you expected to work',
        fix: 'No policy-allowed peer on the network currently advertises that model. Check what is available with `curl http://localhost:8377/v1/models`, then pick another model or adjust your buyer policy.',
      },
      {
        problem: 'Want to confirm a request actually went through Antseed (not Anthropic direct)',
        fix: 'After the request completes, run `antseed buyer metering` - you\'ll see the channel for the peer Claude Code routed to, with token counts and the USDC settled. `antseed buyer status` shows the snapshot (pinned peer, active-channel count, deposits).',
      },
    ],
    links: [
      { label: 'Claude Code docs', href: 'https://docs.anthropic.com/en/docs/claude-code' },
      { label: 'Antseed skill: join-buyer', href: 'https://github.com/AntSeed/antseed/tree/main/skills/join-buyer' },
    ],
    agentSummary:
      'Prefer `antseed claude --model <model-id>`. It sets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY for Claude Code. Manual equivalent: set ANTHROPIC_BASE_URL=http://localhost:8377 and ANTHROPIC_API_KEY=antseed, then run `claude --model <model-id>`.',
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex CLI',
    logo: 'openai.png',
    category: 'coding-agent',
    format: 'openai-chat',
    setupMinutes: 2,
    status: 'verified',
    seoTitle: 'Run OpenAI Codex CLI on any model, pay per use',
    headline: 'Run OpenAI Codex CLI on any model',
    oneLiner: "OpenAI's official CLI coding agent - use `antseed codex` for per-run proxy config.",
    description: [
      "Codex is OpenAI's terminal coding agent. Recent versions ignore `OPENAI_BASE_URL` and instead read provider config from Codex settings.",
      '`antseed codex` supplies that provider config for one run with Codex `-c` overrides, points it at the active buyer proxy, sets the placeholder API key, and leaves your real `CODEX_HOME` untouched.',
      'If you prefer a persistent manual setup, create `~/.codex/antseed.config.toml` and launch Codex with `codex --profile antseed`; the wrapper is still the shortest path for one-off sessions.',
    ],
    install: [
      { label: 'Install Codex globally', command: 'npm install -g @openai/codex' },
      { label: 'Verify it runs', command: 'codex --version' },
    ],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: 'antseed codex --model deepseek-v4-flash',
        note:
          'Recommended: the wrapper resolves the proxy URL, injects an Antseed model provider with `wire_api = "responses"`, sets `ANTSEED_API_KEY=antseed`, and forwards extra Codex args. Put child flags after `--` when they look like wrapper flags. To route to a specific peer, prefix the model with its peer id: `antseed codex --model <peerId>@deepseek-v4-flash`.',
      },
      {
        kind: 'file',
        path: '~/.codex/antseed.config.toml',
        language: 'toml',
        snippet: `# Loaded by: codex --profile antseed
# Set this to any model id returned by http://localhost:${ANT_PORT}/v1/models
# (the network-wide list - no peer pin needed).
model = "deepseek-v4-flash"
model_provider = "antseed"

[model_providers.antseed]
name = "Antseed"
base_url = "http://localhost:${ANT_PORT}/v1"
wire_api = "responses"`,
        note:
          'Manual profile only: this must be your **user-level** `~/.codex/antseed.config.toml`, then launch with `codex --profile antseed`. If your buyer proxy uses a non-default port, update `base_url` to match it. Project-local `./.codex/config.toml` provider blocks are ignored by Codex.',
      },
      {
        kind: 'gui',
        instructions:
          'No real OpenAI key is needed. The Antseed proxy authenticates with your local buyer identity; the wrapper and manual profile both point Codex at the local proxy instead of OpenAI.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4-flash', 'kimi-k2.6', 'qwen3-coder-480b', 'minimax-m2.7'],
      note: 'Pass a network model id to `antseed codex --model <model-id>`. For a manual profile, set top-level `model = "<model-id>"` in `~/.codex/antseed.config.toml` or override with `codex --profile antseed --model <model-id>`. Route to a specific peer by prefixing its advertised service id: `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'List every model on the network',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"deepseek-v4-flash"
"gpt-oss-120b"
"kimi-k2.6"
"minimax-m2.7"`,
        note:
          'Whatever appears here is a valid value for top-level `model = ...` in `~/.codex/antseed.config.toml` (or for `codex --profile antseed --model <id>`).',
      },
      {
        label: 'Run Codex through the wrapper',
        command: 'antseed codex --model deepseek-v4-flash',
        note: 'Manual profile equivalent: `codex --profile antseed --model deepseek-v4-flash`.',
      },
      {
        label: 'Verify inference is actually paid through Antseed',
        command: 'antseed buyer balance   # or: antseed buyer status',
        outputLabel: 'What to look for after one real prompt',
        output: `Deposits available: 4.289391 USDC → 3.289391 USDC
Deposits reserved:           0 USDC → 1 USDC`,
        note:
          'The on-chain deposit numbers are the authoritative signal: a non-zero `Reserved` (channel opened) and/or a drop in `Available` (settled spend) after a real prompt confirms Antseed served the request. Re-run `antseed buyer balance` for a fresh read. Do not rely on `lsof -i | grep codex` or `~/.codex/log/codex-tui.log`: Codex keeps persistent TCP connections to Cloudflare/ChatGPT IPs (e.g. 172.64.0.0/13) for non-inference purposes (the cause was not isolated during testing), and the `provider=OpenAI` lines in the TUI log are not a reliable indicator that inference went to OpenAI - the on-chain numbers can show Antseed served the request despite that log line.',
      },
    ],
    troubleshooting: [
      {
        problem: '`OPENAI_BASE_URL` / `OPENAI_API_KEY` are being ignored',
        fix: 'Expected on recent Codex builds. Use `antseed codex --model <model-id>` so the wrapper injects the provider config for the current run, or use the manual `~/.codex/antseed.config.toml` profile above.',
      },
      {
        problem: 'How can I tell if Codex is actually routing through Antseed?',
        fix: 'Check `antseed buyer balance` (or `antseed buyer status`) after sending a test prompt. `Reserved` going from $0 to a non-zero value (a channel was opened) and/or `Available` dropping (spend settled) confirms Antseed served the request. If both stay flat after a real prompt, the profile is not being applied. Do not trust `lsof` connections to Cloudflare IPs or `provider=OpenAI` lines in `~/.codex/log/codex-tui.log` - neither is a reliable routing signal.',
      },
      {
        problem: 'Codex prints `Ignored unsupported project-local config keys … model_provider, model_providers`',
        fix: 'Provider settings must live in your **user-level** Codex profile file. For this manual flow, put the top-level `model`, `model_provider`, and `[model_providers.antseed]` block in `~/.codex/antseed.config.toml`, then relaunch with `codex --profile antseed`. Codex silently rejects provider blocks in project-local `./.codex/config.toml` and falls back to its default provider.',
      },
      {
        problem: 'Hand-written Codex `-c` provider overrides behave inconsistently',
        fix: 'Use `antseed codex --model <model-id>` so Antseed supplies the complete provider block (`base_url`, `wire_api`, and `model_provider`) for the current run. If managing config yourself, keep the full provider/profile in user-level `~/.codex/antseed.config.toml`.',
      },
      {
        problem: 'Streaming stops after the first chunk with a manual profile',
        fix: 'Use `antseed codex`, or set `wire_api = "responses"` in the manual `[model_providers.antseed]` block.',
      },
      {
        problem: '`unknown profile: antseed`',
        fix: 'Codex caches profile config on launch. Make sure you saved `~/.codex/antseed.config.toml`, then start a fresh `codex --profile antseed` session.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'With a model set, no pin is needed. Check the proxy is running and has discovered peers: `antseed buyer status` and `curl -s localhost:8377/_antseed/status`. If a stale session pin points at an offline peer, clear it with `antseed buyer connection clear`.',
      },
    ],
    links: [
      { label: 'Codex repo', href: 'https://github.com/openai/codex' },
      { label: 'Codex sample config', href: 'https://developers.openai.com/codex/config-sample' },
    ],
    agentSummary:
      'Prefer `antseed codex --model <model-id>`. It injects the Antseed Codex provider for one run using base_url=http://localhost:8377/v1 and wire_api="responses". Manual alternative: create user-level ~/.codex/antseed.config.toml with top-level model/model_provider plus [model_providers.antseed], then run `codex --profile antseed`.',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    glyph: 'OC',
    category: 'coding-agent',
    format: 'openai-chat',
    setupMinutes: 2,
    status: 'verified',
    seoTitle: 'Run OpenCode on any model, pay per request',
    headline: 'Run OpenCode on any model',
    oneLiner: 'Open-source AI coding agent - launch through Antseed with `antseed opencode`.',
    description: [
      'OpenCode is an MIT-licensed terminal coding agent built on the Vercel AI SDK. It supports 75+ providers out of the box and lets you register custom ones via <code>opencode.json</code>.',
      '`antseed opencode` creates that custom provider config in a temporary <code>opencode.json</code>, points OpenCode at it for the child process, and deletes it when the session exits. Manual project or global config still works if you want OpenCode to remember Antseed outside the wrapper.',
      'Antseed plugs in as a <strong>custom provider</strong> using the <code>@ai-sdk/openai-compatible</code> adapter - the same one OpenCode recommends for any OpenAI-compatible endpoint (LM Studio, llama.cpp, Atomic Chat, etc.). No <code>ANTHROPIC_BASE_URL</code>: OpenCode reads provider config from JSON.',
      'Each model you want to use must be listed under <code>models</code>. The id has to match what the buyer proxy returns from <code>GET /v1/models</code> - the network-wide model list, aggregated across all sellers.',
    ],
    install: [
      { label: 'Install OpenCode', command: 'npm install -g opencode-ai' },
      {
        label: 'Verify it runs',
        command: 'opencode --version',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: 'antseed opencode --model gpt-oss-120b',
        note:
          'Recommended: the wrapper resolves the proxy URL, writes a temporary OpenCode config with one Antseed model, sets `OPENCODE_CONFIG` for the child process, and forwards extra OpenCode args.',
      },
      {
        kind: 'file',
        path: 'opencode.json  (project root, or ~/.config/opencode/opencode.json for global)',
        language: 'json',
        snippet: `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antseed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antseed (peer-to-peer)",
      "options": {
        "baseURL": "http://localhost:${ANT_PORT}/v1",
        "apiKey": "antseed"
      },
      "models": {
        "kimi-k2.6":          { "name": "Kimi K2.6 (via Antseed)" },
        "deepseek-v4-flash":  { "name": "DeepSeek v4 Flash (via Antseed)" },
        "gpt-oss-120b":       { "name": "gpt-oss 120B (via Antseed)" }
      }
    }
  }
}`,
        note: 'Manual equivalent if you want OpenCode to keep Antseed in its normal project or global config.',
      },
    ],
    modelHints: {
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'minimax-m2.7', 'gpt-oss-120b'],
      note:
        '`antseed opencode --model <model-id>` generates a temporary config for that one id. In manual config, use model ids returned by `curl http://localhost:8377/v1/models` as the keys under `models`. Route to a specific peer by prefixing its advertised service id: `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'Confirm the proxy lists the same ids your config references',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"deepseek-v4-flash"
"gpt-oss-120b"
"kimi-k2.6"
"minimax-m2.7"`,
        note: 'Add or remove entries under `models` in `opencode.json` so they match this list.',
      },
      {
        label: 'Launch OpenCode through the wrapper',
        command: 'antseed opencode --model gpt-oss-120b',
        note:
          'Extra OpenCode args are forwarded, so `antseed opencode --model gpt-oss-120b run` works too. Manual config equivalent: run `opencode`, then pick one of the Antseed entries from `/models`.',
      },
    ],
    troubleshooting: [
      {
        problem: 'Antseed doesn\'t appear in `/connect` or `/models`',
        fix: 'With `antseed opencode`, pass a catalog model id via `--model`; the wrapper supplies a temporary config. With manual config, make sure `opencode.json` is in your project root (or `~/.config/opencode/opencode.json`) and that the JSON is valid - a stray comma silently disables the whole provider.',
      },
      {
        problem: 'Model is listed but every call returns `model_not_found`',
        fix: 'No policy-allowed peer on the network currently advertises that model. Check `curl http://localhost:8377/v1/models` and update the `models` keys in `opencode.json` to match.',
      },
      {
        problem: 'OpenCode prompts for an API key',
        fix: 'The proxy ignores auth, but the AI SDK sometimes asks anyway. Either skip the prompt (press enter on empty input) or set `"apiKey": "antseed"` inside `options` in `opencode.json`.',
      },
    ],
    links: [
      { label: 'OpenCode docs → Custom provider', href: 'https://opencode.ai/docs/providers/#custom-provider' },
      { label: 'OpenCode repo', href: 'https://github.com/sst/opencode' },
    ],
    agentSummary:
      'Prefer `antseed opencode --model <model-id>`. It creates a temporary OpenCode provider config using npm="@ai-sdk/openai-compatible", baseURL="http://localhost:8377/v1", apiKey="antseed", and one model entry. Manual alternative: put the same provider in opencode.json and run `opencode`.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    glyph: 'π',
    category: 'coding-agent',
    format: 'openai-responses',
    setupMinutes: 3,
    status: 'verified',
    seoTitle: 'Run the Pi coding agent on any model, pay per use',
    headline: 'Run Pi on any model',
    oneLiner: 'Open-source terminal coding agent with a first-class Antseed extension.',
    description: [
      '<strong>What Pi is.</strong> Pi (<code>@mariozechner/pi-coding-agent</code>) is a minimal, hackable terminal coding agent by Mario Zechner - the same lineage as <a href="https://github.com/badlogic/pi-mono">pi-mono</a>. It ships with four default tools (<code>read</code>, <code>write</code>, <code>edit</code>, <code>bash</code>) and lets you extend everything else - commands, providers, themes, even the editor UI - through TypeScript <em>extensions</em>, <em>skills</em>, and <em>prompt templates</em>. No fork required.',
      '<strong>What the Antseed extension does.</strong> <a href="https://github.com/AntSeed/pi-antseed"><code>pi-antseed</code></a> is a Pi extension that registers the local buyer proxy as a Pi provider named <code>antseed</code>. Once installed, every model on the network shows up under <code>antseed/&lt;id&gt;</code> in Pi\'s model picker (Ctrl+L or <code>/model</code>) - you switch with <code>/model antseed/minimax-m2.7</code> just like any built-in.',
      '<strong>Why an extension instead of env vars.</strong> Pi already speaks dozens of provider protocols natively. The extension calls <code>pi.registerProvider("antseed", { api: "openai-responses", authHeader: true, baseUrl: "http://localhost:8377/v1" })</code> - Pi then handles auth headers, streaming, retries, and tool-calling. The Responses API path preserves reasoning items across turns for reasoning-capable models, while the extension still auto-refreshes the model list from <code>GET /v1/models</code> so the menu reflects every model on the network.',
    ],
    install: [
      {
        label: 'Install Pi itself (the coding agent CLI)',
        command: 'npm install -g @mariozechner/pi-coding-agent',
        note:
          'Pi requires Node.js 20+. The binary is `pi`. Verify with `pi --version`. Without any extensions, Pi can already talk to Claude / GPT / Gemini / Groq / etc. via API key or OAuth - the Antseed extension below is what teaches it to route through your local buyer proxy.',
      },
      {
        label: 'Install the Antseed extension into Pi',
        command: 'pi install git:github.com/AntSeed/pi-antseed',
        note:
          'Pi extensions install from a git URL or a local path. Alternatives: `pi -e git:github.com/AntSeed/pi-antseed` runs the extension once without installing, useful for trying it out. `pi install ./pi-antseed` works from a local clone.',
      },
      {
        label: 'Reload Pi so the new provider is picked up',
        command: '/reload',
        note:
          'Run this inside the Pi REPL (after typing `pi` to launch it). It re-scans extensions, skills, prompt templates, keybindings, and context files. A full restart works too.',
      },
    ],
    configure: [
      {
        kind: 'env',
        vars: {
          ANTSEED_BASE_URL: `http://localhost:${ANT_PORT}/v1`,
        },
      },
      {
        kind: 'gui',
        instructions:
          'No GUI config needed in the common case - the extension reads `ANTSEED_BASE_URL` (default `http://localhost:8377/v1`) and discovers every model on the network automatically. Only set `ANTSEED_API_KEY` if you front the buyer proxy with your own auth layer, or `ANTSEED_MODELS="id1,id2"` to skip discovery and register a fixed list.',
      },
    ],
    modelHints: {
      suggested: ['minimax-m2.7', 'kimi-k2.6', 'deepseek-v4-flash', 'qwen3-coder-480b'],
      note:
        'The extension auto-discovers from `GET /v1/models` after Pi loads, so every model on the network shows up under `antseed/...`. Run `/reload` in Pi to refresh the list as the network changes. Route to a specific peer by prefixing the model id: `/model antseed/<peerId>@minimax-m2.7`.',
    },
    test: [
      {
        label: 'Launch Pi',
        command: 'pi',
        note:
          'You\'ll see Pi\'s startup header, which lists loaded extensions. Look for `antseed` (or `pi-antseed`) in that list - if it\'s there, the extension loaded successfully.',
      },
      {
        label: 'Open the model picker and pick an Antseed-routed model',
        command: '/model',
        note:
          'Or press Ctrl+L. The picker is fuzzy-searchable; type "antseed" to filter. You should see entries like `antseed/minimax-m2.7`, `antseed/deepseek-v4-flash`, etc. - one for each model on the network.',
      },
      {
        label: 'Or switch directly via slash command',
        command: '/model antseed/minimax-m2.7',
        note:
          'Replace `minimax-m2.7` with any id from `curl http://localhost:8377/v1/models`. After this, every prompt routes through Antseed using the buyer\'s shared Price + Trust preferences.',
      },
    ],
    troubleshooting: [
      {
        problem: '`pi: command not found` after install',
        fix:
          'Your global npm bin is not on `PATH`. Run `npm prefix -g` to find it, then add `<that-path>/bin` to `PATH` in your shell rc. Or use a Node version manager (nvm, fnm, volta) which handles this automatically.',
      },
      {
        problem: '`antseed` doesn\'t appear in the model picker (`/model` or Ctrl+L)',
        fix:
          'The extension didn\'t load. Re-run `pi install git:github.com/AntSeed/pi-antseed`, restart Pi, and watch the startup header - it lists every loaded extension and surfaces load errors there.',
      },
      {
        problem: 'Picker only shows a few hard-coded `antseed/...` ids, not what my peer offers',
        fix:
          'Pi started before the buyer proxy was up, so the extension fell back to its built-in seed list. Make sure `antseed buyer start` is running and has discovered peers (`antseed buyer status`), then run `/reload` inside Pi to refresh the model list.',
      },
      {
        problem: 'Empty `/v1/models` from the proxy',
        fix:
          'The proxy has not discovered any peers yet. Check `antseed buyer status` and `curl -s localhost:8377/_antseed/status`, then force re-discovery with `curl -s -X POST localhost:8377/_antseed/peers/refresh`.',
      },
      {
        problem: '5xx from the proxy mid-conversation',
        fix:
          'Usually `model_not_found` - no policy-allowed peer currently advertises the model you asked for. Check `curl localhost:8377/v1/models` and `/reload` in Pi. If a stale session pin points at an offline peer, clear it with `antseed buyer connection clear`.',
      },
      {
        problem: 'Want to use a custom buyer proxy URL (remote host, custom port)',
        fix:
          'Set `ANTSEED_BASE_URL=http://your-host:8377/v1` in the shell that launches `pi`. The extension reads this on startup. If your proxy is fronted by auth, also set `ANTSEED_API_KEY=<token>`.',
      },
    ],
    links: [
      { label: 'Pi coding agent (npm)', href: 'https://www.npmjs.com/package/@mariozechner/pi-coding-agent' },
      { label: 'Pi source (badlogic/pi-mono)', href: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent' },
      { label: 'pi-antseed extension', href: 'https://github.com/AntSeed/pi-antseed' },
    ],
    agentSummary:
      'Install Pi: `npm install -g @mariozechner/pi-coding-agent`. Install the Antseed extension: `pi install git:github.com/AntSeed/pi-antseed`. Restart or `/reload`. The extension calls `pi.registerProvider("antseed", { api: "openai-responses", baseUrl: "http://localhost:8377/v1" })` and auto-discovers every model on the network via GET /v1/models. Switch with `/model antseed/<model-id>`. Override base URL with `ANTSEED_BASE_URL` env var; auth with `ANTSEED_API_KEY`.',
  },

  /* ---------------- Autonomous agents ---------------- */
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    logo: 'openclaw.svg',
    category: 'agent-platform',
    format: 'anthropic-messages',
    setupMinutes: 3,
    status: 'verified',
    seoTitle: 'Run OpenClaw agents on any model, pay per use',
    headline: 'Run OpenClaw on any model',
    oneLiner: 'Open-source autonomous agent runtime - register Antseed as a custom provider in `openclaw.json`.',
    description: [
      '<strong>What OpenClaw is.</strong> OpenClaw is an open-source agent runtime for autonomous, long-running tasks (research, coding, web automation). It loads its provider catalog from <code>~/.openclaw/openclaw.json</code> - each entry is an HTTP endpoint plus a wire protocol (<code>anthropic-messages</code>, <code>openai-chat</code>, etc.) and a list of models.',
      '<strong>How Antseed plugs in.</strong> Add a provider entry called <code>antseed</code> with <code>api: "anthropic-messages"</code> and <code>authHeader: true</code>. Use <code>http://127.0.0.1:8377/v1</code> when OpenClaw runs beside the AI VPN. When it runs elsewhere, expand <strong>AI VPN → Agents → Define your internet-accessible Antseed endpoint</strong>, start ngrok or Cloudflare, and copy the displayed URL and API key.',
      '<strong>Why a config entry instead of env vars.</strong> OpenClaw runs many providers in parallel (one per task, sometimes one per agent). A single base-URL override would force every agent through Antseed; a named provider lets you mix Antseed with hosted Anthropic, OpenAI, or local models on a per-agent basis.',
    ],
    install: [
      {
        label: 'Install OpenClaw',
        command: 'npm install -g openclaw',
        note:
          'Verify with `openclaw --version`. OpenClaw has a newer Node.js support policy than Antseed, so use a Node version accepted by the current OpenClaw release. The config file lives at `~/.openclaw/openclaw.json` and is created on first launch.',
      },
    ],
    configure: [
      {
        kind: 'env',
        vars: {
          ANTSEED_BASE_URL: 'http://127.0.0.1:8377/v1',
          ANTSEED_API_KEY: 'antseed-p2p',
        },
        note:
          'Local setup: keep these defaults. Remote setup: in AI VPN → Agents, expand “Define your internet-accessible Antseed endpoint,” start ngrok or Cloudflare, then replace both values with the displayed URL and generated `antseed_...` key.',
      },
      {
        kind: 'file',
        path: '~/.openclaw/openclaw.json  (merge into the existing `models.providers` object)',
        language: 'json',
        snippet: `{
  "models": {
    "providers": {
      "antseed": {
        "baseUrl": "\${ANTSEED_BASE_URL}",
        "apiKey": "\${ANTSEED_API_KEY}",
        "authHeader": true,
        "api": "anthropic-messages",
        "models": [
          {
            "id": "antseed",
            "name": "Current AI VPN selection",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "kimi-k2.6",
            "name": "Kimi K2.6 (via Antseed)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 256000,
            "maxTokens": 8192
          },
          {
            "id": "deepseek-v4-flash",
            "name": "DeepSeek v4 Flash (via Antseed)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}`,
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: `# Follow the current AI VPN model picker for new agents:
openclaw models set "antseed/antseed"`,
      },
    ],
    modelHints: {
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'minimax-m2.7', 'gpt-oss-120b'],
      note:
        'The special `antseed` id follows the current AI VPN model picker. Every other `id` under `models[]` must match a model id from `GET /v1/models`. Keep `authHeader: true`: OpenClaw otherwise uses Anthropic-native authentication, while the public Antseed gateway requires `Authorization: Bearer <API_KEY>`. Route to a specific peer with `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'Confirm the proxy advertises the model ids you put in config',
        command: 'curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY" | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"deepseek-v4-flash"
"gpt-oss-120b"
"kimi-k2.6"
"minimax-m2.7"`,
        note:
          'If a model id you listed in `openclaw.json` doesn\'t appear here, no peer on the network currently serves it. Remove the entry or pick another model from the list.',
      },
      {
        label: 'Check the configured model catalog',
        command: 'openclaw models list',
        note:
          'Run `openclaw gateway restart` after editing the config. You should see the `antseed` provider and its configured models.',
      },
      {
        label: 'Run an agent against Antseed',
        command: 'openclaw agent exec "Summarize the README in this repo" --model antseed/kimi-k2.6',
      },
    ],
    troubleshooting: [
      {
        problem: '`provider "antseed" not found` when launching an agent',
        fix:
          'JSON parse error in `openclaw.json`, or you put the entry in the wrong nesting level. The provider must live under `models.providers.antseed`. Run `openclaw config validate` to surface parse errors.',
      },
      {
        problem: 'OpenClaw lists `antseed/<id>` but every call returns `502 model_not_found`',
        fix:
          'No policy-allowed peer currently advertises that model. Check `GET $ANTSEED_BASE_URL/models` with the bearer key and update `models[]`, or pick another model.',
      },
      {
        problem: 'Streaming errors on long-running agents',
        fix:
          'Antseed supports SSE streaming. If you see truncated responses, check that no proxy in front of OpenClaw is buffering (Cloudflare, nginx). The buyer proxy itself does not buffer.',
      },
      {
        problem: 'Agent stalls on first request after a deploy',
        fix:
          'Antseed opens a payment channel on the first request to a new peer (one on-chain transaction, ~5–15s on Base). Subsequent requests reuse the channel. Pre-warm by running a quick `curl` before launching the agent.',
      },
      {
        problem: 'OpenClaw runs remotely and cannot reach `127.0.0.1:8377`',
        fix:
          'Open AI VPN → Agents, expand “Define your internet-accessible Antseed endpoint,” and start ngrok or Cloudflare. Put the displayed `/v1` URL in `ANTSEED_BASE_URL`, the generated key in `ANTSEED_API_KEY`, and keep `authHeader: true`. Do not expose port 8377 directly.',
      },
    ],
    links: [
      { label: 'OpenClaw repo', href: 'https://github.com/openclaw/openclaw' },
      { label: 'OpenClaw model-provider docs', href: 'https://docs.openclaw.ai/concepts/model-providers' },
      {
        label: 'Antseed skill: openclaw-antseed (full walkthrough)',
        href: 'https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed',
      },
      { label: 'Antseed Agents guide', href: '/docs/agents' },
      { label: 'Antseed Public HTTPS Tunnels guide', href: '/docs/tunnels' },
    ],
    agentSummary:
      'Set ANTSEED_BASE_URL and ANTSEED_API_KEY to the local AI VPN values or the public URL/key from AI VPN → Agents. In models.providers.antseed use api="anthropic-messages" and authHeader=true, add model `antseed`, run `openclaw models set "antseed/antseed"`, then `openclaw gateway restart`.',
  },
  {
    slug: 'hermes',
    name: 'Hermes',
    logo: 'nousresearch.svg',
    category: 'agent-platform',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    seoTitle: 'Run Hermes agents on any model, pay per use',
    headline: 'Run Hermes on any model',
    oneLiner: "Nous Research's agent framework - add Antseed as a provider, or let Hermes set itself up.",
    description: [
      '<strong>What Hermes is.</strong> Hermes Agent is the open-source agent framework from <a href="https://nousresearch.com/">Nous Research</a>. It runs as a long-lived gateway (Telegram, Discord, Slack, …) and reads its model provider from its config.',
      '<strong>Fastest path: let Hermes do it.</strong> Install the <code>hermes-antseed</code> skill and tell your agent "set yourself up to run on Antseed". It snapshots its config, checks the buyer and your balance, tests which models actually answer, adds Antseed next to your current provider, switches only after a passing test, and asks you to send <code>/restart</code>.',
      '<strong>Doing it by hand</strong> is the same steps below. Use <code>hermes config set</code> for every change instead of pasting YAML: your <code>config.yaml</code> already has a <code>model:</code> block, and a second one breaks it.',
    ],
    prereqs: [
      'Hermes installed and answering (`hermes -z "hi"` replies).',
      'The Antseed buyer running and funded on the same machine: the AI VPN desktop app, or the CLI from Run Antseed first above. Check with `antseed buyer balance` (Available should be above 0).',
    ],
    install: [
      {
        label: 'Option A: install the skill and let Hermes set itself up',
        command: 'hermes skills install AntSeed/antseed/skills/hermes-antseed',
        note:
          'Then message your agent: "Set yourself up to run on Antseed using the hermes-antseed skill." It stops to ask you if the buyer is not running or not funded, and finishes by asking you to send `/restart`. Skip the rest of this page.',
      },
      {
        label: 'Option B (by hand): snapshot your config and note your current model',
        command: 'hermes backup --quick --label before-antseed\nhermes config get model.provider\nhermes config get model.default',
        note: 'Undo later from chat with `/snapshot restore <id>` (the id the backup prints), then `/restart`.',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: String.raw`try_model() {
  curl -s -m 90 http://127.0.0.1:8377/v1/chat/completions \
    -H 'Content-Type: application/json' -H 'Authorization: Bearer antseed-p2p' \
    -d "{\"model\":\"$1\",\"stream\":false,\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with: ok\"}]}" \
  | grep -q '"choices"' && echo "OK   $1" || echo "FAIL $1"
}
for m in kimi-k3 kimi-k2.6 glm-5.1 deepseek-v4-pro minimax-m2.7 deepseek-v4-flash; do try_model "$m"; done`,
        note:
          'Pick models that actually answer right now. Listed in `/v1/models` is not the same as servable: a model can be listed while no seller that meets your trust policy serves it. The test is non-streaming on purpose, because Hermes\' helper calls (titles, compression) are non-streaming. Use the first OK as your main model and a cheap OK one (`minimax-m2.7`, `deepseek-v4-flash`) as the helper. Each test costs a fraction of a cent.',
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: `hermes config set ANTSEED_API_KEY antseed-p2p
hermes config set providers.antseed.name Antseed
hermes config set providers.antseed.base_url http://127.0.0.1:8377/v1
hermes config set providers.antseed.key_env ANTSEED_API_KEY
hermes config set providers.antseed.api_mode chat_completions
hermes config set providers.antseed.default_model kimi-k3

# Test it before switching (your current provider is still the default):
hermes -z "Reply with exactly: antseed-ok" --provider antseed -m kimi-k3`,
        note:
          'Adds Antseed next to your current provider. `ANTSEED_API_KEY` goes into Hermes\' `.env`; the local proxy accepts any non-empty value. Replace `kimi-k3` with your main model from the test above. It must print `antseed-ok` before you continue.',
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: String.raw`# Save the 8 settings this step changes, to undo it exactly:
mkdir -p "$HOME/.antseed"
for k in model.provider model.default model.base_url model.api_mode \
         auxiliary.title_generation.provider auxiliary.title_generation.model \
         auxiliary.compression.provider auxiliary.compression.model; do
  if v="$(hermes config get "$k" 2>/dev/null </dev/null)"; then printf 'set\t%s\t%s\n' "$k" "$v"; else printf 'unset\t%s\n' "$k"; fi
done > "$HOME/.antseed/hermes-before-antseed.tsv"
cat "$HOME/.antseed/hermes-before-antseed.tsv"

hermes config set model.provider antseed
hermes config set model.default kimi-k3
hermes config set model.base_url ""
hermes config set model.api_mode chat_completions
hermes config set auxiliary.title_generation.provider antseed
hermes config set auxiliary.title_generation.model minimax-m2.7
hermes config set auxiliary.compression.provider antseed
hermes config set auxiliary.compression.model minimax-m2.7

hermes -z "Reply with exactly: default-ok"`,
        note:
          'Makes Antseed the default. If it does not print `default-ok`, put all 8 settings back with the next block.',
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: String.raw`# Only if default-ok failed: restore the saved settings
while IFS=$'\t' read -r state k v; do
  if [ "$state" = set ]; then hermes config set "$k" "$v" </dev/null; else hermes config unset "$k" </dev/null 2>/dev/null || true; fi
done < "$HOME/.antseed/hermes-before-antseed.tsv"
hermes -z "Reply with exactly: restored-ok"`,
        note:
          'Puts back each setting exactly as it was, including ones that were not set before. It must print `restored-ok`. If it does not, send `/snapshot restore <id>` in chat (the id from the backup), then `/restart`.',
      },
      {
        kind: 'gui',
        instructions:
          'Remote Hermes (buyer on another computer): in the AI VPN desktop app open Agents → Define your internet-accessible Antseed endpoint and start the public endpoint. Use the displayed `/v1` URL instead of `http://127.0.0.1:8377/v1` and the generated `antseed_...` key instead of `antseed-p2p`, in both the model test and the config commands. Never expose port 8377 directly.',
      },
    ],
    modelHints: {
      suggested: ['kimi-k3', 'glm-5.1', 'deepseek-v4-pro', 'minimax-m2.7', 'deepseek-v4-flash'],
      note:
        'Use a concrete model id that passed the test above. Do not use the id `antseed` unless you run the AI VPN desktop app and have picked a model there: on a CLI-only buyer it fails with `no_default_route`.',
    },
    test: [
      {
        label: 'Reload Hermes: send /restart in your Hermes chat',
        command: '/restart',
        language: 'text',
        note:
          'The running gateway only picks up the new model and the `ANTSEED_API_KEY` it reads from `.env` after a restart. `/restart` lets the current reply finish first. From a terminal instead: `hermes gateway restart`. Terminal-only use needs nothing: the next `hermes` session reads the new config.',
      },
      {
        label: 'Confirm requests are flowing and being paid',
        command: 'antseed buyer metering\nantseed buyer balance',
        note:
          'After the first request a payment channel opens (~5–15s on Base) and `metering` shows per-peer tokens and USDC. `balance` shows Available vs Reserved (funds held in open channels come back when they close).',
      },
    ],
    troubleshooting: [
      {
        problem: '`no_default_route`',
        fix: 'The model id `antseed` routes to the model picked in the AI VPN desktop app, and none is picked. Use a concrete id from the model test.',
      },
      {
        problem: '`model_not_found … No policy-allowed peer currently serves model`',
        fix: 'No seller that meets your trust and price policy serves that model right now. Run the model test again and pick another OK model.',
      },
      {
        problem: '`HTTP 400: Stream must be set to true`',
        fix: 'The model is served only over the streaming Responses protocol, and a non-streaming Hermes call hit it. Use main and helper models that passed the non-streaming test.',
      },
      {
        problem: '`402` / `insufficient_deposits`',
        fix: 'Not enough Available balance. `antseed buyer balance` shows Available vs Reserved; add funds with `antseed buyer deposit` (USDC on Base) or by card in the AI VPN desktop app.',
      },
      {
        problem: '`Unknown provider \'antseed\'`',
        fix: 'The provider block is missing or misspelled. Check `hermes config get providers.antseed` and rerun the `hermes config set providers.antseed.*` commands.',
      },
      {
        problem: 'Hermes still answers with the old model',
        fix: 'The gateway has not reloaded. Send `/restart` in your Hermes chat or run `hermes gateway restart`.',
      },
      {
        problem: 'A model id with a dot ends up as nested keys in `config.yaml`',
        fix: '`hermes config set` splits key paths on dots, so never put a model id in a key path (`providers.antseed.models.kimi-k2.6…`). The `models:` mapping is optional; model ids are fine as values (`hermes config set model.default kimi-k2.6`).',
      },
      {
        problem: 'Hermes runs on a remote host and can\'t reach `127.0.0.1:8377`',
        fix: 'Use the AI VPN public endpoint (see the remote note in Configure). Do not expose port 8377 directly.',
      },
    ],
    links: [
      { label: 'Hermes Agent (Nous Research)', href: 'https://github.com/NousResearch/hermes-agent' },
      { label: 'Hermes AI-provider docs', href: 'https://hermes-agent.nousresearch.com/docs/integrations/providers' },
      {
        label: 'Antseed skill: hermes-antseed (the steps above, written for your Hermes agent to follow)',
        href: 'https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed',
      },
      { label: 'Antseed Agents guide', href: '/docs/agents' },
      { label: 'Antseed Public HTTPS Tunnels guide', href: '/docs/tunnels' },
    ],
    agentSkill: 'hermes skills install AntSeed/antseed/skills/hermes-antseed',
    agentSummary:
      'Install the hermes-antseed skill and follow it. In short: `hermes backup --quick`; confirm the buyer answers at http://127.0.0.1:8377/v1 and `antseed buyer balance` shows Available > 0 (else stop and ask the user to fund it); test models with a real non-streaming chat completion; add the provider with `hermes config set providers.antseed.{name,base_url,key_env,api_mode,default_model}` plus `hermes config set ANTSEED_API_KEY antseed-p2p`; verify with `hermes -z ... --provider antseed -m <model>`; only then set `model.provider antseed` and `model.default <model>`; never paste YAML, never use model id `antseed` on a CLI-only buyer, never restart your own gateway: ask the user to send /restart.',
  },

  /* ---------------- (Additional frameworks) ---------------- */
  {
    slug: 'genlayer-studio',
    name: 'GenLayer Studio',
    logo: 'genlayer.svg',
    glyph: 'G',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    seoTitle: 'Add Antseed inference to GenLayer Studio',
    headline: 'Antseed inference in GenLayer Studio',
    oneLiner: 'Use Antseed as an inference provider inside GenLayer Studio validators.',
    description: [
      '<strong>What GenLayer Studio is.</strong> Studio runs <em>Intelligent Contract</em> validators that consult LLMs to reach consensus. Each validator is configured with a provider entry that has a <code>provider</code> name, a <code>plugin</code> (one of <code>openai-compatible</code> / <code>anthropic</code> / <code>google</code> / <code>ollama</code> / <code>custom</code>), a <code>model</code> id, and a <code>plugin_config</code> with <code>api_url</code> and <code>api_key_env_var</code>.',
      '<strong>How Antseed plugs in.</strong> Drop one JSON file per model into <code>backend/node/create_nodes/default_providers/</code> with <code>plugin: "openai-compatible"</code> and <code>api_url: "http://host.docker.internal:8377"</code>. Studio\'s openai-compatible plugin appends <code>/v1/chat/completions</code> automatically, so the buyer proxy receives a standard OpenAI Chat request and selects the highest-ranked eligible offer under the buyer\'s Price + Trust preferences. Mirror the existing LibertAI entry (PR #1526) - it is the closest analogue: an openai-compatible host with a hosted base URL replaced by your local proxy.',
      '<strong>Why <code>host.docker.internal</code>, not <code>localhost</code>.</strong> Studio\'s backend runs in Docker via <code>genlayer up</code>. From inside the container, <code>localhost</code> means the container itself, not your host machine - it cannot reach the Antseed buyer proxy on the host. Mac/Windows Docker exposes the host as <code>host.docker.internal</code>; on Linux you must add <code>extra_hosts: ["host.docker.internal:host-gateway"]</code> to the backend service in <code>docker-compose.yml</code> or run with <code>--network=host</code>.',
    ],
    prereqs: [
      'GenLayer Studio cloned and running locally with `genlayer up` (see https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio)',
    ],
    install: [
      {
        label: 'On Linux only - make `host.docker.internal` resolve from inside the backend container',
        language: 'yaml',
        command: `# docker-compose.yml - patch the backend (jsonrpc) service
services:
  jsonrpc:
    extra_hosts:
      - "host.docker.internal:host-gateway"`,
        note: 'Mac and Windows Docker Desktop already expose the host as `host.docker.internal` automatically - skip this step on those platforms. Restart with `genlayer up --reset` after editing.',
      },
    ],
    configure: [
      {
        kind: 'file',
        path: 'backend/node/create_nodes/default_providers/antseed_kimi-k2.6.json',
        language: 'json',
        snippet: `{
  "provider": "antseed",
  "plugin": "openai-compatible",
  "model": "kimi-k2.6",
  "config": {},
  "plugin_config": {
    "api_key_env_var": "ANTSEED_API_KEY",
    "api_url": "http://host.docker.internal:8377"
  }
}`,
      },
      {
        kind: 'file',
        path: 'backend/node/create_nodes/default_providers/antseed_deepseek-v4-flash.json',
        language: 'json',
        snippet: `{
  "provider": "antseed",
  "plugin": "openai-compatible",
  "model": "deepseek-v4-flash",
  "config": {},
  "plugin_config": {
    "api_key_env_var": "ANTSEED_API_KEY",
    "api_url": "http://host.docker.internal:8377"
  }
}`,
      },
      {
        kind: 'file',
        path: '.env  (next to docker-compose.yml)',
        language: 'bash',
        snippet: `# Antseed authenticates with your local identity key, not this value.
# Studio's openai-compatible plugin still requires the env var to be set.
ANTSEED_API_KEY=antseed`,
      },
      {
        kind: 'file',
        path: 'backend/node/create_nodes/providers_schema.json  AND  frontend/src/assets/schemas/providers_schema.json',
        language: 'json',
        snippet: `// In each schema, add "antseed" to the provider enum's examples…
"provider": {
  "type": "string",
  "examples": ["ollama", "openrouter", "libertai", "antseed", …]
},

// …and add an if/then block locking provider:antseed to plugin:openai-compatible
{
  "if":   { "properties": { "provider": { "const": "antseed" } } },
  "then": { "properties": { "plugin":   { "const": "openai-compatible" } } }
}`,
        note: 'Both schema files must be kept in sync - the backend uses one for validation, the frontend uses the other for the UI dropdown. This is exactly what PR #1526 did for LibertAI.',
      },
    ],
    modelHints: {
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note: 'Each provider JSON file defines exactly one `model`. Studio enumerates these into the validator-creation UI; pick model ids from the network-wide list (`curl http://localhost:8377/v1/models`). To expose more models later, drop in more `antseed_<model>.json` files - no schema edit needed. To lock a file to one specific peer, set `model` to `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'Restart Studio so it re-scans `default_providers/`',
        command: 'genlayer up --reset',
        note: '`get_default_providers()` in `backend/node/create_nodes/providers.py` reads every `*.json` in that folder once on boot, validates against `providers_schema.json`, and caches the result. Schema-validation errors abort startup with the offending file path - watch the logs.',
      },
      {
        label: 'In the Studio UI, create a new validator with provider "antseed"',
        note: 'You should see your `antseed_*.json` model ids in the dropdown. Save and trigger a contract that calls `genlayer.eq_principle.prompt(…)` - the request hits `http://host.docker.internal:8377/v1/chat/completions` on the Antseed proxy and is routed to the highest-ranked eligible offer under the buyer\'s Price + Trust preferences.',
      },
      {
        label: 'Confirm the validator call hit Antseed',
        command: 'antseed buyer metering',
        note: 'Each validator call adds tokens + USDC to the channel for the peer that served it. Run after a Studio request to see the totals update. To poll live: `watch -n 1 antseed buyer metering`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`Error validating file … antseed_*.json` on `genlayer up`',
        fix:
          'The schema rejected your provider JSON. Most common cause: missing the if/then rule for `provider:antseed`, so it falls through with the wrong `plugin`. Add the rule to *both* `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Run `genlayer up --reset` after editing.',
      },
      {
        problem: 'Validator hangs, then errors with `Connection refused` to `host.docker.internal:8377`',
        fix:
          'The backend container can\'t see your host. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` under the backend service in `docker-compose.yml` (see install step 2). On Mac/Windows, confirm Docker Desktop is running and the Antseed proxy is up: `curl http://host.docker.internal:8377/v1/models` from inside the container with `docker compose exec jsonrpc curl …`.',
      },
      {
        problem: 'Validator returns `no_peer_pinned`',
        fix:
          'This error only occurs on buyer proxies older than this release, or when a request carries no model at all. Upgrade the CLI (`npm install -g @antseed/cli`) - each `antseed_*.json` file names a `model`, and a request that names a model auto-selects a peer. To force a specific seller, set `model` to `<peerId>@<service-id>` or pin one with `antseed buyer connection set --peer <peerId>`.',
      },
      {
        problem: '`502 model_not_found` from a validator using e.g. `kimi-k2.6`',
        fix:
          'No policy-allowed peer on the network currently advertises that model. Check `curl http://localhost:8377/v1/models`. Either pick a model from that list or remove that `antseed_<model>.json` file.',
      },
      {
        problem: 'First call after a restart takes 5–15 seconds',
        fix:
          'Antseed opens a payment channel on the first request to a new peer (one Base-mainnet transaction). Subsequent calls reuse the channel. Pre-warm with `curl -s http://localhost:8377/v1/chat/completions -d \'{"model":"<id>","messages":[{"role":"user","content":"hi"}]}\'` before triggering Studio.',
      },
    ],
    caveats: [
      'Antseed is a local daemon, not a hosted endpoint. Every Studio operator must run the AI VPN or `antseed buyer start` on their own machine and fund their wallet - there is no central account.',
      'Free services exist on the Antseed network (`in: 0, out: 0`), but using paid ones requires a USDC deposit on Base. The AI VPN guides users through this on first launch; the CLI exposes it as `antseed buyer deposit`.',
    ],
    links: [
      { label: 'GenLayer Studio repo', href: 'https://github.com/genlayerlabs/genlayer-studio' },
      { label: 'Studio docs', href: 'https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio' },
      { label: 'Reference PR (LibertAI)', href: 'https://github.com/genlayerlabs/genlayer-studio/pull/1526' },
      { label: 'providers_schema.json (source of truth)', href: 'https://github.com/genlayerlabs/genlayer-studio/blob/main/backend/node/create_nodes/providers_schema.json' },
    ],
    agentSummary:
      'In GenLayer Studio: drop one JSON file per model into `backend/node/create_nodes/default_providers/` with `provider: "antseed"`, `plugin: "openai-compatible"`, `model: "<model-id>"`, and `plugin_config.api_url: "http://host.docker.internal:8377"` (NO `/v1` suffix - the plugin appends it). Add `"antseed"` to the provider enum and an if/then rule to BOTH `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Set `ANTSEED_API_KEY=antseed` in `.env`. Restart with `genlayer up --reset`. Running the AI VPN or `antseed buyer start` is enough - requests use the shared Price + Trust ranking for each listed `model` id. Set `model` to `<peerId>@<service-id>` only to force a specific seller.',
  },

  /* ---------------- Frameworks ---------------- */
  {
    slug: 'vercel-ai-sdk',
    name: 'Vercel AI SDK',
    glyph: '▲',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    seoTitle: 'Vercel AI SDK on any model, OpenAI-compatible',
    headline: 'Use Antseed with the Vercel AI SDK',
    oneLiner: "Use `@ai-sdk/openai-compatible` to call Antseed from `generateText` / `streamText` / `generateObject`.",
    description: [
      '<strong>What the AI SDK is.</strong> Vercel\'s <code>ai</code> package is a provider-agnostic TypeScript toolkit for building LLM apps and agents. You pick a <em>provider</em> (a small adapter package), instantiate a model from it, and pass that model into one of the framework\'s primitives: <code>generateText</code>, <code>streamText</code>, <code>generateObject</code>, or <code>streamObject</code>. The AI SDK handles tool-calling, structured output, message history, and streaming for you.',
      '<strong>How Antseed plugs in.</strong> Antseed is OpenAI-Chat-compatible at <code>http://localhost:8377/v1</code>, so the right adapter is <code>@ai-sdk/openai-compatible</code> (not <code>@ai-sdk/openai</code>). The official OpenAI provider is locked to OpenAI\'s API surface and quietly drops third-party fields; the openai-compatible provider is the one Vercel\'s own docs recommend for proxies, gateways, and any non-OpenAI server that speaks Chat Completions. You point it at the Antseed proxy with <code>baseURL</code> and pass any non-empty <code>apiKey</code> placeholder - the proxy authenticates with your local identity key, not with this header.',
      '<strong>Which model ids work.</strong> The first argument to the provider call is a model id from the Antseed catalog (e.g. <code>deepseek-v4-flash</code>, <code>kimi-k2.6</code>). Any model on the network works - list them with <code>curl http://localhost:8377/v1/models</code>. To route to a specific peer per call, prefix that peer offer\'s service id: <code>&lt;peerId&gt;@deepseek-v4-flash</code>.',
    ],
    prereqs: ['Node.js 18 or newer'],
    install: [
      {
        label: 'Install the SDK and the openai-compatible provider',
        command: 'npm install ai @ai-sdk/openai-compatible zod',
        note: '`zod` is only needed if you call `generateObject` / `streamObject`. Skip it for plain text generation.',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// antseed.ts - a single provider instance you can import everywhere
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const antseed = createOpenAICompatible({
  name: 'antseed',
  baseURL: 'http://localhost:8377/v1',
  apiKey: 'antseed', // any non-empty string - proxy ignores this header
  includeUsage: true, // surface token counts in streaming responses too
});`,
      },
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// stream.ts
import { streamText } from 'ai';
import { antseed } from './antseed';

const result = streamText({
  model: antseed('deepseek-v4-flash'), // an Antseed catalog model id
  // model: antseed('<peerId>@deepseek-v4-flash'), // …or pin a specific peer
  prompt: 'Why is the sky blue?',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

console.log('\\nusage:', await result.usage);`,
      },
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// structured.ts - generateObject works the same way
import { generateObject } from 'ai';
import { z } from 'zod';
import { antseed } from './antseed';

const { object } = await generateObject({
  model: antseed('deepseek-v4-flash'),
  schema: z.object({
    title: z.string(),
    bullets: z.array(z.string()).min(3).max(5),
  }),
  prompt: 'Summarize the Antseed buyer-proxy README as a slide.',
});
console.log(object);`,
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4-flash', 'kimi-k2.6', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note:
        'The string you pass to `antseed(\'<id>\')` is forwarded verbatim as `model` in the OpenAI Chat request. Run `curl -s http://localhost:8377/v1/models | jq \'.data[].id\'` to list every model on the network. `antseed(\'<peerId>@<id>\')` routes that one call to a specific peer.',
    },
    test: [
      {
        label: 'Run a smoke test with `tsx`',
        command: 'npx tsx stream.ts',
        outputLabel: 'Example output',
        output: `The sky is blue because shorter (blue) wavelengths of sunlight
scatter much more than longer (red) wavelengths in Earth's atmosphere…

usage: { promptTokens: 14, completionTokens: 78, totalTokens: 92 }`,
        note:
          'If you see `502 model_not_found`, no policy-allowed peer currently advertises the id you passed - check `curl localhost:8377/v1/models`. `no_peer_pinned` only occurs on proxies older than this release, or when the request carries no model at all - upgrade the CLI and/or pass a model id.',
      },
      {
        label: 'Per-request peer override (no session pin needed)',
        language: 'typescript',
        command: `// Use \`headers\` to fan out to different peers per call.
const result = streamText({
  model: antseed('deepseek-v4-flash'),
  prompt: 'hi',
  headers: {
    'x-antseed-pin-peer': 'cccccccccccccccccccccccccccccccccccccccc',
  },
});
// Equivalent without headers: antseed('cccccccccccccccccccccccccccccccccccccccc@deepseek-v4-flash')`,
        note:
          'Useful when one Node process serves many tenants and you want each request routed to a different peer. The header overrides the session pin for that single call.',
      },
    ],
    troubleshooting: [
      {
        problem: 'TypeScript complains that `antseed` has no call signature',
        fix:
          'You imported from `@ai-sdk/openai` instead of `@ai-sdk/openai-compatible`. Switch the package - the SDK\'s official OpenAI provider is locked to OpenAI\'s service ids and rejects unknown ones.',
      },
      {
        problem: '`generateObject` returns malformed JSON',
        fix:
          'The AI SDK is strict about JSON Schema support. Pass `supportsStructuredOutputs: true` to `createOpenAICompatible` only if the routed service supports OpenAI-style structured outputs natively. If unsure, leave it off - the SDK falls back to tool-call-based JSON which works everywhere.',
      },
      {
        problem: '`includeUsage` is set but `result.usage` is undefined',
        fix:
          'Some upstream providers behind Antseed do not emit usage on streamed responses. Try `generateText` instead of `streamText` for definitive token counts; otherwise run `antseed buyer metering` for the authoritative per-channel token + USDC totals Antseed itself measured.',
      },
      {
        problem: 'Browser/edge runtime fails with `fetch` errors',
        fix:
          'The Antseed proxy listens on `127.0.0.1:8377`, which is not reachable from a browser tab on a deployed site. The AI SDK is designed to run on the server (Route Handlers, Server Actions, edge functions on your own machine, or a Node process); don\'t call it from a client component when the model is Antseed.',
      },
    ],
    links: [
      { label: 'AI SDK docs', href: 'https://ai-sdk.dev/docs' },
      {
        label: '@ai-sdk/openai-compatible provider docs',
        href: 'https://ai-sdk.dev/providers/openai-compatible-providers',
      },
      { label: '`ai` on npm', href: 'https://www.npmjs.com/package/ai' },
    ],
    agentSummary:
      "createOpenAICompatible({ name: 'antseed', baseURL: 'http://localhost:8377/v1', apiKey: 'antseed' }), then antseed('<model-id>') as the model. Use @ai-sdk/openai-compatible (NOT @ai-sdk/openai). Model ids come from GET http://localhost:8377/v1/models. Per-request peer override: pass headers: { 'x-antseed-pin-peer': '<peerId>' } in generateText/streamText.",
  },
  {
    slug: 'langchain-python',
    name: 'LangChain (Python)',
    logo: 'langchain.svg',
    glyph: 'L',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    seoTitle: 'LangChain Python on any model, no OpenAI key',
    headline: 'Use Antseed with LangChain in Python',
    oneLiner: 'Drop-in `ChatOpenAI(base_url=…)` - works in chains, LCEL, and LangGraph agents.',
    description: [
      '<strong>What LangChain is.</strong> LangChain is the Python framework for composing LLMs with tools, retrievers, memory, and agents. The chat-model interface is <code>BaseChatModel</code>; <code>ChatOpenAI</code> from <code>langchain-openai</code> is a concrete subclass that talks the OpenAI Chat Completions wire format.',
      '<strong>How Antseed plugs in.</strong> Pass <code>base_url="http://localhost:8377/v1"</code> and any non-empty <code>api_key</code> to <code>ChatOpenAI</code>. Once you have an instance, every primitive that accepts a chat model - LCEL pipes (<code>prompt | llm | parser</code>), tool-calling agents, <code>create_react_agent</code>, LangGraph nodes, RAG chains, structured-output binding via <code>with_structured_output</code> - will route through Antseed without any further changes.',
      '<strong>One thing to know.</strong> LangChain\'s <code>ChatOpenAI</code> is OpenAI-strict by design: it will not preserve non-standard response fields like <code>reasoning_content</code>, <code>reasoning</code>, or <code>reasoning_details</code> that some third-party servers emit. For chat, tool-calling, and structured output this is fine. If you specifically need a model\'s reasoning traces, consider using the Antseed buyer proxy with the OpenAI Responses endpoint (<code>/v1/responses</code>) via a different provider package, or use a model that returns reasoning inline.',
    ],
    prereqs: ['Python 3.10 or newer'],
    install: [
      {
        label: 'Install LangChain and the OpenAI integration',
        command: 'pip install -U langchain langchain-openai',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'python',
        snippet: `# antseed_llm.py - import this once, reuse everywhere.
from langchain_openai import ChatOpenAI

antseed = ChatOpenAI(
    model="deepseek-v4-flash",          # an Antseed catalog model id
    # model="<peerId>@deepseek-v4-flash",  # …or pin a specific peer
    base_url="http://localhost:8377/v1",
    api_key="antseed",                   # any non-empty string
    temperature=0.7,
    # max_completion_tokens=2048,        # uncomment for hard caps
)

print(antseed.invoke("Hello").content)`,
      },
      {
        kind: 'code',
        language: 'python',
        snippet: `# pipeline.py - LCEL chain. Identical to OpenAI; the swap is invisible.
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from antseed_llm import antseed

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a concise technical writer."),
    ("human", "Explain {topic} in one paragraph."),
])

chain = prompt | antseed | StrOutputParser()
print(chain.invoke({"topic": "payment channels"}))`,
      },
      {
        kind: 'code',
        language: 'python',
        snippet: `# tools.py - tool-calling agent. Works because Antseed forwards OpenAI tool calls verbatim.
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from antseed_llm import antseed

@tool
def get_weather(city: str) -> str:
    """Return the current weather for a city."""
    return f"It's 22°C and sunny in {city}."

agent = create_react_agent(antseed, [get_weather])
result = agent.invoke({
    "messages": [("user", "What's the weather in Lisbon?")]
})
print(result["messages"][-1].content)`,
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4-flash', 'kimi-k2.6', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note:
        'Pick services whose `protocols` array includes `openai-chat-completions` (most do natively; the rest are translated automatically by `@antseed/api-adapter`). Tool calling and structured output rely on the service supporting OpenAI-style function-call syntax - confirm with a quick smoke test before building large agents. `model="<peerId>@<service-id>"` routes to a specific peer.',
    },
    test: [
      {
        label: 'Run the basic example',
        command: 'python antseed_llm.py',
        outputLabel: 'Example output',
        output: 'Hello! How can I help you today?',
      },
      {
        label: 'Per-request peer override (no session pin needed)',
        language: 'python',
        command: `# extra_headers is forwarded as-is to the proxy.
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-v4-flash",
    base_url="http://localhost:8377/v1",
    api_key="antseed",
    extra_headers={
        "x-antseed-pin-peer": "cccccccccccccccccccccccccccccccccccccccc",
    },
)
print(llm.invoke("hi").content)`,
        note: 'Use this when a single Python process needs to fan out to different peers per call (multi-tenant, scheduled jobs, A/B tests across peers).',
      },
      {
        label: 'Verify it actually went through Antseed',
        command: 'antseed buyer metering',
        note: '`buyer metering` reads the local SQLite log and prints per-channel token + USDC totals. After your `python` call, the channel for the peer that served it should show non-zero input/output tokens. (`buyer status` is a snapshot view - it shows the active-channel count but not per-call usage.)',
      },
    ],
    troubleshooting: [
      {
        problem: '`openai.NotFoundError: 404 … model_not_found`',
        fix:
          'No policy-allowed peer on the network currently advertises the id you passed. Confirm with `curl http://localhost:8377/v1/models | jq` and change the `model=` argument.',
      },
      {
        problem: '`openai.APIConnectionError: Connection refused`',
        fix:
          'The buyer proxy is not running. Start it with `antseed buyer start` (or open the AI VPN desktop app). Confirm `curl http://localhost:8377/v1/models` works before retrying from Python.',
      },
      {
        problem: '`with_structured_output` returns the right schema but empty fields',
        fix:
          'Either the routed model does not support OpenAI tool-call syntax, or you used `method="json_mode"` against a service that does not honor it. Try `method="function_calling"` (the default), and prefer services tagged `coding` or `tools` in `antseed network peer <peerId> --json`.',
      },
      {
        problem: 'Streaming with `stream=True` truncates mid-response',
        fix:
          'A buffering proxy (nginx, Cloudflare) sits between your code and the buyer proxy. The Antseed proxy itself does not buffer SSE. Either bypass the intermediate proxy or set its buffering off (`proxy_buffering off;` in nginx).',
      },
      {
        problem: 'Reasoning traces missing on a model you know emits them',
        fix:
          'See the third paragraph above: `langchain-openai` does not preserve non-standard response fields. For first-class reasoning support, route the request through the OpenAI Responses endpoint (`POST /v1/responses` on the proxy) using a Responses-aware client, or pick a model that puts reasoning inline in `content`.',
      },
    ],
    links: [
      { label: 'LangChain docs', href: 'https://python.langchain.com' },
      {
        label: 'ChatOpenAI integration page',
        href: 'https://docs.langchain.com/oss/python/integrations/chat/openai',
      },
      { label: '`langchain-openai` on PyPI', href: 'https://pypi.org/project/langchain-openai/' },
    ],
    agentSummary:
      "ChatOpenAI(model='<model-id>', base_url='http://localhost:8377/v1', api_key='antseed') from langchain-openai. Drops into LCEL, create_react_agent, RAG, with_structured_output. Per-request peer override: extra_headers={'x-antseed-pin-peer': '<peerId>'}. Model ids come from GET http://localhost:8377/v1/models. Reasoning traces (reasoning_content, etc.) are NOT preserved by ChatOpenAI - use the Responses endpoint for those.",
  },

  /* ---------------- Raw HTTP ---------------- */
  {
    slug: 'curl',
    name: 'curl / raw HTTP',
    glyph: '$',
    category: 'cli',
    format: 'multi',
    setupMinutes: 1,
    status: 'verified',
    seoTitle: 'Call any LLM over plain HTTP with curl, no SDK',
    headline: 'Call Antseed with curl or raw HTTP',
    oneLiner: 'Hit the proxy with plain HTTP - useful for scripts and debugging.',
    description: [
      'The buyer proxy is a vanilla HTTP server. Anything that can issue an HTTP POST works. Three endpoints are exposed:',
      '• `POST /v1/messages` - Anthropic Messages format\n• `POST /v1/chat/completions` - OpenAI Chat Completions\n• `POST /v1/responses` - OpenAI Responses API',
    ],
    install: [],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: `# Anthropic format
curl http://localhost:8377/v1/messages \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "kimi-k2.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI Chat format
curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Follow the model currently selected in AI VPN:
curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "antseed",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Route to a specific peer: prefix the model with "<peerId>@"
curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "<peerId>@deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
    ],
    agentSummary:
      'POST JSON to http://localhost:8377/v1/messages, /v1/chat/completions, or /v1/responses. No Authorization header required. Model field accepts `antseed` to follow the AI VPN picker, "<model-id>" for automatic routing, or "<peerId>@<service-id>" to route to a specific peer.',
  },
];

/* ------------------------------------------------------------------ *
 * Helpers consumed by the connect pages and skill.md generator.
 * ------------------------------------------------------------------ */

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  'coding-agent': 'Coding agents',
  'agent-platform': 'Autonomous agents',
  framework: 'Frameworks',
  cli: 'Raw HTTP',
};

export const CATEGORY_TAGLINES: Record<IntegrationCategory, string> = {
  'coding-agent':
    "Drop-in for Claude Code, Codex, and friends. Set one env var, keep your existing workflow.",
  'agent-platform':
    "Long-running, autonomous workloads. Agents pick providers by price, latency, and reputation - no API keys, no SaaS account.",
  framework:
    "LangChain, Vercel AI SDK, GenLayer Studio, and other multi-provider frameworks. Add Antseed as one of the providers.",
  cli:
    "The lowest-level contract. Use this if you're scripting, debugging, or building a new integration.",
};

/** Order in which category sections render on the hub. */
export const CATEGORY_ORDER: IntegrationCategory[] = [
  'coding-agent',
  'agent-platform',
  'framework',
  'cli',
];

export const FORMAT_LABELS: Record<IntegrationFormat, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  multi: 'Multi-format',
};

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  verified: 'Verified',
  community: 'Community',
  'coming-soon': 'Coming soon',
};
