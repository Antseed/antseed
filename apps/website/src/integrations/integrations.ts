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

/** Endpoint each wire format hits, on a gateway or the local buyer proxy. */
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

/** `title` labels a block, e.g. to tell the gateway setup from the local buyer proxy one. */
export type ConfigBlock = { title?: string } & (
  | { kind: 'env'; vars: Record<string, string>; note?: string }
  | { kind: 'file'; path: string; language: string; snippet: string; note?: string }
  | { kind: 'code'; language: string; snippet: string; note?: string }
  | { kind: 'gui'; instructions: string; note?: string }
);

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
  /** "Configure <tool>" — point it at a gateway (first) or the local buyer proxy. */
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

/**
 * Endpoints the snippets use. A gateway is the recommended endpoint: it works
 * from any machine and needs a key (sent as `Authorization: Bearer`). The local
 * buyer proxy only listens on 127.0.0.1, so it serves tools on the same computer.
 */
const GATEWAY_ROOT = 'https://gateway.example.com';
const GATEWAY_URL = `${GATEWAY_ROOT}/v1`;
const LOCAL_GATEWAY_URL = 'http://localhost:8379/v1';
const LOCAL_PROXY_URL = `http://localhost:${ANT_PORT}/v1`;
const GATEWAY_KEY = 'antseed_…';

/** Lists every model on the network through the endpoint in ANTSEED_BASE_URL. */
export const LIST_MODELS_COMMAND =
  `curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY" | jq '.data[].id'`;

