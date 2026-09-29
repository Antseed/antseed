/**
 * Docusaurus plugin that:
 *   1. Registers a route at /integrations/<slug> for every integration in
 *      src/integrations/integrations.ts.
 *   2. Generates /llms-connect.txt at build time so LLM crawlers can ingest
 *      the integration catalog without scraping HTML.
 *   3. Copies skills/join-buyer/SKILL.md to /skill.md, the one file an agent
 *      reads to install, start, fund and use Antseed.
 *
 * Adding a new entry to integrations.ts is enough — the route appears on
 * the next build.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type {LoadContext, Plugin} from '@docusaurus/types';
import {
  integrations,
  CATEGORY_LABELS,
  FORMAT_LABELS,
  FORMAT_ENDPOINT,
  FORMAT_TO_PROTOCOL,
  type Integration,
  type IntegrationFormat,
  type ConfigBlock,
  type Step,
} from '../src/integrations/integrations';

/**
 * Strip a small set of inline HTML tags we use in `description` strings so the
 * llms-connect.txt output is clean markdown. We control the source so this is safe.
 */
function htmlToMarkdown(input: string): string {
  return input
    .replace(/<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<\/?(strong|b)>/gi, '**')
    .replace(/<\/?(em|i)>/gi, '*')
    .replace(/<\/?code>/gi, '`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '')
    // Decode HTML entities that authors used to escape angle brackets etc.
    // inside `description` strings (which are rendered via dangerouslySetInnerHTML
    // on the website but show up literal in markdown otherwise).
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function renderConfigBlock(b: ConfigBlock): string {
  let body: string;
  if (b.kind === 'env') {
    const lines = Object.entries(b.vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
    body = ['```bash', ...lines, '```'].join('\n');
  } else if (b.kind === 'file') {
    body = ['```' + b.language + ' title="' + b.path + '"', b.snippet, '```'].join('\n');
  } else if (b.kind === 'code') {
    body = ['```' + b.language, b.snippet, '```'].join('\n');
  } else {
    body = ['> **GUI:**', '>', '> ' + b.instructions.replace(/\n/g, '\n> ')].join('\n');
  }
  if (b.note) {
    body += '\n\n_' + htmlToMarkdown(b.note) + '_';
  }
  return body;
}

function renderStep(s: Step): string {
  const parts: string[] = [`- **${s.label}**`];
  if (s.command) {
    parts.push('  ```' + (s.language ?? 'bash'));
    s.command.split('\n').forEach((line) => parts.push('  ' + line));
    parts.push('  ```');
  }
  if (s.output) {
    const label = s.outputLabel ?? 'Example output';
    parts.push(`  *${label}:*`);
    parts.push('  ```');
    s.output.split('\n').forEach((line) => parts.push('  ' + line));
    parts.push('  ```');
  }
  if (s.note) parts.push(`  > ${s.note}`);
  return parts.join('\n');
}

function renderWireFormatBlock(i: Integration): string {
  const lines: string[] = [];
  lines.push(`**How ${i.name} talks to Antseed**`);
  lines.push('');
  if (i.format === 'multi') {
    lines.push(
      `${i.name} can send any of Antseed's supported wire formats. Match the request ` +
        "format against each service's `protocols` array (advertised per service in " +
        '`providerServiceApiProtocols`) — when it matches, ' +
        'the request passes through untouched; when it does not, `@antseed/api-adapter` ' +
        'translates on the fly.',
    );
    lines.push('');
    lines.push('| Endpoint | Wire format | Native fit (services advertising) |');
    lines.push('|----------|-------------|------------------------------------|');
    for (const f of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
      lines.push(
        `| \`${FORMAT_ENDPOINT[f]}\` | ${FORMAT_LABELS[f]} | \`${FORMAT_TO_PROTOCOL[f]}\` |`,
      );
    }
    return lines.join('\n');
  }

  const fmt = i.format as Exclude<IntegrationFormat, 'multi'>;
  const protocol = FORMAT_TO_PROTOCOL[fmt];
  const endpoint = FORMAT_ENDPOINT[fmt];

  lines.push(
    `- **Wire format sent by ${i.name}:** ${FORMAT_LABELS[fmt]} (hits \`${endpoint}\` on the buyer proxy).`,
  );
  lines.push(
    `- **Best-fit services:** any service whose \`protocols\` array contains \`${protocol}\` — ` +
      'that is what the peer advertises as natively-supported, so traffic passes through with ' +
      'zero translation overhead.',
  );
  lines.push(
    '- **How to check a peer:** run `antseed network peer <peerId> --json` and look at ' +
      '`peer.providerServiceApiProtocols[provider].services[service]` for each model. ' +
      'The browse command exposes the same field per peer.',
  );
  lines.push(
    `- **When protocols differ:** Antseed's \`@antseed/api-adapter\` translates between ${FORMAT_LABELS[fmt]} ` +
      "and the service's native protocol on the fly. So a request from " +
      `${i.name} can still reach a service that only advertises a different protocol — just ` +
      'with a small transform step.',
  );
  if (fmt !== 'openai-responses') {
    lines.push(
      '- **Caveat:** services whose only advertised protocol is `openai-responses` require ' +
        `streaming. If ${i.name} sends a non-streaming request and the proxy routes it to one ` +
        'of those services, the call fails with `HTTP 400: Stream must be set to true`. Pick a ' +
        `service whose \`protocols\` includes \`${protocol}\` (or another non-responses protocol) ` +
        'to avoid this.',
    );
  }
  return lines.join('\n');
}

function renderIntegrationMarkdown(i: Integration): string {
  const lines: string[] = [];
  lines.push(`## ${i.name}`);
  lines.push('');
  lines.push(`*${i.oneLiner}*`);
  lines.push('');
  lines.push(`- **Category:** ${CATEGORY_LABELS[i.category]}`);
  lines.push(`- **Wire format:** ${FORMAT_LABELS[i.format]}`);
  lines.push(`- **Setup time:** ~${i.setupMinutes} min`);
  lines.push(`- **Page:** https://antseed.com/integrations/${i.slug}`);
  if (i.agentSummary) {
    lines.push('');
    lines.push(`**TL;DR for agents:** ${i.agentSummary}`);
  }
  lines.push('');
  for (const p of i.description) {
    lines.push(htmlToMarkdown(p));
    lines.push('');
  }
  if (i.prereqs?.length) {
    lines.push('**Prerequisites**');
    lines.push('');
    for (const p of i.prereqs) lines.push(`- ${p}`);
    lines.push('');
  }
  if (i.install.length) {
    lines.push('**Install**');
    lines.push('');
    for (const s of i.install) lines.push(renderStep(s));
    lines.push('');
  }
  lines.push('**Configure**');
  lines.push('');
  for (const b of i.configure) {
    lines.push(renderConfigBlock(b));
    lines.push('');
  }
  if (i.modelHints) {
    lines.push('**Suggested models:** ' + i.modelHints.suggested.map((m) => '`' + m + '`').join(', '));
    if (i.modelHints.note) {
      lines.push('');
      lines.push(i.modelHints.note);
    }
    lines.push('');
  }
  if (i.test?.length) {
    lines.push('**Test it**');
    lines.push('');
    for (const s of i.test) lines.push(renderStep(s));
    lines.push('');
  }
  if (i.troubleshooting?.length) {
    lines.push('**Troubleshooting**');
    lines.push('');
    for (const t of i.troubleshooting) {
      lines.push(`- *${t.problem}* — ${t.fix}`);
    }
    lines.push('');
  }
  if (i.caveats?.length) {
    lines.push('**Caveats**');
    lines.push('');
    for (const c of i.caveats) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push(renderWireFormatBlock(i));
  lines.push('');
  if (i.links?.length) {
    lines.push('**Links**');
    lines.push('');
    for (const l of i.links) lines.push(`- [${l.label}](${l.href})`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSkillMarkdown(): string {
  const out: string[] = [];
  out.push('---');
  out.push('name: antseed-connect');
  out.push('description: Connect coding agents, AI SDKs, and LLM tools to the Antseed buyer proxy locally or through an authenticated public endpoint. Use when configuring Claude Code, Codex, OpenCode, Pi, OpenClaw, Hermes, GenLayer Studio, Vercel AI SDK, LangChain, or raw HTTP.');
  out.push('---');
  out.push('');
  out.push('# Antseed — Integration Skill');
  out.push('');
  out.push('> This file is the agent-readable companion to https://antseed.com/integrations.');
  out.push('> It tells any AI agent (Claude, Codex, OpenClaw, Hermes, custom) exactly');
  out.push('> how to wire its tool of choice up to the Antseed peer-to-peer inference network.');
  out.push('');

  out.push('## What is Antseed?');
  out.push('');
  out.push('Antseed is a peer-to-peer marketplace for AI inference. Buyers run a small');
  out.push('local daemon (the **buyer proxy**) that exposes an HTTP API at');
  out.push('`http://localhost:8377` speaking the three caller-facing LLM API protocols:');
  out.push('Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. Legacy');
  out.push('OpenAI Completions is supported internally for adapter translation. The proxy');
  out.push('discovers providers on a DHT, routes the');
  out.push('request to a peer, translates between protocols when needed (via');
  out.push('`@antseed/api-adapter`), and settles in USDC on Base.');
  out.push('');
  out.push('Important: Antseed is for value-added AI services (specialized models, agents,');
  out.push('TEEs, fine-tunes, managed workflows), not raw resale of API keys or subscription');
  out.push('access. Providers must comply with upstream terms of service.');
  out.push('');
  out.push('From the perspective of any tool, SDK, or agent, **Antseed is just a local');
  out.push('OpenAI/Anthropic-compatible endpoint** — point a `base_url` at it and you are done.');
  out.push('');

  out.push('## Glossary (mental model)');
  out.push('');
  out.push('- **Buyer proxy** — the local server on `localhost:8377` that accepts API calls');
  out.push('  from your tools and forwards them to Antseed peers. It is the only thing your');
  out.push('  editor / agent / SDK ever talks to.');
  out.push('- **Peer** — someone selling inference. Each peer has a `peerId` (40-char hex),');
  out.push('  a display name, and a list of services. List with `antseed network browse`.');
  out.push('- **Service** — a single model id like `kimi-k2.6` or `deepseek-v4-flash`.');
  out.push("  *This is what you pass as `model` in your tool's config.* Each service has its");
  out.push('  own native protocol list and its own `in` / `cachedIn` / `out` pricing.');
  out.push('- **Protocols** (per service) — the wire formats a service accepts *natively*,');
  out.push('  advertised on each peer in `providerServiceApiProtocols[provider].services[service]`.');
  out.push('  Values are `anthropic-messages`,');
  out.push('  `openai-chat-completions`, `openai-responses`, `openai-completions`. **This is');
  out.push("  the field to match your tool's wire format against.** If your tool's wire format");
  out.push('  is in this list, the request passes through untouched; if not, the api-adapter');
  out.push('  translates on the fly.');
  out.push('- **Cached input pricing** — services charge a separate, much lower rate');
  out.push('  (typically 4–10×) for tokens that are reused across requests: system prompts,');
  out.push('  tool schemas, prior conversation turns, long files you keep referencing. The CLI');
  out.push('  exposes it as `cachedInputUsdPerMillion`. For long-running agents and chatbots,');
  out.push('  this is often the dominant cost line.');
  out.push('- **Pin** — optionally telling the buyer proxy "route requests to *this* peer."');
  out.push('  Pinning is not required: a request that names only a model auto-selects the');
  out.push('  highest-ranked eligible offer under the shared Price + Trust preferences, and');
  out.push('  fails over to the next ranked peer on peer-attributed retryable failures');
  out.push('  (rate-limited peers get up to 3 same-peer retries before fallback). Pin when');
  out.push('  you want to force one specific seller:');
  out.push('  - **Session pin**: `antseed buyer connection set --peer <peerId>`. Persists in');
  out.push('    `~/.antseed/buyer.state.json` and applies to every request until you change it.');
  out.push('  - **Per-request header**: `x-antseed-pin-peer: <peerId>` on each call. Overrides');
  out.push('    the session pin for that request.');
  out.push('  - **Model prefix**: set `model` to `<peerId>@<service>`. The proxy uses the');
  out.push('    prefix as the peer pin and forwards only `<service>` to the seller.');
  out.push('  ');
  out.push('  Precedence when several are present: header > model prefix > session pin.');
  out.push('  Explicitly pinned requests never fail over to a different peer. A request');
  out.push('  with neither a model nor a pin returns `400 missing_routing_target`.');
  out.push('  For recognized conversations, a successful automatic route becomes a soft');
  out.push('  affinity: later turns prefer the same seller and service while they remain');
  out.push('  healthy and policy-eligible, but automatic routing can still fail over.');
  out.push('');

  out.push('## Universal setup (do this once)');
  out.push('');
  out.push('### Option A — AI VPN desktop app (recommended)');
  out.push('');
  out.push('Download from https://antseed.com — it ships the buyer proxy, a wallet, and a');
  out.push('peer browser in a GUI. While the app is open the proxy is reachable at');
  out.push('`http://localhost:8377`. Its **Apps** view detects installed tools (Claude');
  out.push('Code, Codex, …) and launches them already wired to Antseed. The app saves');
  out.push('its Price + Trust preferences into the buyer config, so internal chat,');
  out.push('connected apps, and direct API calls all use the same routing policy.');
  out.push('');
  out.push('### Option B — CLI (headless / servers / agents)');
  out.push('');
  out.push('```bash');
  out.push('# 1. Install');
  out.push('npm install -g @antseed/cli');
  out.push('');
  out.push('# 2. Identity (an EVM private key — 64 hex chars). Save this somewhere safe;');
  out.push('#    you will reuse it across machines and it controls your USDC deposits.');
  out.push('export ANTSEED_IDENTITY_HEX=$(openssl rand -hex 32)');
  out.push('# SECURITY: never paste this key into chat, logs, GitHub issues, or a file');
  out.push('# committed to git. It controls the buyer identity and access to deposits.');
  out.push('');
  out.push('# 3. Start the buyer proxy on :8377');
  out.push('antseed buyer start &');
  out.push('');
  out.push('# 4. List every model on the network (answered locally, aggregated across');
  out.push('#    all sellers — no pin needed). Close aliases such as claude-opus-5 /');
  out.push('#    opus-5 / opus5 merge into one entry with an `aliases` array; each entry');
  out.push('#    has a `peers` array with every seller serving it. Filter with');
  out.push('#    ?type=text or ?type=images; single lookup: GET /v1/models/<id>.');
  out.push("curl -s http://localhost:8377/v1/models | jq '.data[].id'");
  out.push('');
  out.push('# 5. Make a request — the model name selects the highest-ranked eligible');
  out.push('#    offer under the shared Price + Trust preferences. No pin needed.');
  out.push('curl http://localhost:8377/v1/chat/completions \\');
  out.push("  -H 'content-type: application/json' \\");
  out.push('  -d \'{ "model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "Hello"}] }\'');
  out.push('');
  out.push('# 6. (Optional) Browse the network and list every service (= model) each peer');
  out.push('#    offers, along with its native protocols and USD-per-1M-tokens pricing.');
  out.push('#    `service` is the model id you pass to your tool. `protocols` is the');
  out.push('#    wire format(s) the service accepts natively — match it against your');
  out.push('#    tool. `in` / `cachedIn` / `out` are fresh-input / cached-input / output.');
  out.push('antseed network browse --json --top 5 \\');
  out.push("  | jq '.peers | map({");
  out.push("      peerId, name: .displayName,");
  out.push("      services: [");
  out.push("        (.providerServiceApiProtocols | to_entries[]) as $p");
  out.push("        | ($p.value.services | to_entries[]) as $s");
  out.push("        | {");
  out.push("            service:  $s.key,");
  out.push("            protocols: $s.value,");
  out.push("            in:       (.providerPricing[$p.key].services[$s.key].inputUsdPerMillion       // .providerPricing[$p.key].defaults.inputUsdPerMillion),");
  out.push("            cachedIn: (.providerPricing[$p.key].services[$s.key].cachedInputUsdPerMillion // null),");
  out.push("            out:      (.providerPricing[$p.key].services[$s.key].outputUsdPerMillion      // .providerPricing[$p.key].defaults.outputUsdPerMillion)");
  out.push("          }");
  out.push("      ]");
  out.push("    })'");
  out.push('');
  out.push('# 7. (Optional) Inspect one peer in detail. Use `matchingServices[]` for pricing/tags and');
  out.push('#    `peer.providerServiceApiProtocols` for native protocol support.');
  out.push('#    `cachedIn` is typically 4–10× cheaper than `in` and often dominates the');
  out.push('#    cost line for long-running agents and chatbots — always include it when');
  out.push('#    comparing peers.');
  out.push('antseed network peer <peerId> --json \\');
  out.push("  | jq '{");
  out.push("      peer: (.peer | { peerId, name: .displayName,");
  out.push("                       sessions: .onChainChannelCount,");
  out.push("                       ghosts:   .onChainGhostCount }),");
  out.push("      services: [");
  out.push("        (.peer.providerServiceApiProtocols | to_entries[]) as $p");
  out.push("        | ($p.value.services | to_entries[]) as $s");
  out.push("        | (.matchingServices[] | select(.provider == $p.key and .service == $s.key)) as $m");
  out.push("        | {");
  out.push("            provider: $p.key,");
  out.push("            service: $s.key,");
  out.push("            protocols: $s.value,");
  out.push("            in:       $m.inputUsdPerMillion,");
  out.push("            cachedIn: $m.cachedInputUsdPerMillion,");
  out.push("            out:      $m.outputUsdPerMillion,");
  out.push("            tags:     $m.tags");
  out.push("          }");
  out.push("      ]");
  out.push("    }'");
  out.push('');
  out.push('# 8. (Optional) Pin a peer (session-wide) to force a specific seller.');
  out.push('#    Not required — model-only requests auto-select a peer. Clear a stale');
  out.push('#    pin with `antseed buyer connection clear`.');
  out.push('antseed buyer connection set --peer <peerId>');
  out.push('');
  out.push('# 9. (Optional) Deposit USDC on Base for paid services');
  out.push('antseed buyer deposit  # prints the funding address + QR; incoming USDC deposits automatically (gasless)');
  out.push('```');
  out.push('');
  out.push('### Security notes for agents and deploys');
  out.push('');
  out.push('- Treat `ANTSEED_IDENTITY_HEX` / `~/.antseed/identity.key` as a hot wallet key.');
  out.push('  Never print it, paste it into chat, commit it, or copy it off the buyer host.');
  out.push('- Keep the buyer proxy bound to `127.0.0.1` / `localhost`. Do not expose');
  out.push('  `:8377` directly to the public internet. For a remote agent, open **Agents**');
  out.push('  in the AI VPN and configure ngrok or Cloudflare under **Define your');
  out.push('  internet-accessible Antseed endpoint**. Use the displayed `/v1` URL and');
  out.push('  generated `antseed_...` API key.');
  out.push('- Start with small USDC deposits and conservative reserve caps for autonomous');
  out.push('  agents. The funding wallet does not need to stay connected after depositing.');
  out.push('- For the local buyer proxy, a required API-key field can use a non-secret');
  out.push('  placeholder such as `antseed`. The public endpoint requires its generated key');
  out.push('  as `Authorization: Bearer <API_KEY>`.');
  out.push('');

  out.push('## Endpoints exposed by the buyer proxy');
  out.push('');
  out.push('| Path | Wire format | Common callers |');
  out.push('|------|-------------|----------------|');
  out.push('| `GET /v1/models` | Model catalog | Agents, SDK setup, model pickers |');
  out.push('| `POST /v1/messages` | Anthropic Messages | Claude Code, Anthropic SDKs, OpenClaw |');
  out.push('| `POST /v1/messages/count_tokens` | Anthropic token counting | Claude-compatible preflight calls |');
  out.push('| `POST /v1/chat/completions` | OpenAI Chat Completions | Codex, Hermes, OpenAI SDKs, Vercel AI SDK, LangChain, most tools |');
  out.push('| `POST /v1/responses` | OpenAI Responses | Codex (newer builds), tools using the Responses API |');
  out.push('| `POST /v1/images/generations` | OpenAI image generation | Image-capable SDKs and applications |');
  out.push('| `POST /v1/images/edits` | OpenAI image editing | Image-capable SDKs and applications |');
  out.push('');
  out.push('All four LLM protocols (including legacy `openai-completions`) are supported by');
  out.push('`@antseed/api-adapter` for translation. Translation is automatic: a request that arrives in one');
  out.push('format and is routed to a peer whose service advertises a different `protocols`');
  out.push('value is transformed both directions (request and streaming response).');
  out.push('');
  out.push('No `Authorization` header is required by the local buyer proxy. It authenticates');
  out.push("and pays peers using the local node's identity key and on-chain USDC deposits.");
  out.push('The public AI VPN endpoint is different: it requires the generated bearer key on');
  out.push('every request and permits only the routes listed above.');
  out.push('');
  out.push('### Explicit seller overrides');
  out.push('');
  out.push('Pinning is optional — a request that names a model routes automatically. Use');
  out.push('one of these overrides only when you need a specific seller:');
  out.push('');
  out.push('1. **Session pin** — `antseed buyer connection set --peer <peerId>`. Persists in');
  out.push('   `~/.antseed/buyer.state.json` (`pinnedPeerId`) and applies to every request');
  out.push('   until you change it. Best for single-tenant setups (laptops, dedicated agents).');
  out.push('2. **Per-request header** — send `x-antseed-pin-peer: <peerId>` on each call.');
  out.push('   Overrides the session pin for that one request. **You do not need to call');
  out.push('   `antseed buyer connection set` at all** if every request includes this header');
  out.push('   — the proxy will accept and route them. Best for scripts, schedulers, and');
  out.push('   multi-tenant deployments that need to fan out to different peers per call.');
  out.push('3. **Model prefix** — set `model` to `<peerId>@<service-id>` when the client');
  out.push('   lets you type a model name. The prefix is stripped before seller dispatch.');
  out.push('');
  out.push('Model-only routing uses `buyer.routingPreferences` (default `minTrustScore: 60`)');
  out.push('for the same Price + Trust order shown by `/v1/models/:id` and the desktop.');
  out.push('Recognized conversations softly prefer their previous successful seller; this');
  out.push('affinity can fail over, unlike either explicit pin option.');
  out.push('');
  out.push('Example (per-request, no session pin):');
  out.push('');
  out.push('```bash');
  out.push('curl http://localhost:8377/v1/chat/completions \\');
  out.push("  -H 'content-type: application/json' \\");
  out.push("  -H 'x-antseed-pin-peer: cccccccccccccccccccccccccccccccccccccccc' \\");
  out.push('  -d \'{ "model": "minimax-m2.7", "messages": [{"role":"user","content":"hi"}] }\'');
  out.push('```');
  out.push('');
  out.push('Other optional headers:');
  out.push('');
  out.push('- `x-antseed-provider: <providerName>` — when a peer exposes the same service');
  out.push('  through more than one seller-plugin (rare), force a specific one. Most tools');
  out.push('  never need this.');
  out.push('');

  out.push('## Files the CLI creates in `~/.antseed/`');
  out.push('');
  out.push('Knowing what lives in `~/.antseed/` matters for backups, container deploys,');
  out.push('and debugging. The directory is created on first `antseed buyer start` (or');
  out.push('first run of any `antseed` command that needs it).');
  out.push('');
  out.push('| Path | Purpose | Survives restart? | Safe to delete? |');
  out.push('|------|---------|--------------------|------------------|');
  out.push('| `identity.key` | Raw 32-byte EVM private key for the buyer wallet. Fallback when `ANTSEED_IDENTITY_HEX` is not set. | yes | NO — deleting loses access to your USDC deposits. Back this up. |');
  out.push('| `identity.enc` | Encrypted copy of `identity.key` (when the desktop app sets a passphrase). | yes | only if `identity.key` is also intact |');
  out.push('| `config.json` | Static settings: chain id, proxy port, max-pricing caps, bootstrap nodes, payments preferences. Hand-editable. | yes | yes (defaults are sane) |');
  out.push('| `buyer.state.json` | Live runtime state: `pinnedPeerId`, the discovered-peers cache (`discoveredPeers`), on-chain stats, the proxy `pid` and `port`. Re-built from the network on next start. | yes (the pin survives restart) | yes (you lose the pin and the cached peer list — next browse will repopulate) |');
  out.push('| `metering.db` | SQLite log of every request the proxy served (model, peer, tokens, USDC). Used by `antseed buyer status` and the desktop app. | yes | yes (you lose request history; settlement is unaffected) |');
  out.push('| `payments/` | Per-channel state used by the seller-side settlement flow (only relevant if you also run `antseed seller`). | yes | only if you do not run a seller |');
  out.push('| `plugins/` | Cache of downloaded provider plugins. | yes | yes (re-downloaded on next use) |');
  out.push('| `chat/`, `projects/` | Used by the desktop app for local chat history. Empty on a CLI-only setup. | yes | yes |');
  out.push('');
  out.push('### `config.json` (commonly edited)');
  out.push('');
  out.push('```json title="~/.antseed/config.json"');
  out.push('{');
  out.push('  "buyer": {');
  out.push('    "proxyPort": 8377,                  // change if 8377 conflicts on the host');
  out.push('    "minPeerReputation": 0,             // optional: raise to filter lower-reputation peers');
  out.push('    "maxPricing": {                     // refuse to route to peers above this rate');
  out.push('      "defaults": { "inputUsdPerMillion": 100, "outputUsdPerMillion": 100 }');
  out.push('    }');
  out.push('  },');
  out.push('  "payments": {');
  out.push('    "preferredMethod": "crypto",');
  out.push('    "crypto": { "chainId": "base-mainnet" }   // or "base-sepolia" for testnet');
  out.push('  },');
  out.push('  "network": { "bootstrapNodes": [] }   // empty = use built-in defaults');
  out.push('}');
  out.push('```');
  out.push('');
  out.push('Edit, then restart the buyer proxy. **Do not hardcode contract addresses** —');
  out.push('the chain preset (`base-mainnet` / `base-sepolia`) resolves Deposits, Channels,');
  out.push('USDC, and the RPC URL automatically.');
  out.push('');
  out.push('### `buyer.state.json` (read-only in practice)');
  out.push('');
  out.push('Top-level fields that an agent might want to inspect:');
  out.push('');
  out.push('- `pinnedPeerId` — the currently pinned peer (or `null`).');
  out.push('- `pid` / `port` — the running proxy. If `pid` is non-null but the process is gone, `antseed buyer start` will detect the stale lockfile and clean up.');
  out.push('- `discoveredPeers` — cached peer list from the last DHT browse. Refreshed on `antseed network browse`.');
  out.push('- `peersUpdatedAt`, `onChainStatsRefreshedAt` — cache timestamps (epoch millis).');
  out.push('');
  out.push('To force a clean reset of pin + caches without losing your wallet:');
  out.push('');
  out.push('```bash');
  out.push('antseed buyer stop || true');
  out.push('rm ~/.antseed/buyer.state.json');
  out.push('antseed buyer start &');
  out.push('```');
  out.push('');

  out.push('## How to integrate <your tool>');
  out.push('');
  out.push('Below is every integration we currently document. Find your tool, copy the');
  out.push('config block, done. If your tool is not listed but accepts a custom OpenAI or');
  out.push('Anthropic base URL, follow the closest example (or look at the **curl / Raw');
  out.push('HTTP** entry — the contract is stable).');
  out.push('');
  for (const i of integrations) {
    out.push(renderIntegrationMarkdown(i));
    out.push('---');
    out.push('');
  }

  out.push('## For agents writing integrations');
  out.push('');
  out.push('If you are a coding agent helping a user wire up Antseed, the canonical flow is:');
  out.push('');
  out.push('1. Detect what tool the user is using.');
  out.push('2. Look it up in this file by name.');
  out.push('3. Run the **Install** steps if the tool is not present.');
  out.push('4. Before editing config files, read the existing file, preserve unrelated');
  out.push('   user settings, and merge only the Antseed provider/profile block.');
  out.push('5. Apply the **Configure** block (env vars, config file edit, or GUI instruction).');
  out.push('6. Verify with the **Test it** command.');
  out.push('7. (Optional) Force a specific seller: `antseed network browse` → `antseed network');
  out.push("   peer <peerId> --json`. Match the tool's wire format against the service's");
  out.push('   `protocols` array — NOT the `provider` field. Then');
  out.push('   `antseed buyer connection set --peer <peerId>`. Not required — a request that');
  out.push('   names a model uses the shared Price + Trust ranking and policy gates.');
  out.push('8. If the tool is not listed: pick the **curl / Raw HTTP** entry and adapt — the');
  out.push('   contract is stable.');
  out.push('');
  out.push('If a step fails, read the **Troubleshooting** entries; most failures map cleanly.');
  out.push('');

  out.push('## Adding a new integration');
  out.push('');
  out.push('Edit `apps/website/src/integrations/integrations.ts` in');
  out.push('https://github.com/AntSeed/antseed and open a PR. The hub at /integrations, the');
  out.push('per-tool page, and this file are all generated from that single file. The');
  out.push('onboarding skill an agent reads first (install, start, fund, use) is served');
  out.push('at /skill.md.');
  out.push('');
  return out.join('\n');
}

export default function connectPagesPlugin(context: LoadContext): Plugin {
  return {
    name: 'integrations-pages',

    async loadContent() {
      // Generate the crawler catalog into static/ so it is served at
      // /llms-connect.txt in both `docusaurus start` (dev) and
      // `docusaurus build` (prod). Re-runs on content reload, keeping the
      // file fresh while editing integrations.ts.
      const staticDir = path.join(context.siteDir, 'static');
      await fs.mkdir(staticDir, {recursive: true});
      await fs.writeFile(path.join(staticDir, 'llms-connect.txt'), renderSkillMarkdown(), 'utf8');

      // /skill.md is the onboarding skill, copied verbatim from the repo so
      // the website and `gh skill install Antseed/antseed join-buyer` never
      // drift apart.
      const joinBuyer = await fs.readFile(
        path.join(context.siteDir, '..', '..', 'skills', 'join-buyer', 'SKILL.md'),
        'utf8',
      );
      await fs.writeFile(path.join(staticDir, 'skill.md'), joinBuyer, 'utf8');
      return null;
    },

    async contentLoaded({actions}) {
      const {addRoute, createData} = actions;

      // For every integration, register a route /integrations/<slug> that
      // renders src/integrations/IntegrationPage.tsx with that integration as
      // a prop. The hub at /integrations itself comes from src/pages/integrations.tsx.
      for (const i of integrations) {
        const slugData = await createData(`integration-${i.slug}.json`, JSON.stringify(i));
        addRoute({
          path: `/integrations/${i.slug}`,
          component: '@site/src/integrations/IntegrationPage.tsx',
          modules: {integration: slugData},
          exact: true,
        });
      }
    },
  };
}