/** Env block every gateway setup below reads: the gateway's base URL and an API key. */
function gatewayEnv(extraNote?: string): ConfigBlock {
  return {
    title: 'Recommended: a gateway',
    kind: 'env',
    vars: {
      ANTSEED_BASE_URL: GATEWAY_URL,
      ANTSEED_API_KEY: GATEWAY_KEY,
    },
    note: [
      `Your gateway's base URL, ending in \`/v1\`, and an API key from the Keys page of its console. Recommended: a gateway on a server, which every machine can reach. A gateway on this computer is \`${LOCAL_GATEWAY_URL}\`; publish it with a tunnel (\`antseed tunnel start\`, or Agents → Internet-accessible endpoint in the desktop app) for other machines. No gateway yet: see Run Antseed first above.`,
      extraNote,
    ].filter(Boolean).join(' '),
  };
}

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
    oneLiner: "Anthropic's official CLI agent - point it at your Antseed gateway, or launch it with `antseed claude`.",
    description: [
      'Claude Code is the official CLI coding agent from Anthropic. It speaks the Anthropic Messages API natively, so it connects to Antseed with two environment variables: <code>ANTHROPIC_BASE_URL</code> for the endpoint and <code>ANTHROPIC_AUTH_TOKEN</code> for the key.',
      'Using the <a href="/docs/desktop">desktop app (AI VPN)</a> on the same computer? The quickest route is <strong>Connected apps</strong>: connect Claude Code there, then pick the model in the app, per conversation, without touching any config.',
      'Otherwise, the recommended endpoint is a gateway: it gives Claude Code its own API key with budgets and usage logs, and it works from any machine. The gateway only accepts the key as <code>Authorization: Bearer</code>, which is what <code>ANTHROPIC_AUTH_TOKEN</code> sends. When Claude Code runs on the same computer as a buyer, <code>antseed claude</code> launches it against the local buyer proxy instead, with no key.',
      'No Anthropic API key or subscription is needed. Antseed pays sellers per request in USDC from your gateway workspace wallet or your buyer deposit.',
      'When Claude Code calls the Messages API, Antseed selects the highest-ranked eligible offer under your Price + Trust preferences. Stable session metadata gives the conversation soft affinity to the seller that actually served it, with failover when needed. Every model on the network (listed by <code>GET /v1/models</code>) is a valid <code>--model</code> value; prefix it with a peer id (<code>&lt;peerId&gt;@&lt;service-id&gt;</code>) only when you want to force a specific seller.',
    ],
    install: [
      { label: 'Install Claude Code globally', command: 'npm install -g @anthropic-ai/claude-code' },
      {
        label: 'Verify it runs',
        command: 'claude --version',
      },
    ],
    configure: [
      {
        title: 'Recommended: a gateway',
        kind: 'env',
        vars: {
          ANTHROPIC_BASE_URL: GATEWAY_ROOT,
          ANTHROPIC_AUTH_TOKEN: GATEWAY_KEY,
        },
        note: `Your gateway's address without \`/v1\` (Claude Code adds \`/v1/messages\` itself) and an API key from the Keys page of its console. For a gateway on this computer use \`http://localhost:8379\`. Use \`ANTHROPIC_AUTH_TOKEN\`, not \`ANTHROPIC_API_KEY\`: the gateway reads the key from \`Authorization: Bearer\`, and \`ANTHROPIC_API_KEY\` sends it as \`x-api-key\`. Then run \`claude --model deepseek-v4.1-flash\`.`,
      },
      {
        title: 'Same computer, no gateway: the local buyer proxy',
        kind: 'code',
        language: 'bash',
        snippet: 'antseed claude --model deepseek-v4.1-flash',
        note:
          'The wrapper reads the running buyer proxy from `buyer.state.json` or config, sets `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_API_KEY` for Claude Code, and forwards extra Claude args. The proxy only listens on localhost and checks no key. Manual equivalent: `ANTHROPIC_BASE_URL=http://localhost:8377 ANTHROPIC_API_KEY=antseed claude --model deepseek-v4.1-flash`. The wrapper always targets a buyer proxy; for a gateway use the variables above.',
      },
      {
        title: 'Background tasks, subagents and context window',
        kind: 'env',
        vars: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4.1-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4.1-flash',
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
        },
        note: 'Claude Code also sends background tasks and subagents to other model names (Claude Haiku, for example), and those requests reach Antseed too. Set the first two so they use an open model as well. Claude Code does not know open model ids and assumes a 200k context window; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the context length on the model card so it compacts at the right point.',
      },
      {
        kind: 'file',
        path: '~/.claude/settings.json',
        language: 'json',
        snippet: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${GATEWAY_ROOT}",
    "ANTHROPIC_AUTH_TOKEN": "${GATEWAY_KEY}",
    "ANTHROPIC_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4.1-flash",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000"
  }
}`,
        note: 'Optional: to run plain `claude` through Antseed every time, put the settings in Claude Code\'s own settings file instead of the environment. For the local buyer proxy, use `"ANTHROPIC_BASE_URL": "http://localhost:8377"` and `"ANTHROPIC_API_KEY": "antseed"` instead of the first two.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3'],
      note: "`--model` is passed to Claude Code unchanged, so any id returned by `GET /v1/models` works; pick a seller that lists tool use, since Claude Code needs it for every file edit and command. Route to a specific peer per session with `--model <peerId>@<service-id>`. On a gateway you can also use a preset: `--model @preset/<slug>`.",
    },
    test: [
      {
        label: 'List every model on the network',
        command: 'curl -s "$ANTHROPIC_BASE_URL/v1/models" -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"deepseek/deepseek-v4.1-flash"
"moonshotai/kimi-k3"
"z-ai/glm-5.2"
"z-ai/glm-5.3-flash"`,
        note:
          'Any id here works with `--model`, and so does the short name without the vendor prefix (`deepseek-v4.1-flash`). Against the local buyer proxy, drop the header: `curl -s http://localhost:8377/v1/models`.',
      },
      {
        label: 'Start a Claude Code session',
        command: 'claude --model deepseek-v4.1-flash',
        note: 'Through the local buyer proxy instead: `antseed claude --model deepseek-v4.1-flash`. To pin a specific peer: `--model <peerId>@deepseek-v4.1-flash`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`401` from the gateway, or "invalid x-api-key"',
        fix: 'Send the gateway key as `ANTHROPIC_AUTH_TOKEN` and unset `ANTHROPIC_API_KEY`. The gateway only reads `Authorization: Bearer`. Against the local buyer proxy any non-empty `ANTHROPIC_API_KEY` works; `antseed claude` sets one for you.',
      },
      {
        problem: '`404` on every request',
        fix: '`ANTHROPIC_BASE_URL` must not end in `/v1`: Claude Code appends `/v1/messages` itself.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'With a gateway, check that it answers: `curl -s "$ANTHROPIC_BASE_URL/v1/models" -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"`. With the local buyer proxy, check `antseed buyer status` and `curl -s localhost:8377/_antseed/status`; if a stale session pin points at an offline peer, clear it with `antseed buyer connection clear`.',
      },
      {
        problem: '`model_not_found` for a model name you expected to work',
        fix: 'No seller your routing policy allows currently offers that model. Check `GET /v1/models`, then pick another model or adjust the policy (the key or workspace routing policy on a gateway, buyer preferences locally).',
      },
      {
        problem: '`402 insufficient_deposits` even though a free seller offers the model',
        fix: 'With automatic routing, Claude Code\'s requests can still land on a paid seller. Add funds (the workspace wallet in the gateway console, or `antseed buyer deposit` for a local buyer), or pin the free seller: `--model <peerId>@<model>`. `antseed network browse --service <model>` lists sellers and their prices.',
      },
      {
        problem: 'Claude Code says it doesn\'t recognize the model and assumes a 200k context window',
        fix: 'Expected for open model ids. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model\'s real context length so Claude Code compacts at the right point.',
      },
      {
        problem: 'Want to confirm a request actually went through Antseed (not Anthropic direct)',
        fix: 'On a gateway, the request shows up in the console under Logs, with the seller, tokens and cost. With the local buyer proxy, run `antseed buyer metering` to see the channel for the peer Claude Code routed to, with token counts and the USDC settled.',
      },
    ],
    links: [
      { label: 'Claude Code docs', href: 'https://docs.anthropic.com/en/docs/claude-code' },
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
      { label: 'Antseed skill: join-buyer', href: 'https://github.com/AntSeed/antseed/tree/main/skills/join-buyer' },
    ],
    agentSummary:
      'Gateway (recommended, works from any machine): set ANTHROPIC_BASE_URL=<gateway root, no /v1> and ANTHROPIC_AUTH_TOKEN=<gateway key> (Bearer; not ANTHROPIC_API_KEY), then run `claude --model <model-id>`. Same computer as a buyer, no gateway: `antseed claude --model <model-id>` (sets ANTHROPIC_BASE_URL=http://localhost:8377 and a placeholder ANTHROPIC_API_KEY).',
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex CLI',
    logo: 'openai.png',
    category: 'coding-agent',
    format: 'openai-responses',
    setupMinutes: 2,
    status: 'verified',
    seoTitle: 'Run OpenAI Codex CLI on any model, pay per use',
    headline: 'Run OpenAI Codex CLI on any model',
    oneLiner: "OpenAI's official CLI coding agent - add your Antseed gateway as a Codex provider, or launch it with `antseed codex`.",
    description: [
      "Codex is OpenAI's terminal coding agent. Recent versions ignore `OPENAI_BASE_URL` and instead read provider config from Codex settings, so Antseed plugs in as a custom model provider that speaks the Responses API.",
      'The recommended endpoint is a gateway: add it as a provider in your user-level <code>~/.codex/config.toml</code>, with the gateway key in <code>ANTSEED_API_KEY</code>. That works from any machine and gives Codex its own budget and usage log.',
      'When Codex runs on the same computer as a buyer, <code>antseed codex</code> supplies the provider config for one run with Codex <code>-c</code> overrides, points it at the local buyer proxy, and leaves your real <code>CODEX_HOME</code> untouched.',
    ],
    install: [
      { label: 'Install Codex globally', command: 'npm install -g @openai/codex' },
      { label: 'Verify it runs', command: 'codex --version' },
    ],
    configure: [
      gatewayEnv('Export both in the shell that starts Codex.'),
      {
        kind: 'file',
        path: '~/.codex/config.toml',
        language: 'toml',
        snippet: `model = "@preset/coder"
model_provider = "antseed"
# Codex doesn't know open model ids; set the model's context length so it compacts in time.
model_context_window = 128000

[model_providers.antseed]
name = "Antseed gateway"
base_url = "${GATEWAY_URL}"
env_key = "ANTSEED_API_KEY"
wire_api = "responses"`,
        note:
          'Set `base_url` to your gateway URL ending in `/v1`; Codex reads the key from `ANTSEED_API_KEY`. `@preset/coder` is a gateway preset (create one under Presets in the console): with a raw model name, Codex can switch to a tool format some providers drop. A model id from `GET /v1/models` works too. Provider settings must live in your user-level config; Codex ignores them in a project-local `./.codex/config.toml`.',
      },
      {
        title: 'Same computer, no gateway: the local buyer proxy',
        kind: 'code',
        language: 'bash',
        snippet: 'antseed codex --model deepseek-v4.1-flash',
        note:
          'The wrapper resolves the local proxy URL, injects an Antseed model provider with `wire_api = "responses"`, sets a placeholder `ANTSEED_API_KEY`, and forwards extra Codex args. Put child flags after `--` when they look like wrapper flags. To route to a specific peer, prefix the model with its peer id: `antseed codex --model <peerId>@deepseek-v4.1-flash`.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3'],
      note: 'Set top-level `model = "<model-id>"` in `~/.codex/config.toml`, or override per run with `codex --model <model-id>`. With the wrapper, pass `antseed codex --model <model-id>`. Route to a specific peer by prefixing its advertised service id: `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'List every model on the network',
        command: LIST_MODELS_COMMAND,
        outputLabel: 'Example response',
        output: `"deepseek/deepseek-v4.1-flash"
"moonshotai/kimi-k3"
"z-ai/glm-5.2"
"z-ai/glm-5.3-flash"`,
        note:
          'Whatever appears here, or the short name without the vendor prefix (`deepseek-v4.1-flash`), is a valid `model` value. Against the local buyer proxy: `curl -s http://localhost:8377/v1/models`.',
      },
      {
        label: 'Run Codex',
        command: 'codex',
        note: 'Through the local buyer proxy instead: `antseed codex --model deepseek-v4.1-flash`.',
      },
      {
        label: 'Verify inference is actually paid through Antseed',
        command: 'antseed buyer balance   # local buyer proxy only',
        outputLabel: 'What to look for after one real prompt',
        output: `Deposits available: 4.289391 USDC → 3.289391 USDC
Deposits reserved:           0 USDC → 1 USDC`,
        note:
          'On a gateway, the request shows up in the console under Logs, with the seller, tokens and cost. With the local buyer proxy, a non-zero `Reserved` (channel opened) and/or a drop in `Available` (settled spend) after a real prompt confirms Antseed served the request. Do not rely on `lsof -i | grep codex` or `~/.codex/log/codex-tui.log`: Codex keeps persistent TCP connections to Cloudflare/ChatGPT IPs for non-inference purposes, and the `provider=OpenAI` lines in the TUI log are not a reliable indicator that inference went to OpenAI.',
      },
    ],
    troubleshooting: [
      {
        problem: '`OPENAI_BASE_URL` / `OPENAI_API_KEY` are being ignored',
        fix: 'Expected on recent Codex builds. Add the `[model_providers.antseed]` block above to `~/.codex/config.toml`, or use `antseed codex --model <model-id>` with a local buyer proxy.',
      },
      {
        problem: '`401` from the gateway',
        fix: 'Export `ANTSEED_API_KEY` with your gateway key in the shell that starts Codex, and keep `env_key = "ANTSEED_API_KEY"` in the provider block.',
      },
      {
        problem: 'How can I tell if Codex is actually routing through Antseed?',
        fix: 'On a gateway, check Logs in the console after a test prompt. With the local buyer proxy, check `antseed buyer balance`: `Reserved` going from $0 to a non-zero value and/or `Available` dropping confirms Antseed served the request. Do not trust `lsof` connections to Cloudflare IPs or `provider=OpenAI` lines in `~/.codex/log/codex-tui.log`.',
      },
      {
        problem: 'Codex prints `Ignored unsupported project-local config keys … model_provider, model_providers`',
        fix: 'Provider settings must live in your user-level `~/.codex/config.toml`. Codex rejects provider blocks in a project-local `./.codex/config.toml` and falls back to its default provider.',
      },
      {
        problem: 'Tool calls fail or Codex switches tool formats mid-session',
        fix: 'Use a gateway preset as the model (`model = "@preset/coder"`), as recommended in the gateway API docs.',
      },
      {
        problem: 'Streaming stops after the first chunk',
        fix: 'Set `wire_api = "responses"` in the `[model_providers.antseed]` block (the wrapper does this for you).',
      },
      {
        problem: '`Model metadata for … not found. Defaulting to fallback metadata`',
        fix: 'Expected for open model ids. `antseed codex` sets a context window for you; in `~/.codex/config.toml`, set `model_context_window` to the model\'s context length.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'Check the endpoint answers: `curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY"`. With the local buyer proxy, also check `antseed buyer status`; if a stale session pin points at an offline peer, clear it with `antseed buyer connection clear`.',
      },
    ],
    links: [
      { label: 'Codex repo', href: 'https://github.com/openai/codex' },
      { label: 'Codex sample config', href: 'https://developers.openai.com/codex/config-sample' },
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
    ],
    agentSummary:
      'Gateway (recommended): in user-level ~/.codex/config.toml set model_provider="antseed" and [model_providers.antseed] with base_url=<gateway URL ending in /v1>, env_key="ANTSEED_API_KEY", wire_api="responses"; export ANTSEED_API_KEY=<gateway key>; prefer a gateway preset (model="@preset/<slug>") over a raw model name. Same computer as a buyer, no gateway: `antseed codex --model <model-id>` injects the provider for one run against http://localhost:8377/v1.',
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
    oneLiner: 'Open-source AI coding agent - add your Antseed gateway as a custom provider, or launch it with `antseed opencode`.',
    description: [
      'OpenCode is an MIT-licensed terminal coding agent built on the Vercel AI SDK. It supports 75+ providers out of the box and lets you register custom ones via <code>opencode.json</code>.',
      'Antseed plugs in as a <strong>custom provider</strong> using the <code>@ai-sdk/openai-compatible</code> adapter - the same one OpenCode recommends for any OpenAI-compatible endpoint. The recommended endpoint is a gateway: set its URL as <code>baseURL</code> and read its key from <code>ANTSEED_API_KEY</code>, and OpenCode works from any machine with its own budget and usage log.',
      'When OpenCode runs on the same computer as a buyer, <code>antseed opencode</code> writes a temporary <code>opencode.json</code> that points at the local buyer proxy, uses it for the child process, and deletes it when the session exits.',
      'Each model you want to use must be listed under <code>models</code>. The id has to match one returned by <code>GET /v1/models</code> - the network-wide model list, aggregated across all sellers.',
    ],
    install: [
      { label: 'Install OpenCode', command: 'npm install -g opencode-ai' },
      {
        label: 'Verify it runs',
        command: 'opencode --version',
      },
    ],
    configure: [
      gatewayEnv('Export both in the shell that starts OpenCode.'),
      {
        kind: 'file',
        path: 'opencode.json  (project root, or ~/.config/opencode/opencode.json for global)',
        language: 'json',
        snippet: `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antseed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antseed",
      "options": {
        "baseURL": "${GATEWAY_URL}",
        "apiKey": "{env:ANTSEED_API_KEY}"
      },
      "models": {
        "deepseek-v4.1-flash": {
          "name": "DeepSeek V4.1 Flash (via Antseed)",
          "limit": { "context": 128000, "output": 8192 }
        },
        "glm-5.2": {
          "name": "GLM-5.2 (via Antseed)",
          "limit": { "context": 128000, "output": 8192 }
        },
        "kimi-k3": {
          "name": "Kimi K3 (via Antseed)",
          "limit": { "context": 128000, "output": 8192 }
        }
      }
    }
  }
}`,
        note: 'Set `baseURL` to your gateway URL ending in `/v1`, and `limit.context` to each model\'s context length: OpenCode uses it to decide when to compact the conversation. `{env:ANTSEED_API_KEY}` makes OpenCode read the key from the environment, so it stays out of the file. For the local buyer proxy, use `http://localhost:8377/v1` and `"apiKey": "antseed"`.',
      },
      {
        title: 'Same computer, no gateway: the local buyer proxy',
        kind: 'code',
        language: 'bash',
        snippet: 'antseed opencode --model deepseek-v4.1-flash',
        note:
          'The wrapper resolves the local proxy URL, writes a temporary OpenCode config with one Antseed model, sets `OPENCODE_CONFIG` for the child process, and forwards extra OpenCode args. It always targets a buyer proxy; for a gateway use the config above.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3'],
      note:
        'Use model ids returned by `GET /v1/models` as the keys under `models`. `antseed opencode --model <model-id>` generates a temporary config for that one id. Route to a specific peer by prefixing its advertised service id: `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'Confirm the endpoint lists the same ids your config references',
        command: LIST_MODELS_COMMAND,
        outputLabel: 'Example response',
        output: `"deepseek/deepseek-v4.1-flash"
"moonshotai/kimi-k3"
"z-ai/glm-5.2"
"z-ai/glm-5.3-flash"`,
        note: 'Add or remove entries under `models` in `opencode.json` so they match this list. Against the local buyer proxy: `curl -s http://localhost:8377/v1/models`.',
      },
      {
        label: 'Launch OpenCode and pick an Antseed model',
        command: 'opencode',
        note:
          'Pick one of the Antseed entries from `/models`. Through the local buyer proxy instead: `antseed opencode --model deepseek-v4.1-flash` (extra OpenCode args are forwarded, so `antseed opencode --model deepseek-v4.1-flash run` works too).',
      },
    ],
    troubleshooting: [
      {
        problem: 'Antseed doesn\'t appear in `/connect` or `/models`',
        fix: 'Make sure `opencode.json` is in your project root (or `~/.config/opencode/opencode.json`) and that the JSON is valid - a stray comma silently disables the whole provider. With `antseed opencode`, pass a catalog model id via `--model`.',
      },
      {
        problem: '`401` from the gateway',
        fix: 'Export `ANTSEED_API_KEY` with your gateway key in the shell that starts OpenCode, and keep `"apiKey": "{env:ANTSEED_API_KEY}"` in `options`.',
      },
      {
        problem: 'Model is listed but every call returns `model_not_found`',
        fix: 'No seller your routing policy allows currently offers that model. Check `GET /v1/models` and update the `models` keys in `opencode.json` to match.',
      },
    ],
    links: [
      { label: 'OpenCode docs → Custom provider', href: 'https://opencode.ai/docs/providers/#custom-provider' },
      { label: 'OpenCode repo', href: 'https://github.com/sst/opencode' },
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
    ],
    agentSummary:
      'Gateway (recommended): in opencode.json add provider.antseed with npm="@ai-sdk/openai-compatible", options.baseURL=<gateway URL ending in /v1>, options.apiKey="{env:ANTSEED_API_KEY}", and one models entry per model id from GET /v1/models; export ANTSEED_API_KEY=<gateway key>; run `opencode`. Same computer as a buyer, no gateway: `antseed opencode --model <model-id>` writes a temporary config for http://localhost:8377/v1.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    glyph: 'π',
    category: 'coding-agent',
    format: 'multi',
    setupMinutes: 3,
    status: 'verified',
    seoTitle: 'Run the Pi coding agent on any model, pay per use',
    headline: 'Run Pi on any model',
    oneLiner: 'Open-source terminal coding agent with a first-class Antseed extension.',
    description: [
      '<strong>What Pi is.</strong> Pi (<code>@earendil-works/pi-coding-agent</code>, formerly <code>@mariozechner/pi-coding-agent</code>) is a minimal, hackable terminal coding agent by Mario Zechner - the same lineage as <a href="https://github.com/badlogic/pi-mono">pi-mono</a>. It ships with four default tools (<code>read</code>, <code>write</code>, <code>edit</code>, <code>bash</code>) and lets you extend everything else - commands, providers, themes, even the editor UI - through TypeScript <em>extensions</em>, <em>skills</em>, and <em>prompt templates</em>. No fork required.',
      '<strong>What the Antseed extension does.</strong> <a href="https://github.com/AntSeed/pi-antseed"><code>pi-antseed</code></a> registers your Antseed endpoint as a Pi provider named <code>antseed</code>. It reads <code>GET /v1/models</code> when Pi loads and adds one model per seller and service, as <code>antseed/&lt;service-id&gt;@&lt;peer-prefix&gt;-&lt;seller-name&gt;</code>, ordered by seller reputation. Pick one with Ctrl+L or <code>/model</code>.',
      '<strong>Which endpoint.</strong> The recommended endpoint is a gateway: set <code>ANTSEED_BASE_URL</code> and <code>ANTSEED_API_KEY</code>, and Pi works from any machine with its own budget and usage log. Without them the extension uses the local buyer proxy on <code>http://localhost:8377</code>, which only works on the same computer as the buyer.',
      '<strong>How requests are sent.</strong> Each request goes out in the protocol the chosen seller advertises (OpenAI Responses, Anthropic Messages or OpenAI Chat Completions), with an <code>x-antseed-pin-peer</code> header for that seller, so Pi handles streaming, retries and tool calls natively.',
    ],
    install: [
      {
        label: 'Install Pi itself (the coding agent CLI)',
        command: 'npm install -g @earendil-works/pi-coding-agent',
        note:
          'The binary is `pi`. Verify with `pi --version`. Pi\'s standalone binary install works the same way. The old `@mariozechner/pi-coding-agent` package is deprecated, but the extension still works with it.',
      },
      {
        label: 'Install the Antseed extension into Pi',
        command: 'pi install git:github.com/AntSeed/pi-antseed',
        note:
          'Pi extensions install from a git URL or a local path. `pi -e git:github.com/AntSeed/pi-antseed` runs the extension once without installing; `pi install ./pi-antseed` works from a local clone.',
      },
    ],
    configure: [
      gatewayEnv('Set both in the shell that launches `pi`; the extension reads them when Pi loads.'),
      {
        title: 'Same computer, no gateway: the local buyer proxy',
        kind: 'gui',
        instructions:
          'Leave `ANTSEED_BASE_URL` and `ANTSEED_API_KEY` unset. The extension then uses `http://localhost:8377`, the local buyer proxy, which checks no key. It only listens on localhost: for Pi on another machine, use a gateway.',
      },
      {
        title: 'Optional: limit the model list',
        kind: 'env',
        vars: {
          ANTSEED_MODELS: 'deepseek-v4.1-flash,glm-5.2',
        },
        note: 'A comma-separated list of service ids, or full route ids such as `deepseek-v4.1-flash@aaaaaaaaaaaa-acme`. Without it, every text model on the network is registered.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3'],
      note:
        'The extension discovers models when Pi loads; run `/reload` in Pi to refresh the list as the network changes. Each entry is one seller: `antseed/<service-id>@<peer-prefix>-<seller-name>`, with the seller\'s reputation in the display name.',
    },
    test: [
      {
        label: 'Launch Pi',
        command: 'pi',
        note:
          'Pi\'s startup header lists loaded extensions. Look for `antseed` (or `pi-antseed`); load errors and discovery warnings (for example a `401` when `ANTSEED_API_KEY` is missing) show there too.',
      },
      {
        label: 'Open the model picker and pick an Antseed model',
        command: '/model',
        note:
          'Or press Ctrl+L. The picker is fuzzy-searchable; type "antseed" to filter. You should see entries like `antseed/deepseek-v4.1-flash@aaaaaaaaaaaa-acme`, one per seller and service.',
      },
    ],
    troubleshooting: [
      {
        problem: '`pi: command not found` after install',
        fix:
          'Your global npm bin is not on `PATH`. Run `npm prefix -g` to find it, then add `<that-path>/bin` to `PATH` in your shell rc. Or use a Node version manager (nvm, fnm, volta) which handles this automatically.',
      },
      {
        problem: 'Pi says "No models available. Use /login…", and Antseed is not in `/login`',
        fix:
          'Expected: the extension adds its models when Pi starts, not through `/login`. Pi shows this when the extension loaded no models: update it with `pi update` (versions before 0.2.0 could not read a gateway), set `ANTSEED_API_KEY` next to `ANTSEED_BASE_URL`, restart Pi, and read the `[pi-antseed]` line it prints at startup.',
      },
      {
        problem: 'No `antseed/...` models in the picker',
        fix:
          'Check the warning in Pi\'s startup header. `401`: set `ANTSEED_API_KEY` to your gateway key. Connection refused: `ANTSEED_BASE_URL` is wrong, or, without it, no buyer proxy runs on this computer. Then run `/reload`. Test the endpoint with `curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY"`.',
      },
      {
        problem: 'Pi runs on another machine than the buyer',
        fix:
          'The local buyer proxy on port 8377 only listens on localhost, so a remote Pi cannot reach it. Point Pi at a gateway: a server gateway, a gateway on your network, or a tunnel (`antseed tunnel start`, or Agents → Internet-accessible endpoint in the desktop app). Set `ANTSEED_BASE_URL` to its URL ending in `/v1` and `ANTSEED_API_KEY` to a gateway key. Never expose port 8377 itself.',
      },
      {
        problem: 'An error from the endpoint mid-conversation',
        fix:
          'Usually the seller behind the chosen model went offline, or your routing policy no longer allows it. Run `/reload` and pick another seller of the same model.',
      },
    ],
    links: [
      { label: 'Pi coding agent (npm)', href: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent' },
      { label: 'Pi source (badlogic/pi-mono)', href: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent' },
      { label: 'pi-antseed extension', href: 'https://github.com/AntSeed/pi-antseed' },
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
      { label: 'Antseed tunnels', href: '/docs/tunnels' },
    ],
    agentSummary:
      'Install Pi: `npm install -g @earendil-works/pi-coding-agent` (or Pi\'s standalone binary). Install the extension: `pi install git:github.com/AntSeed/pi-antseed`. Gateway (recommended, works from any machine): export ANTSEED_BASE_URL=<gateway URL ending in /v1> and ANTSEED_API_KEY=<gateway key> before launching `pi`. Same computer as a buyer, no gateway: leave both unset (defaults to http://localhost:8377). The extension discovers sellers from GET /v1/models; pick `antseed/<service-id>@<peer-prefix>-<seller-name>` with `/model`; `/reload` refreshes the list.',
  },

  /* ---------------- Autonomous agents ---------------- */
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    logo: 'openclaw.svg',
    category: 'agent-platform',
    format: 'openai-chat',
    setupMinutes: 3,
    status: 'verified',
    seoTitle: 'Run OpenClaw agents on any model, pay per use',
    headline: 'Run OpenClaw on any model',
    oneLiner: 'Open-source autonomous agent runtime - register your Antseed gateway as a custom provider in `openclaw.json`.',
    description: [
      '<strong>What OpenClaw is.</strong> OpenClaw is an open-source agent runtime for autonomous, long-running tasks (research, coding, web automation). It loads its provider catalog from <code>~/.openclaw/openclaw.json</code> - each entry is an HTTP endpoint plus a wire protocol (<code>anthropic-messages</code>, <code>openai-chat</code>, etc.) and a list of models.',
      '<strong>How Antseed plugs in.</strong> Add a provider entry called <code>antseed</code> with <code>api: "openai-completions"</code> and <code>authHeader: true</code>. Antseed translates to each seller\'s native protocol, so this one entry reaches every chat model on the network. The recommended endpoint is a gateway: it gives the agent its own key, budget and usage log, and works wherever OpenClaw runs - a server, a container, another computer. Use the local buyer proxy (<code>http://127.0.0.1:8377/v1</code>) only when OpenClaw runs on the same computer as the buyer.',
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
      gatewayEnv(
        'Same computer as the buyer, no gateway: use `http://127.0.0.1:8377/v1` and any placeholder key, such as `antseed-p2p`.',
      ),
      {
        kind: 'code',
        title: 'Gateway only: create a preset that prefers free sellers',
        language: 'bash',
        snippet: `antseed gateway preset create --slug openclaw --name OpenClaw \\
  --model deepseek-v4-flash --prefer-free`,
        note: 'Run it where the gateway runs, or create the preset on the console\'s **Presets** page. OpenClaw then calls it as the model `@preset/openclaw`. With a plain model id, OpenClaw\'s requests can land on a paid seller and get a `402` on an unfunded gateway, even for a model that has a free seller. To never pay, add `--max-input-price 0 --max-output-price 0`: with no free seller available you get a `502` instead of a `402`. Using the local buyer proxy instead? Skip this step: only a gateway resolves presets, and funding the buyer doesn\'t change that. Without funds, run a gateway on the same computer instead (`antseed gateway start`, which serves `http://127.0.0.1:8379/v1`, plus a key from `antseed gateway key create --label openclaw`) and follow the gateway steps.',
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
        "api": "openai-completions",
        "models": [
          {
            "id": "@preset/openclaw",
            "name": "DeepSeek v4 Flash, free sellers first (via Antseed)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "kimi-k2.6",
            "name": "Kimi K2.6 (via Antseed, paid)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 256000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}`,
        note: 'Keep `authHeader: true`: it sends the key as `Authorization: Bearer`, which the gateway requires. Use `openai-completions` with a base URL ending in `/v1`; this is the setup Antseed runs its own OpenClaw agents on. With the local buyer proxy, leave out the `@preset/openclaw` entry: the proxy answers it with an error.',
      },
      {
        kind: 'code',
        title: 'Gateway: use the preset',
        language: 'bash',
        snippet: `openclaw models set "antseed/@preset/openclaw"
openclaw gateway restart`,
        note: 'The restart is only for a running OpenClaw gateway service. One-off `openclaw agent exec` runs read the config directly.',
      },
      {
        kind: 'code',
        title: 'Local buyer proxy: use a model id',
        language: 'bash',
        snippet: `openclaw models set "antseed/kimi-k2.6"
openclaw gateway restart`,
        note: 'Without deposits, use a model that has a free seller: the local buyer retries a free seller after a paid one answers `402`. CLI 0.1.234 and earlier pass that `402` on, and OpenClaw then disables the key for about 10 minutes (see Troubleshooting), so on those versions fund the buyer (`antseed buyer deposit`) or use a gateway. A model with no free seller, such as `kimi-k2.6`, always needs a funded buyer.',
      },
    ],
    modelHints: {
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'minimax-m2.7', 'gpt-oss-120b'],
      note:
        'Every `id` under `models[]` must be a model id from `GET /v1/models` or a gateway preset (`@preset/<slug>`). `kimi-k2.6` has no free seller, so it needs a funded gateway. Don\'t pin a seller with `<peerId>@<service-id>`: OpenClaw drops everything from the `@`, so the gateway gets a bare peer id and answers `502 model_not_found`. Pin with a preset instead: `antseed gateway preset create --slug openclaw-pinned --name "OpenClaw pinned" --model deepseek-v4-flash --allow-peer <peerId>`, then use `@preset/openclaw-pinned`. With the local buyer proxy and the desktop app, the special id `antseed` follows the model picked in the app; it does not work through a gateway.',
    },
    test: [
      {
        label: 'Confirm the endpoint advertises the model ids you put in config',
        command: LIST_MODELS_COMMAND,
        outputLabel: 'Example response',
        output: `"deepseek-v4-flash"
"gpt-oss-120b"
"kimi-k2.6"
"minimax-m2.7"`,
        note:
          'Presets are not listed here. If a model id you listed in `openclaw.json` doesn\'t appear here, no seller your routing policy allows serves it right now. Remove the entry or pick another model from the list.',
      },
      {
        label: 'Check the configured model catalog',
        command: 'openclaw models list',
        note:
          'You should see the `antseed` provider and its configured models.',
      },
      {
        label: 'Run an agent against Antseed',
        command: 'openclaw agent exec "Summarize the README in this repo" --model "antseed/@preset/openclaw"',
        note: 'Through the local buyer proxy: `openclaw agent exec "Summarize the README in this repo" --model "antseed/kimi-k2.6"`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`provider "antseed" not found` when launching an agent',
        fix:
          'JSON parse error in `openclaw.json`, or you put the entry in the wrong nesting level. The provider must live under `models.providers.antseed`. Run `openclaw config validate` to surface parse errors.',
      },
      {
        problem: '`401` from the gateway',
        fix: 'Set `authHeader: true` on the provider and make sure `ANTSEED_API_KEY` holds a gateway key in the environment OpenClaw starts with.',
      },
      {
        problem: 'OpenClaw lists `antseed/<id>` but every call returns `502 model_not_found`',
        fix:
          'No seller your routing policy allows currently advertises that model. Check `GET $ANTSEED_BASE_URL/models` with the bearer key and update `models[]`, or pick another model. If the error names a 40-character peer id instead of a model, the id was `<peerId>@<service-id>`, which OpenClaw cuts at the `@`; pin with a preset instead (see **Pick a model**).',
      },
      {
        problem: '`returned a billing error`, then `Inline API key for provider "antseed" is temporarily disabled after a provider auth/billing failure`',
        fix:
          'The gateway answered `402`: the request was routed to a paid seller and the workspace wallet is empty. OpenClaw then disables the `antseed` key for about 10 minutes for every model, free ones included; `openclaw models status` lists it under **Unavailable auth profiles** with the time left. Wait it out, then use the `@preset/openclaw` preset above, or fund the workspace wallet (console → **Wallet & Funding**).',
      },
      {
        problem: 'Streaming errors on long-running agents',
        fix:
          'Antseed supports SSE streaming. If you see truncated responses, check that no proxy between OpenClaw and Antseed is buffering (Cloudflare, nginx). The gateway and the buyer proxy do not buffer.',
      },
      {
        problem: 'Agent stalls on first request after a deploy',
        fix:
          'Antseed opens a payment channel on the first request to a new peer (one on-chain transaction, ~5–15s on Base). Subsequent requests reuse the channel. Pre-warm by running a quick `curl` before launching the agent.',
      },
      {
        problem: 'OpenClaw runs remotely and cannot reach `127.0.0.1:8377`',
        fix:
          'The local buyer proxy only listens on localhost. Use a gateway: a server gateway, or a tunnel (`antseed tunnel start`, or Agents → Internet-accessible endpoint in the desktop app). Put its `/v1` URL in `ANTSEED_BASE_URL`, a gateway key in `ANTSEED_API_KEY`, and keep `authHeader: true`. Do not expose port 8377 directly.',
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
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
      { label: 'Antseed tunnels', href: '/docs/tunnels' },
    ],
    agentSummary:
      'Gateway (recommended): set ANTSEED_BASE_URL=<gateway URL ending in /v1> and ANTSEED_API_KEY=<gateway key>. Same computer as a buyer, no gateway: http://127.0.0.1:8377/v1 with a placeholder key. In models.providers.antseed use baseUrl/apiKey from those variables, api="openai-completions" and authHeader=true (Bearer, required by the gateway), list model ids from GET /v1/models, run `openclaw models set "antseed/<model-id>"`, then `openclaw gateway restart` (only needed for a running OpenClaw gateway). On an unfunded gateway, create a preset with `antseed gateway preset create --slug openclaw --name OpenClaw --model deepseek-v4-flash --prefer-free` and use model id `@preset/openclaw`. Presets work only through a gateway, never the local buyer proxy (funded or not): there, use a concrete model id. Unfunded, pick one with a free seller (the buyer retries a free seller after a 402; CLI 0.1.234 and earlier do not, so on those fund the buyer or run `antseed gateway start` on the same computer and use the preset); a model with no free seller, such as kimi-k2.6, needs a funded buyer. Note: a 402 makes OpenClaw disable the antseed key for about 10 minutes, free models included. Never use `<peerId>@<model>` in OpenClaw (it strips everything from the @, giving 502 model_not_found); pin with a preset made with `--allow-peer <peerId>`.',
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
    oneLiner: "Nous Research's agent framework - add your Antseed gateway as a provider, or let Hermes set itself up.",
    description: [
      '<strong>What Hermes is.</strong> Hermes Agent is the open-source agent framework from <a href="https://nousresearch.com/">Nous Research</a>. It runs as a long-lived gateway (Telegram, Discord, Slack, …) and reads its model provider from its config.',
      '<strong>Fastest path: let Hermes do it.</strong> Install the <code>hermes-antseed</code> skill and tell your agent "set yourself up to run on Antseed". It snapshots its config, asks for your gateway URL and key (or checks the local buyer and your balance), tests which models actually answer, adds Antseed next to your current provider, switches only after a passing test, and asks you to send <code>/restart</code>.',
      '<strong>Doing it by hand</strong> is the same steps below. Use <code>hermes config set</code> for every change instead of pasting YAML: your <code>config.yaml</code> already has a <code>model:</code> block, and a second one breaks it.',
    ],
    prereqs: [
      'Hermes installed and answering (`hermes -z "hi"` replies).',
      'An Antseed endpoint. Recommended: a gateway, with its base URL (ending in `/v1`) and an API key from its console, and a funded workspace wallet. It works wherever Hermes runs. Alternative, only when Hermes runs on the same computer: the local buyer proxy (the desktop app, or `antseed buyer start`), funded (`antseed buyer balance` shows Available above 0).',
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
      gatewayEnv(
        'Same computer as the buyer, no gateway: use `http://127.0.0.1:8377/v1` and the placeholder key `antseed-p2p`; the local proxy checks no key. The commands below read both variables, so they work either way.',
      ),
      {
        kind: 'code',
        language: 'bash',
        snippet: String.raw`try_model() {
  curl -s -m 90 "$ANTSEED_BASE_URL/chat/completions" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $ANTSEED_API_KEY" \
    -d "{\"model\":\"$1\",\"stream\":false,\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with: ok\"}]}" \
  | grep -q '"choices"' && echo "OK   $1" || echo "FAIL $1"
}
for m in kimi-k3 kimi-k2.6 glm-5.1 deepseek-v4-pro minimax-m2.7 deepseek-v4-flash; do try_model "$m"; done`,
        note:
          'Pick models that actually answer right now. Listed in `/v1/models` is not the same as servable: a model can be listed while no seller your routing policy allows serves it. A `402` / `insufficient_deposits` means the wallet needs funds: the workspace wallet in the gateway console (Wallet & Funding), or `antseed buyer deposit` for a local buyer. The test is non-streaming on purpose, because Hermes\' helper calls (titles, compression) are non-streaming. Use the first OK as your main model and a cheap OK one (`minimax-m2.7`, `deepseek-v4-flash`) as the helper. Each test costs a fraction of a cent.',
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: `hermes config set ANTSEED_API_KEY "$ANTSEED_API_KEY"
hermes config set providers.antseed.name Antseed
hermes config set providers.antseed.base_url "$ANTSEED_BASE_URL"
hermes config set providers.antseed.key_env ANTSEED_API_KEY
hermes config set providers.antseed.api_mode chat_completions
hermes config set providers.antseed.default_model kimi-k3

# Test it before switching (your current provider is still the default):
hermes -z "Reply with exactly: antseed-ok" --provider antseed -m kimi-k3`,
        note:
          'Adds Antseed next to your current provider. `ANTSEED_API_KEY` goes into Hermes\' `.env`. Replace `kimi-k3` with your main model from the test above. It must print `antseed-ok` before you continue.',
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
    ],
    modelHints: {
      suggested: ['kimi-k3', 'glm-5.1', 'deepseek-v4-pro', 'minimax-m2.7', 'deepseek-v4-flash'],
      note:
        'Use a concrete model id that passed the test above. Do not use the id `antseed`: it follows the model picked in the desktop app, so it only works against the local buyer proxy with the app running, never through a gateway.',
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
        command: 'curl -s "$ANTSEED_BASE_URL/key" -H "Authorization: Bearer $ANTSEED_API_KEY"',
        note:
          'On a gateway, `GET /v1/key` shows the key\'s usage and limits, and the console\'s Logs page lists each request with its seller and cost. With the local buyer proxy, run `antseed buyer metering` (per-peer tokens and USDC) and `antseed buyer balance` (Available vs Reserved) instead. The first request to a seller opens a payment channel (~5–15s on Base).',
      },
    ],
    troubleshooting: [
      {
        problem: '`no_default_route`',
        fix: 'The model id `antseed` routes to the model picked in the desktop app, and none is picked. Use a concrete id from the model test.',
      },
      {
        problem: '`model_not_found … No policy-allowed peer currently serves model`',
        fix: 'No seller your routing policy allows serves that model right now. Run the model test again and pick another OK model.',
      },
      {
        problem: '`HTTP 400: Stream must be set to true`',
        fix: 'The model is served only over the streaming Responses protocol, and a non-streaming Hermes call hit it. Use main and helper models that passed the non-streaming test.',
      },
      {
        problem: '`402` / `insufficient_deposits`',
        fix: 'Not enough funds. On a gateway, add funds to the workspace wallet in the console (Wallet & Funding: card or USDC). With a local buyer, `antseed buyer balance` shows Available vs Reserved; add funds with `antseed buyer deposit` (USDC on Base) or by card in the desktop app.',
      },
      {
        problem: '`401` from the gateway',
        fix: 'The key is missing, wrong, revoked or expired. Check `hermes config get ANTSEED_API_KEY` against the Keys page in the console, set it again, then `/restart`.',
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
        fix: 'The local buyer proxy only listens on localhost. Use a gateway: a server gateway, or a tunnel (`antseed tunnel start`, or Agents → Internet-accessible endpoint in the desktop app), with its `/v1` URL and a gateway key. Do not expose port 8377 directly.',
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
      { label: 'Antseed gateway API', href: '/docs/gateway/api' },
      { label: 'Antseed tunnels', href: '/docs/tunnels' },
    ],
    agentSkill: 'hermes skills install AntSeed/antseed/skills/hermes-antseed',
    agentSummary:
      'Install the hermes-antseed skill and follow it. In short: `hermes backup --quick`; get the endpoint: a gateway (recommended: base URL ending in /v1 + gateway key) or, on the same computer, the local buyer at http://127.0.0.1:8377/v1 with placeholder key antseed-p2p (check `antseed buyer balance` shows Available > 0); export ANTSEED_BASE_URL and ANTSEED_API_KEY; test models with a real non-streaming chat completion; add the provider with `hermes config set providers.antseed.{name,base_url,key_env,api_mode,default_model}` plus `hermes config set ANTSEED_API_KEY "$ANTSEED_API_KEY"`; verify with `hermes -z ... --provider antseed -m <model>`; only then set `model.provider antseed` and `model.default <model>`; never paste YAML, never use model id `antseed` through a gateway or on a CLI-only buyer, never restart your own Hermes gateway: ask the user to send /restart.',
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
      '<strong>How Antseed plugs in.</strong> Drop one JSON file per model into <code>backend/node/create_nodes/default_providers/</code> with <code>plugin: "openai-compatible"</code> and <code>api_url</code> set to your Antseed gateway, and the gateway key in <code>ANTSEED_API_KEY</code>. Studio\'s openai-compatible plugin appends <code>/v1/chat/completions</code> automatically, so the gateway receives a standard OpenAI Chat request and selects the highest-ranked eligible offer under your routing policy. Mirror the existing LibertAI entry (PR #1526) - it is the closest analogue: an openai-compatible host with a hosted base URL replaced by your gateway.',
      '<strong>Why a gateway, not the local buyer proxy.</strong> Studio\'s backend runs in Docker via <code>genlayer up</code>. The buyer proxy only accepts requests addressed to <code>localhost</code> or an IP address, so the container cannot use it. A gateway on a server or behind a tunnel works as is. For a gateway on the same computer, use <code>http://host.docker.internal:8379</code>: Mac/Windows Docker exposes the host under that name; on Linux add <code>extra_hosts: ["host.docker.internal:host-gateway"]</code> to the backend service and start the gateway with <code>--host 0.0.0.0</code>, on a network you trust.',
    ],
    prereqs: [
      'GenLayer Studio cloned and running locally with `genlayer up` (see https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio)',
    ],
    install: [
      {
        label: 'Gateway on this computer, Linux only - make `host.docker.internal` resolve from inside the backend container',
        language: 'yaml',
        command: `# docker-compose.yml - patch the backend (jsonrpc) service
services:
  jsonrpc:
    extra_hosts:
      - "host.docker.internal:host-gateway"`,
        note: 'Skip this with a gateway on a server or behind a tunnel, and on Mac and Windows, where Docker Desktop already exposes the host as `host.docker.internal`. On Linux the gateway must also listen beyond loopback: `antseed gateway start --host 0.0.0.0` (plain HTTP, so only on a network you trust). Restart with `genlayer up --reset` after editing.',
      },
    ],
    configure: [
      {
        kind: 'file',
        title: 'Recommended: a gateway',
        path: 'backend/node/create_nodes/default_providers/antseed_kimi-k2.6.json',
        language: 'json',
        snippet: `{
  "provider": "antseed",
  "plugin": "openai-compatible",
  "model": "kimi-k2.6",
  "config": {},
  "plugin_config": {
    "api_key_env_var": "ANTSEED_API_KEY",
    "api_url": "${GATEWAY_ROOT}"
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
    "api_url": "${GATEWAY_ROOT}"
  }
}`,
      },
      {
        kind: 'file',
        path: '.env  (next to docker-compose.yml)',
        language: 'bash',
        snippet: `# An API key from your gateway's console (Keys page).
ANTSEED_API_KEY=${GATEWAY_KEY}`,
        note: `Set \`api_url\` in each provider file to your gateway's address without \`/v1\` (the plugin appends \`/v1/chat/completions\`), or \`http://host.docker.internal:8379\` for a gateway on this computer.`,
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
      suggested: ['kimi-k2.6', 'deepseek-v4-flash', 'gpt-oss-120b', 'glm-5.2'],
      note: 'Each provider JSON file defines exactly one `model`. Studio enumerates these into the validator-creation UI; pick model ids from the network-wide list (`GET /v1/models` on your gateway). To expose more models later, drop in more `antseed_<model>.json` files - no schema edit needed. To lock a file to one specific peer, set `model` to `<peerId>@<service-id>`.',
    },
    test: [
      {
        label: 'Restart Studio so it re-scans `default_providers/`',
        command: 'genlayer up --reset',
        note: '`get_default_providers()` in `backend/node/create_nodes/providers.py` reads every `*.json` in that folder once on boot, validates against `providers_schema.json`, and caches the result. Schema-validation errors abort startup with the offending file path - watch the logs.',
      },
      {
        label: 'In the Studio UI, create a new validator with provider "antseed"',
        note: 'You should see your `antseed_*.json` model ids in the dropdown. Save and trigger a contract that calls `genlayer.eq_principle.prompt(…)` - the request hits `/v1/chat/completions` on your gateway and is routed to the highest-ranked eligible offer under your routing policy.',
      },
      {
        label: 'Confirm the validator call hit Antseed',
        command: 'curl -s https://gateway.example.com/v1/key -H "Authorization: Bearer $ANTSEED_API_KEY"',
        note: 'Shows the key\'s usage so far. The console\'s Logs page lists each validator call with the seller that served it and its cost.',
      },
    ],
    troubleshooting: [
      {
        problem: '`Error validating file … antseed_*.json` on `genlayer up`',
        fix:
          'The schema rejected your provider JSON. Most common cause: missing the if/then rule for `provider:antseed`, so it falls through with the wrong `plugin`. Add the rule to *both* `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Run `genlayer up --reset` after editing.',
      },
      {
        problem: 'Validator hangs, then errors with `Connection refused` to `host.docker.internal:8379`',
        fix:
          'The backend container can\'t reach a gateway on your computer. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` under the backend service in `docker-compose.yml` and start the gateway with `--host 0.0.0.0`. On Mac/Windows, confirm Docker Desktop is running and the gateway is up. Test from inside the container: `docker compose exec jsonrpc curl http://host.docker.internal:8379/v1/models -H "Authorization: Bearer $ANTSEED_API_KEY"`. A server or tunnel gateway avoids all of this.',
      },
      {
        problem: 'Pointing `api_url` at the local buyer proxy (`host.docker.internal:8377`) fails',
        fix:
          'Expected: the buyer proxy only accepts requests addressed to `localhost` or an IP address, and never from other machines. Use a gateway instead.',
      },
      {
        problem: '`401` from the gateway',
        fix:
          '`ANTSEED_API_KEY` in `.env` must hold a gateway key from the console. Restart with `genlayer up --reset` after changing it.',
      },
      {
        problem: '`502 model_not_found` from a validator using e.g. `kimi-k2.6`',
        fix:
          'No seller your routing policy allows currently advertises that model. Check `GET /v1/models` on your gateway. Either pick a model from that list or remove that `antseed_<model>.json` file.',
      },
      {
        problem: 'First call after a restart takes 5–15 seconds',
        fix:
          'Antseed opens a payment channel on the first request to a new peer (one Base-mainnet transaction). Subsequent calls reuse the channel. Pre-warm with one small chat completion to the gateway before triggering Studio.',
      },
    ],
    caveats: [
      'There is no hosted Antseed account: each operator runs their own gateway (or shares a team gateway) and funds its workspace wallet.',
      'Free services exist on the Antseed network (`in: 0, out: 0`), but paid ones need funds in the gateway\'s workspace wallet: by card or USDC on Base, from the console\'s Wallet & Funding page.',
    ],
    links: [
      { label: 'GenLayer Studio repo', href: 'https://github.com/genlayerlabs/genlayer-studio' },
      { label: 'Studio docs', href: 'https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio' },
      { label: 'Reference PR (LibertAI)', href: 'https://github.com/genlayerlabs/genlayer-studio/pull/1526' },
      { label: 'providers_schema.json (source of truth)', href: 'https://github.com/genlayerlabs/genlayer-studio/blob/main/backend/node/create_nodes/providers_schema.json' },
    ],
    agentSummary:
      'In GenLayer Studio: drop one JSON file per model into `backend/node/create_nodes/default_providers/` with `provider: "antseed"`, `plugin: "openai-compatible"`, `model: "<model-id>"`, and `plugin_config.api_url` set to the Antseed gateway root (NO `/v1` suffix - the plugin appends it; `http://host.docker.internal:8379` for a gateway on the same computer). Set `ANTSEED_API_KEY=<gateway key>` in `.env`. Add `"antseed"` to the provider enum and an if/then rule to BOTH `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Restart with `genlayer up --reset`. Do not use the local buyer proxy: it rejects requests addressed to host.docker.internal. Set `model` to `<peerId>@<service-id>` only to force a specific seller.',
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
    oneLiner: "Use `@ai-sdk/openai-compatible` to call Antseed from `generateText` / `streamText`.",
    description: [
      '<strong>What the AI SDK is.</strong> Vercel\'s <code>ai</code> package is a provider-agnostic TypeScript toolkit for building LLM apps and agents. You pick a <em>provider</em> (a small adapter package), instantiate a model from it, and pass that model into one of the framework\'s primitives: <code>generateText</code> or <code>streamText</code>, with an <code>output</code> setting for structured data. The AI SDK handles tool-calling, structured output, message history, and streaming for you.',
      '<strong>How Antseed plugs in.</strong> Your Antseed gateway is OpenAI-Chat-compatible at its <code>/v1</code> URL, so the right adapter is <code>@ai-sdk/openai-compatible</code> (not <code>@ai-sdk/openai</code>). The official OpenAI provider is locked to OpenAI\'s API surface and quietly drops third-party fields; the openai-compatible provider is the one Vercel\'s own docs recommend for proxies, gateways, and any non-OpenAI server that speaks Chat Completions. You pass the gateway URL as <code>baseURL</code> and a gateway key as <code>apiKey</code>, which the SDK sends as <code>Authorization: Bearer</code>. On the same computer as a buyer you can use the local buyer proxy instead (<code>http://localhost:8377/v1</code>, any non-empty key).',
      '<strong>Which model ids work.</strong> The first argument to the provider call is a model id from the Antseed catalog (e.g. <code>deepseek-v4-flash</code>, <code>kimi-k2.6</code>). Any model on the network works - list them with <code>GET /v1/models</code>. To route to a specific peer per call, prefix that peer offer\'s service id: <code>&lt;peerId&gt;@deepseek-v4-flash</code>.',
    ],
    prereqs: ['Node.js 22 or newer (`ai` 7 requires it)'],
    install: [
      {
        label: 'Create an ES module project and install the SDK and the openai-compatible provider',
        command: 'npm init -y\nnpm pkg set type=module\nnpm install ai @ai-sdk/openai-compatible zod',
        note: 'The examples below use top-level `await`, which only works in an ES module, so the package needs `"type": "module"`. Without it, `npx tsx` fails with "Top-level await is currently not supported with the "cjs" output format". `zod` is only needed for structured output (`structured.ts`).',
      },
    ],
    configure: [
      gatewayEnv(),
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// antseed.ts - a single provider instance you can import everywhere
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const antseed = createOpenAICompatible({
  name: 'antseed',
  baseURL: process.env.ANTSEED_BASE_URL!, // gateway URL ending in /v1
  apiKey: process.env.ANTSEED_API_KEY!,   // gateway key, sent as Authorization: Bearer
  includeUsage: true, // surface token counts in streaming responses too
  supportsStructuredOutputs: true, // send the zod schema as a JSON schema (structured.ts)
});`,
        note: 'Same computer as a buyer, no gateway: `baseURL: \'http://localhost:8377/v1\'` and any non-empty `apiKey`, such as `\'antseed\'`; the local proxy checks no key.',
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

const { inputTokens, outputTokens } = await result.usage;
console.log(\`\\ntokens: \${inputTokens} in, \${outputTokens} out\`);`,
      },
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// structured.ts - a typed object instead of text
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { antseed } from './antseed';

const { output } = await generateText({
  model: antseed('deepseek-v4-flash'),
  output: Output.object({
    schema: z.object({
      title: z.string(),
      bullets: z.array(z.string()).min(3).max(5),
    }),
  }),
  prompt: 'Make one slide that explains why the sky is blue.',
});
console.log(output);`,
        note: '`generateObject` and `streamObject` still work but are deprecated in `ai` 7; `Output.object` replaces them. The schema is only enforced because `antseed.ts` sets `supportsStructuredOutputs: true`.',
      },
    ],
    modelHints: {
      suggested: ['deepseek-v4-flash', 'kimi-k2.6', 'gpt-oss-120b', 'glm-5.2'],
      note:
        `The string you pass to \`antseed('<id>')\` is forwarded verbatim as \`model\` in the OpenAI Chat request. Run \`${LIST_MODELS_COMMAND}\` to list every model on the network. \`antseed('<peerId>@<id>')\` routes that one call to a specific peer.`,
    },
    test: [
      {
        label: 'Run a smoke test with `tsx`',
        command: 'npx tsx stream.ts',
        outputLabel: 'Example output',
        output: `The sky appears blue due to a phenomenon called **Rayleigh scattering**…

tokens: 1698 in, 215 out`,
        note:
          'If you see `502 model_not_found`, no seller your routing policy allows currently advertises the id you passed - check `GET /v1/models`. A `401` means `ANTSEED_API_KEY` is missing or not a valid gateway key.',
      },
      {
        label: 'Check structured output',
        command: 'npx tsx structured.ts',
        outputLabel: 'Example output',
        output: `{
  title: 'Why the Sky Is Blue',
  bullets: [
    'Sunlight appears white but contains all colors of the rainbow.',
    …
  ]
}`,
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
          'Useful when one Node process serves many tenants and you want each request routed to a different peer. Gateway routing policies still apply to a pinned request.',
      },
    ],
    troubleshooting: [
      {
        problem: 'TypeScript complains that `antseed` has no call signature',
        fix:
          'You imported from `@ai-sdk/openai` instead of `@ai-sdk/openai-compatible`. Switch the package - the SDK\'s official OpenAI provider is locked to OpenAI\'s service ids and rejects unknown ones.',
      },
      {
        problem: '`NoObjectGeneratedError: No object generated: response did not match schema`',
        fix:
          'Without `supportsStructuredOutputs: true` on `createOpenAICompatible`, the provider asks only for JSON (`response_format: json_object`) and never sends your schema, so the model invents its own fields. Set it, as in `antseed.ts` above, to send the schema as `json_schema`. If it still fails, the seller that served the call ignores JSON schemas: pick a model whose offers in `GET /v1/models` list `structuredOutput: true` under `capabilities`, or pin such a seller with `<peerId>@<id>`.',
      },
      {
        problem: '`includeUsage` is set but `result.usage` is undefined',
        fix:
          'Some upstream providers behind Antseed do not emit usage on streamed responses. Try `generateText` instead of `streamText` for definitive token counts; the gateway console\'s Logs page (or `antseed buyer metering` with a local buyer) shows the tokens and cost Antseed measured.',
      },
      {
        problem: 'Browser/edge runtime fails with `fetch` errors',
        fix:
          'Call Antseed from server code (Route Handlers, Server Actions, a Node process), never from a client component: the gateway key is a bearer secret and must not ship to the browser. Deployed functions need a gateway they can reach (a server or tunnel URL); the local buyer proxy only listens on `127.0.0.1`.',
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
      "createOpenAICompatible({ name: 'antseed', baseURL: process.env.ANTSEED_BASE_URL, apiKey: process.env.ANTSEED_API_KEY }) with a gateway URL ending in /v1 and a gateway key (recommended); on the same computer as a buyer, baseURL 'http://localhost:8377/v1' with apiKey 'antseed'. Then antseed('<model-id>') as the model. Use @ai-sdk/openai-compatible (NOT @ai-sdk/openai). The examples use top-level await: set \"type\": \"module\" in package.json (npm pkg set type=module) or tsx fails. For structured output use generateText with output: Output.object({ schema }) and set supportsStructuredOutputs: true on the provider, or the schema is never sent. Model ids come from GET /v1/models. Per-request peer override: headers: { 'x-antseed-pin-peer': '<peerId>' }, or model '<peerId>@<model-id>'. Server-side only: never expose the gateway key to a browser.",
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
      '<strong>How Antseed plugs in.</strong> Pass your gateway URL as <code>base_url</code> and a gateway key as <code>api_key</code> to <code>ChatOpenAI</code> (on the same computer as a buyer, <code>http://localhost:8377/v1</code> and any non-empty key work too). Once you have an instance, every primitive that accepts a chat model - LCEL pipes (<code>prompt | llm | parser</code>), tool-calling agents, <code>create_react_agent</code>, LangGraph nodes, RAG chains, structured-output binding via <code>with_structured_output</code> - will route through Antseed without any further changes.',
      '<strong>One thing to know.</strong> LangChain\'s <code>ChatOpenAI</code> is OpenAI-strict by design: it will not preserve non-standard response fields like <code>reasoning_content</code>, <code>reasoning</code>, or <code>reasoning_details</code> that some third-party servers emit. For chat, tool-calling, and structured output this is fine. If you specifically need a model\'s reasoning traces, consider using the OpenAI Responses endpoint (<code>/v1/responses</code>) via a different provider package, or use a model that returns reasoning inline.',
    ],
    prereqs: ['Python 3.10 or newer'],
    install: [
      {
        label: 'Install LangChain and the OpenAI integration',
        command: 'pip install -U langchain langchain-openai',
      },
    ],
    configure: [
      gatewayEnv(),
      {
        kind: 'code',
        language: 'python',
        snippet: `# antseed_llm.py - import this once, reuse everywhere.
import os
from langchain_openai import ChatOpenAI

antseed = ChatOpenAI(
    model="deepseek-v4-flash",          # an Antseed catalog model id
    # model="<peerId>@deepseek-v4-flash",  # …or pin a specific peer
    base_url=os.environ["ANTSEED_BASE_URL"],  # gateway URL ending in /v1
    api_key=os.environ["ANTSEED_API_KEY"],    # gateway key
    temperature=0.7,
    # max_completion_tokens=2048,        # uncomment for hard caps
)

print(antseed.invoke("Hello").content)`,
        note: 'Same computer as a buyer, no gateway: `base_url="http://localhost:8377/v1"` and any non-empty `api_key`, such as `"antseed"`; the local proxy checks no key.',
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
      suggested: ['deepseek-v4-flash', 'kimi-k2.6', 'gpt-oss-120b', 'glm-5.2'],
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
        command: `# extra_headers is forwarded as-is to Antseed.
import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-v4-flash",
    base_url=os.environ["ANTSEED_BASE_URL"],
    api_key=os.environ["ANTSEED_API_KEY"],
    extra_headers={
        "x-antseed-pin-peer": "cccccccccccccccccccccccccccccccccccccccc",
    },
)
print(llm.invoke("hi").content)`,
        note: 'Use this when a single Python process needs to fan out to different peers per call (multi-tenant, scheduled jobs, A/B tests across peers).',
      },
      {
        label: 'Verify it actually went through Antseed',
        command: 'curl -s "$ANTSEED_BASE_URL/key" -H "Authorization: Bearer $ANTSEED_API_KEY"',
        note: 'Shows the gateway key\'s usage so far; the console\'s Logs page lists each call with its seller and cost. With a local buyer, `antseed buyer metering` prints per-channel token + USDC totals instead.',
      },
    ],
    troubleshooting: [
      {
        problem: '`openai.NotFoundError: 404 … model_not_found`',
        fix:
          'No seller your routing policy allows currently advertises the id you passed. Confirm with `GET /v1/models` and change the `model=` argument.',
      },
      {
        problem: '`openai.AuthenticationError: 401`',
        fix:
          '`ANTSEED_API_KEY` is missing or not a valid gateway key. Check it against the Keys page in the console.',
      },
      {
        problem: '`openai.APIConnectionError: Connection refused`',
        fix:
          'Nothing answers at `ANTSEED_BASE_URL`. Check the gateway is running and the URL ends in `/v1`. With the local buyer proxy, start it with `antseed buyer start` (or open the desktop app) and confirm `curl http://localhost:8377/v1/models` works.',
      },
      {
        problem: '`with_structured_output` returns the right schema but empty fields',
        fix:
          'Either the routed model does not support OpenAI tool-call syntax, or you used `method="json_mode"` against a service that does not honor it. Try `method="function_calling"` (the default), and prefer services tagged `coding` or `tools` in `antseed network peer <peerId> --json`.',
      },
      {
        problem: 'Streaming with `stream=True` truncates mid-response',
        fix:
          'A buffering proxy (nginx, Cloudflare) sits between your code and Antseed. The gateway and the buyer proxy do not buffer SSE. Either bypass the intermediate proxy or set its buffering off (`proxy_buffering off;` in nginx).',
      },
      {
        problem: 'Reasoning traces missing on a model you know emits them',
        fix:
          'See the third paragraph above: `langchain-openai` does not preserve non-standard response fields. For first-class reasoning support, route the request through the OpenAI Responses endpoint (`POST /v1/responses`) using a Responses-aware client, or pick a model that puts reasoning inline in `content`.',
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
      "ChatOpenAI(model='<model-id>', base_url=os.environ['ANTSEED_BASE_URL'], api_key=os.environ['ANTSEED_API_KEY']) from langchain-openai, with a gateway URL ending in /v1 and a gateway key (recommended); on the same computer as a buyer, base_url='http://localhost:8377/v1' and api_key='antseed'. Drops into LCEL, create_react_agent, RAG, with_structured_output. Per-request peer override: extra_headers={'x-antseed-pin-peer': '<peerId>'}. Model ids come from GET /v1/models. Reasoning traces (reasoning_content, etc.) are NOT preserved by ChatOpenAI - use the Responses endpoint for those.",
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
    oneLiner: 'Call your gateway with plain HTTP - useful for scripts and debugging.',
    description: [
      'Your gateway and the local buyer proxy are plain HTTP servers. Anything that can issue an HTTP POST works. The model endpoints are:',
      '• `POST /v1/messages` - Anthropic Messages format\n• `POST /v1/chat/completions` - OpenAI Chat Completions\n• `POST /v1/responses` - OpenAI Responses API',
      'A gateway needs its key as `Authorization: Bearer`. The local buyer proxy needs no key, but only answers on the same computer.',
    ],
    install: [],
    configure: [
      gatewayEnv(),
      {
        kind: 'code',
        language: 'bash',
        snippet: `# Anthropic format
curl "$ANTSEED_BASE_URL/messages" \\
  -H "Authorization: Bearer $ANTSEED_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI Chat format
curl "$ANTSEED_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $ANTSEED_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Route to a specific peer: prefix the model with "<peerId>@"
curl "$ANTSEED_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $ANTSEED_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "<peerId>@deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
      {
        title: 'Same computer, no gateway: the local buyer proxy',
        kind: 'code',
        language: 'bash',
        snippet: `curl ${LOCAL_PROXY_URL}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Follow the model currently selected in the desktop app:
curl ${LOCAL_PROXY_URL}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "antseed",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
        note: 'No key needed. The model `antseed` follows the desktop app\'s picker and only works here, not through a gateway.',
      },
    ],
    agentSummary:
      'Gateway (recommended): POST JSON to $ANTSEED_BASE_URL/messages, /chat/completions, or /responses (base URL ends in /v1) with `Authorization: Bearer <gateway key>`. Same computer as a buyer, no gateway: the same paths on http://localhost:8377/v1 with no Authorization header; there the model `antseed` follows the desktop app picker. Model field: "<model-id>" for automatic routing, or "<peerId>@<service-id>" to route to a specific peer.',
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
    "Drop-in for Claude Code, Codex, and friends. Point them at your gateway, keep your existing workflow.",
  'agent-platform':
    "Long-running, autonomous workloads. Agents pick providers by price, latency, and reputation - no provider API keys, no SaaS account.",
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
