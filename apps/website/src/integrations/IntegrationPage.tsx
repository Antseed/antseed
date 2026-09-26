import {useState, useCallback, type JSX} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import {
  CATEGORY_LABELS,
  FORMAT_LABELS,
  FORMAT_ENDPOINT,
  FORMAT_TO_PROTOCOL,
  STATUS_LABELS,
  integrations,
  type Integration,
  type ConfigBlock,
  type Step,
} from './integrations';
import styles from './integrations.module.css';
import {ArrowRight, Button, FinalCta, Ticks, ticksToHtml} from '../components/ui';

function CopyButton({value}: {value: string}) {
  const [copied, setCopied] = useState(false);
  const handle = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button className={`${styles.copyBtn}${copied ? ' ' + styles.copied : ''}`} onClick={handle}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({path, language: _language, snippet}: {path?: string; language?: string; snippet: string}) {
  // Note: we use a <div>, not a <pre>, because Docusaurus' custom.css applies
  // `pre { background: #f6f8fa !important }` globally and we need a dark block.
  return (
    <div className={styles.codeBlockWrap}>
      {path && <span className={styles.codeBlockPath}>{path}</span>}
      <div className={styles.codeBlock} role="figure">
        <span className={styles.codeBlockText}>{snippet}</span>
        <CopyButton value={snippet} />
      </div>
    </div>
  );
}

/** A non-copyable, slightly muted code block used to show command output. */
function ExampleOutput({label = 'Example output', snippet}: {label?: string; snippet: string}) {
  return (
    <div className={styles.exampleOutputWrap}>
      <span className={styles.exampleOutputLabel}>{label}</span>
      <div className={styles.exampleOutput} role="figure">
        <span className={styles.codeBlockText}>{snippet}</span>
      </div>
    </div>
  );
}

function ConfigBlockRenderer({b}: {b: ConfigBlock}) {
  if (b.kind === 'env') {
    const lines = Object.entries(b.vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');
    return (
      <div className={styles.envBlock}>
        <table className={styles.envTable}>
          <tbody>
            {Object.entries(b.vars).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className={styles.envDetails}>
          <summary>Show as shell exports</summary>
          <CodeBlock snippet={lines} />
        </details>
        {b.note && <p className={styles.stepNote}><Ticks>{b.note}</Ticks></p>}
      </div>
    );
  }
  if (b.kind === 'file') {
    return (
      <>
        <CodeBlock path={b.path} language={b.language} snippet={b.snippet} />
        {b.note && <p className={styles.stepNote}><Ticks>{b.note}</Ticks></p>}
      </>
    );
  }
  if (b.kind === 'code') {
    return (
      <>
        <CodeBlock language={b.language} snippet={b.snippet} />
        {b.note && <p className={styles.stepNote}><Ticks>{b.note}</Ticks></p>}
      </>
    );
  }
  return (
    <>
      <div className={styles.guiBlock}><Ticks>{b.instructions}</Ticks></div>
      {b.note && <p className={styles.stepNote}><Ticks>{b.note}</Ticks></p>}
    </>
  );
}

function StepBlock({s}: {s: Step}) {
  return (
    <li className={styles.step}>
      <span className={styles.stepLabel}>{s.label}</span>
      {s.command && <CodeBlock language={s.language} snippet={s.command} />}
      {s.output && <ExampleOutput label={s.outputLabel} snippet={s.output} />}
      {s.note && <p className={styles.stepNote}><Ticks>{s.note}</Ticks></p>}
    </li>
  );
}

function RunFirstBanner() {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div className={`${styles.runFirst}${collapsed ? ' ' + styles.runFirstCollapsed : ''}`}>
      <header className={styles.runFirstHeader}>
        <div>
          <p className={styles.runFirstKicker}>
            <span className={styles.runFirstDot} aria-hidden="true" />
            Run Antseed first
          </p>
          <p className={styles.runFirstSub}>
            Every integration assumes a buyer proxy at <code>http://localhost:8377</code>.
            One-time setup, ~2 minutes.
          </p>
        </div>
        <button
          type="button"
          className={styles.runFirstToggle}
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}>
          {collapsed ? 'Show steps ↓' : 'I’ve done this ↑'}
        </button>
      </header>

      {!collapsed && (
        <>
        <div className={styles.glossary}>
          <p className={styles.glossaryTitle}>The model in your head</p>
          <ul className={styles.glossaryList}>
            <li>
              <strong>Buyer proxy</strong> - a small server on{' '}
              <code>localhost:8377</code> that accepts API calls from your tools and
              forwards them to the Antseed network. It speaks{' '}
              <em>all four LLM protocols</em> at once -{' '}
              <code>/v1/messages</code> (Anthropic),{' '}
              <code>/v1/chat/completions</code> (OpenAI Chat),{' '}
              <code>/v1/responses</code> (OpenAI Responses), and{' '}
              <code>/v1/completions</code> (legacy) - and translates between them via{' '}
              <a
                href="https://github.com/AntSeed/antseed/tree/main/packages/api-adapter"
                target="_blank"
                rel="noreferrer">
                <code>@antseed/api-adapter</code>
              </a>
              . So a tool that only knows Anthropic Messages can still reach an OpenAI
              peer (and vice versa).
            </li>
            <li>
              <strong>Peer</strong> - someone selling inference. Every peer has a{' '}
              <code>peerId</code> (40-char hex), a display name, and a list of services.
            </li>
            <li>
              <strong>Service</strong> - a single model id like{' '}
              <code>kimi-k2.6</code> or <code>deepseek-v4-flash</code>. <em>This
              is what you pass as <code>model</code> in your tool's config.</em>
              Each service has its own native protocol list and{' '}
              <code>in</code>/<code>cachedIn</code>/<code>out</code> pricing.
            </li>
            <li>
              <strong>Protocols</strong> (per service) - the wire formats a service
              accepts <em>natively</em>, advertised on each peer in{' '}
              <code>providerServiceApiProtocols[provider].services[service]</code>. Values:{' '}
              <code>anthropic-messages</code>, <code>openai-chat-completions</code>,{' '}
              <code>openai-responses</code>, <code>openai-completions</code>. <strong>
              This is the field to match your tool against.</strong> If your tool's
              wire format is in this list, traffic passes through untouched. If not,
              the api-adapter translates on the fly.
            </li>
            <li>
              <strong>Cached input pricing</strong> - services charge a separate,
              much lower rate (typically 4–10×) for tokens that are reused across
              requests: system prompts, tool schemas, prior conversation turns, long
              files you keep referencing. The CLI exposes it as{' '}
              <code>cachedInputUsdPerMillion</code>. For long-running agents and
              chatbots, this is often the dominant cost line.
            </li>
            <li>
              <strong>Pin</strong> - optionally telling your buyer proxy “route
              requests to <em>this</em> peer.” Without a pin, the proxy
              ranks eligible offers with the same Price + Trust preferences used
              by the desktop and can fail over on retryable peer failures. A
              recognized conversation softly prefers its previous successful
              seller; pin only when you want one specific seller: a session-wide pin via{' '}
              <code>antseed buyer connection set --peer &lt;id&gt;</code> (saved to{' '}
              <code>~/.antseed/buyer.state.json</code>), or a per-request{' '}
              <code>x-antseed-pin-peer: &lt;id&gt;</code> header (no session state
              needed). See Step 4.
            </li>
          </ul>
        </div>
        <ol className={styles.runFirstRail}>
          <li className={styles.runFirstItem}>
            <span className={styles.runFirstNum}>1</span>
            <div className={styles.runFirstBody}>
              <p className={styles.runFirstStepTitle}>
                Install the CLI and start the buyer proxy.
              </p>
              <p className={styles.runFirstHint}>
                <strong>Recommended:</strong> the <Link to="/install">AI VPN desktop app</Link>{' '}
                wraps everything below in one app — its <strong>Apps</strong> view
                launches tools like this one pre-wired to the proxy and saves its
                Price + Trust preferences into the buyer config used by every client.
                The CLI flow below is for headless machines and scripts:
              </p>
              <CodeBlock
                snippet={`# 1. Install\nnpm install -g @antseed/cli\n\n# 2. Set a buyer identity (64-char hex private key).\n#    This signs requests; it never holds USDC. Generate once, reuse forever.\nexport ANTSEED_IDENTITY_HEX=$(openssl rand -hex 32)\n\n# 3. Start the proxy on http://localhost:8377\nantseed buyer start`}
              />
              <p className={styles.runFirstHint}>
                Save the value of <code>ANTSEED_IDENTITY_HEX</code> somewhere safe -
                losing it means losing access to whatever USDC you've deposited under that
                buyer address.
              </p>
            </div>
          </li>

          <li className={styles.runFirstItem}>
            <span className={styles.runFirstNum}>2</span>
            <div className={styles.runFirstBody}>
              <p className={styles.runFirstStepTitle}>
                Browse the network as JSON - see who's selling what.
              </p>
              <p className={styles.runFirstHint}>
                Pretty TUI table: <code>antseed network browse</code>. For docs and
                scripts we use the JSON form instead - it's compact, agent-readable, and
                tells you exactly which fields exist.
              </p>
              <p className={styles.runFirstHint}>
                Each peer advertises a list of <strong>services</strong> (model ids).
                Each service has its own native protocol list in{' '}
                <code>providerServiceApiProtocols</code> and pricing in USD per 1M
                tokens. The jq below
                projects the raw response down to just those fields.
              </p>
              <CodeBlock
                snippet={`antseed network browse --json --top 5 \\
  | jq '.peers | map({
      peerId, name: .displayName,
      services: [
        (.providerServiceApiProtocols | to_entries[]) as $p
        | ($p.value.services | to_entries[]) as $s
        | {
            service: $s.key,
            protocols: $s.value,
            in:       (.providerPricing[$p.key].services[$s.key].inputUsdPerMillion       // .providerPricing[$p.key].defaults.inputUsdPerMillion),
            cachedIn: (.providerPricing[$p.key].services[$s.key].cachedInputUsdPerMillion // null),
            out:      (.providerPricing[$p.key].services[$s.key].outputUsdPerMillion      // .providerPricing[$p.key].defaults.outputUsdPerMillion)
          }
      ]
    })'`}
              />
              <ExampleOutput
                label="Example response (2 peers, abbreviated - fictional)"
                snippet={`[
  {
    "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "name": "Acme Inference",
    "services": [
      { "service": "kimi-k2.6",    "protocols": ["openai-responses"],         "in": 0.6,  "cachedIn": 0.06, "out": 2.5 },
      { "service": "gpt-oss-120b", "protocols": ["openai-responses"],         "in": 0.15, "cachedIn": 0.02, "out": 0.6 },
      { "service": "minimax-m2.7", "protocols": ["openai-chat-completions"],  "in": 0.21, "cachedIn": 0.04, "out": 0.84 }
    ]
  },
  {
    "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "name": "Example Labs",
    "services": [
      { "service": "qwen3-235b-instruct", "protocols": ["openai-chat-completions"], "in": 0,    "cachedIn": 0,     "out": 0 },
      { "service": "glm-4.7-flash",       "protocols": ["openai-chat-completions"], "in": 0.06, "cachedIn": 0.01,  "out": 0.4 },
      { "service": "deepseek-v3.2",       "protocols": ["openai-chat-completions"], "in": 0.26, "cachedIn": 0.13,  "out": 0.38 }
    ]
  }
]`}
              />
              <p className={styles.runFirstHint}>
                <strong>How to read it:</strong> each row is a model you can pass as{' '}
                <code>model</code> in your tool's config. <code>protocols</code> is the
                field to match against your tool's wire format - if your tool sends
                Anthropic Messages, look for <code>anthropic-messages</code>; if it
                sends OpenAI Chat, look for <code>openai-chat-completions</code>; etc.
                <code>in</code> / <code>cachedIn</code> / <code>out</code> are USD per
                1M tokens (fresh input / cached input / output) -{' '}
                <code>cachedIn</code> is what you pay when prompt prefixes are reused
                (system prompts, tool schemas, prior turns), typically 4–10× cheaper
                than <code>in</code> and often the dominant cost line for long agents.
                Names and ids in the example are fictional; your real output will list
                the operators currently online.
              </p>
              <p className={styles.runFirstHint}>
                Prefer the visual version? <code>antseed network browse</code> (no flags)
                prints a table with prices, sessions, on-chain volume, and a{' '}
                <code>✓</code> for vouched peers. Or open the same view in a browser:{' '}
                <a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer">live network page</a>.
              </p>
            </div>
          </li>

          <li className={styles.runFirstItem}>
            <span className={styles.runFirstNum}>3</span>
            <div className={styles.runFirstBody}>
              <p className={styles.runFirstStepTitle}>
                Inspect one peer's full menu - every service, every price.
              </p>
              <CodeBlock
                snippet={`antseed network peer cccccccccccccccccccccccccccccccccccccccc --json \\
  | jq '{
      peer: (.peer | { peerId, name: .displayName,
                       sessions: .onChainChannelCount,
                       ghosts:   .onChainGhostCount }),
      services: [
        (.peer.providerServiceApiProtocols | to_entries[]) as $p
        | ($p.value.services | to_entries[]) as $s
        | (.matchingServices[] | select(.provider == $p.key and .service == $s.key)) as $m
        | {
            provider: $p.key,
            service: $s.key,
            protocols: $s.value,
            in:       $m.inputUsdPerMillion,
            cachedIn: $m.cachedInputUsdPerMillion,
            out:      $m.outputUsdPerMillion,
            tags:     $m.tags
          }
      }]
    }'`}
              />
              <ExampleOutput
                label="Example response (Demo Provider, abbreviated - fictional)"
                snippet={`{
  "peer": {
    "peerId": "cccccccccccccccccccccccccccccccccccccccc",
    "name": "Demo Provider",
    "sessions": 12,
    "ghosts": 0
  },
  "services": [
    { "service": "deepseek-v4-flash", "protocols": ["openai-chat-completions"], "in": 0,    "cachedIn": 0,    "out": 0,    "tags": ["chat","fast","free","tasks"] },
    { "service": "minimax-m2.7",      "protocols": ["openai-chat-completions"], "in": 0.21, "cachedIn": 0.04, "out": 0.84, "tags": ["chat","writing","creative"] },
    { "service": "kimi-k2.6",         "protocols": ["openai-chat-completions","anthropic-messages"], "in": 0.6, "cachedIn": 0.06, "out": 2.5, "tags": ["chat","code","coding"] },
    { "service": "qwen3-235b-a22b-thinking", "protocols": ["openai-responses"], "in": 0.25, "cachedIn": 0.05, "out": 2, "tags": ["chat","reasoning"] }
  ]
}`}
              />
              <p className={styles.runFirstHint}>
                <strong>How to read it:</strong>
              </p>
              <ul className={styles.runFirstFieldList}>
                <li>
                  <code>service</code> - the model id. This is what you put in your
                  tool's <code>model</code> field.
                </li>
                <li>
                  <code>protocols</code> - projected from{' '}
                  <code>providerServiceApiProtocols</code>; the wire formats this
                  service accepts <em>natively</em>. Match your tool's wire format
                  against this list: if it's in there, the request passes through untouched; if not,{' '}
                  <code>@antseed/api-adapter</code> translates on the fly. Note:{' '}
                  <code>openai-responses</code>-only services require streaming.
                </li>
                <li>
                  <code>in</code> / <code>out</code> - USD per <strong>1M tokens</strong>{' '}
                  (fresh input / output). <code>0 / 0</code> = free.
                </li>
                <li>
                  <code>cachedIn</code> - USD per 1M <em>cached</em> input tokens.
                  When a request reuses prefix tokens (the system prompt, tool
                  schemas, prior turns of a conversation, a long file you keep
                  re-asking about, …) those tokens bill at this rate instead of{' '}
                  <code>in</code>. Typically <strong>4–10× cheaper</strong> - e.g.{' '}
                  <code>minimax-m2.7</code> charges $0.21/M for fresh input but only
                  $0.04/M for cache hits. For long-running coding agents and
                  chatbots, this is often the dominant cost line; use it when
                  comparing peers.
                </li>
                <li>
                  <code>tags</code> - capability hints. <code>coding</code>,{' '}
                  <code>vision</code>, <code>fast</code>, <code>free</code>, etc.
                </li>
                <li>
                  <code>sessions</code> / <code>ghosts</code> - on-chain reputation.
                  Sessions = settled streams. Ghosts = streams that opened but never
                  closed cleanly.
                </li>
              </ul>
              <p className={styles.runFirstHint}>
                Free-text version with on-chain stats and pin command:{' '}
                <code>antseed network peer &lt;peerId&gt;</code> (without{' '}
                <code>--json</code>).
              </p>
            </div>
          </li>

          <li className={styles.runFirstItem}>
            <span className={styles.runFirstNum}>4</span>
            <div className={styles.runFirstBody}>
              <p className={styles.runFirstStepTitle}>
                Verify the proxy sees your models — and optionally pick a seller.
              </p>
              <p className={styles.runFirstHint}>
                <strong>No pin needed.</strong> A request that names only a model
                selects the highest-ranked eligible offer under your shared Price +
                Trust preferences and fails over to the next-ranked seller on
                retryable peer errors.{' '}
                <code>/v1/models</code> lists every model on the network,
                aggregated across sellers:
              </p>
              <CodeBlock
                snippet={`# Every model on the network (OpenAI-compatible, answered locally)\ncurl -s http://localhost:8377/v1/models | jq '.data[].id'`}
              />
              <ExampleOutput
                label="Example response"
                snippet={`"deepseek-v4-flash"
"gpt-oss-120b"
"gemma-3-27b"
"qwen3-coder-480b"
"kimi-k2.6"
"minimax-m2.7"`}
              />
              <p className={styles.runFirstHint}>
                These are the values you can pass as <code>model</code> in your
                tool's config (close aliases like <code>opus-5</code> for{' '}
                <code>claude-opus-5</code> also resolve). A model no policy-allowed
                peer serves returns <code>502 model_not_found</code>.
              </p>
              <p className={styles.runFirstHint}>
                Automatic routes keep soft conversation affinity when the tool sends
                stable session metadata: later turns prefer the seller and service that
                actually served the chat, but can fail over if that route becomes
                unavailable or ineligible. Explicit pins remain hard.
              </p>
              <p className={styles.runFirstHint} style={{marginTop: 12}}>
                To force a <em>specific</em> seller instead of auto-selection,
                pick one of three overrides — you can mix them:
              </p>
              <p className={styles.runFirstHint} style={{marginTop: 6}}>
                <strong>Option A - session pin.</strong> One command, every
                future request goes to that peer. Persists in{' '}
                <code>~/.antseed/buyer.state.json</code> across restarts.
              </p>
              <CodeBlock
                snippet={`# Pin the peer you chose for every request from now on (survives restart).\n# Replace the id below with one from your real \`antseed network browse\` output.\nantseed buyer connection set --peer cccccccccccccccccccccccccccccccccccccccc`}
              />
              <p className={styles.runFirstHint} style={{marginTop: 12}}>
                <strong>Option B - per-request header.</strong> Send{' '}
                <code>x-antseed-pin-peer: &lt;peerId&gt;</code> on each call. Overrides
                any session pin for that one request. Best for scripts, schedulers, and
                multi-tenant deployments that fan out to different peers per call.
              </p>
              <CodeBlock
                snippet={`curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -H 'x-antseed-pin-peer: cccccccccccccccccccccccccccccccccccccccc' \\
  -d '{
    "model": "minimax-m2.7",
    "messages": [{"role": "user", "content": "hi"}]
  }'`}
              />
              <p className={styles.runFirstHint} style={{marginTop: 12}}>
                <strong>Option C - model prefix (works in any tool).</strong> Set the{' '}
                <code>model</code> field to <code>&lt;peerId&gt;@&lt;service-id&gt;</code>.
                The proxy pins that peer for the request and strips the prefix before
                routing, so the seller just sees the service id. This is the way to pick
                a peer from tools where you can only type a model name.
              </p>
              <CodeBlock
                snippet={`curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "cccccccccccccccccccccccccccccccccccccccc@minimax-m2.7",
    "messages": [{"role": "user", "content": "hi"}]
  }'`}
              />
            </div>
          </li>

          <li className={`${styles.runFirstItem} ${styles.runFirstItemOptional}`}>
            <span className={styles.runFirstNum}>5</span>
            <div className={styles.runFirstBody}>
              <p className={styles.runFirstStepTitle}>
                <span className={styles.runFirstOptionalTag}>Optional</span>
                Deposit USDC - only needed for paid services:
              </p>
              <CodeBlock snippet={`antseed buyer deposit`} />
              <p className={styles.runFirstHint}>
                Prints your buyer&apos;s funding address and a QR code (an EIP-681
                payment request). Send USDC to it from any wallet or exchange —
                incoming funds are swept into the Deposits contract and credited to
                your buyer automatically: a permissionless relayer submits the
                transaction for a fixed ~$0.05 USDC fee, so the buyer never needs
                ETH. Verify with <code>antseed buyer balance</code>.
              </p>
              <p className={styles.runFirstHint}>
                <strong>Send USDC on the Base network only</strong> - other tokens or
                networks are not recoverable by the sweep.
              </p>
            </div>
          </li>
        </ol>
        </>
      )}
    </div>
  );
}

/**
 * Explains, in one block, exactly what wire format the tool sends, what Antseed
 * peers advertise per service (the `protocols` array), and what happens when
 * they differ.
 *
 * IMPORTANT: a peer's `provider` field is a seller-side plugin label
 * (`anthropic`, `openai`, `local-llm`, ...). The actual wire format the service
 * accepts natively is in
 * `providerServiceApiProtocols[provider].services[service]`. This panel is
 * built around that distinction.
 */
function WireFormatPanel({i}: {i: Integration}) {
  const fmt = i.format;
  const isMulti = fmt === 'multi';

  if (isMulti) {
    return (
      <section className={styles.wireFormat}>
        <p className={styles.wireFormatTitle}>Wire format • multi-protocol</p>
        <p className={styles.wireFormatBody}>
          {i.name} can send <strong>any</strong> of Antseed's supported protocols -
          configure per call. Antseed will match each request to the peer's advertised
          service protocols (see <code>providerServiceApiProtocols</code> on a peer)
          and translate when they don't match.
        </p>
        <ul className={styles.wireFormatGrid}>
          {(['anthropic-messages', 'openai-chat', 'openai-responses'] as const).map(
            (f) => (
              <li key={f} className={styles.wireFormatRow}>
                <code className={styles.wireFormatCode}>{FORMAT_ENDPOINT[f]}</code>
                <span className={styles.wireFormatLabel}>{FORMAT_LABELS[f]}</span>
                <span className={styles.wireFormatNative}>
                  service <code>protocols</code> includes{' '}
                  <code>{FORMAT_TO_PROTOCOL[f]}</code>
                </span>
              </li>
            ),
          )}
        </ul>
      </section>
    );
  }

  const protocol = FORMAT_TO_PROTOCOL[fmt];
  const endpoint = FORMAT_ENDPOINT[fmt];

  return (
    <section className={styles.wireFormat}>
      <p className={styles.wireFormatTitle}>How {i.name} talks to Antseed</p>
      <ul className={styles.wireFormatFacts}>
        <li>
          <strong>Wire format sent by {i.name}:</strong>{' '}
          <code>{FORMAT_LABELS[fmt]}</code>{' '}
          <span className={styles.wireFormatDim}>
            (hits <code>{endpoint}</code> on the buyer proxy)
          </span>
        </li>
        <li>
          <strong>Best-fit services:</strong> any service whose{' '}
          <code>protocols</code> array contains <code>{protocol}</code>. That's what
          the peer advertises as natively-supported - zero translation overhead,
          no transform edge cases.
        </li>
        <li>
          <strong>How to check a peer:</strong> run{' '}
          <code>antseed network peer &lt;peerId&gt; --json</code> and look at{' '}
          <code>providerServiceApiProtocols[provider].services[service]</code>. The
          browse command exposes the same field per peer.
        </li>
        <li>
          <strong>What happens when protocols don't match:</strong> Antseed's{' '}
          <a
            href="https://github.com/AntSeed/antseed/tree/main/packages/api-adapter"
            target="_blank"
            rel="noreferrer">
            <code>@antseed/api-adapter</code>
          </a>{' '}
          translates between {FORMAT_LABELS[fmt]} and the service's native protocol on
          the fly. So a request from {i.name} can still reach a service that only
          advertises{' '}
          {fmt === 'anthropic-messages' ? (
            <code>openai-chat-completions</code>
          ) : (
            <code>anthropic-messages</code>
          )}{' '}
          - just with a small transform step.
        </li>
        {fmt !== 'openai-responses' && (
          <li className={styles.wireFormatWarn}>
            <strong>One known caveat:</strong> services whose only advertised protocol
            is <code>openai-responses</code> require streaming. If {i.name} sends a
            non-streaming request and the proxy routes it to one of those services,
            the call fails with <code>HTTP 400: Stream must be set to true</code>.
            Pick a service whose <code>protocols</code> includes{' '}
            <code>{protocol}</code> (or another non-responses protocol) to avoid this.
          </li>
        )}
      </ul>
    </section>
  );
}

function Section({eyebrow, title, children}: {eyebrow: string; title: string; children: React.ReactNode}) {
  return (
    <section className={styles.section}>
      <p className={styles.sectionEyebrow}>{eyebrow}</p>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

export default function IntegrationPage({integration}: {integration: Integration}): JSX.Element {
  const i = integration;
  const mutedLogo = i.slug === 'genlayer-studio' || i.slug === 'langchain-python';

  // Pick related integrations from the same category, excluding self.
  const related = integrations
    .filter((x) => x.category === i.category && x.slug !== i.slug)
    .slice(0, 4);

  // Trailing slash matches `trailingSlash: true` in docusaurus.config.ts, so the
  // URLs in JSON-LD are the same ones the canonical tag and sitemap point at.
  const pageUrl = `https://antseed.com/integrations/${i.slug}/`;

  // `oneLiner` is authored with markdown backticks for on-page code styling.
  // Meta descriptions are plain text, so Google and social cards would print the
  // backticks literally. Strip them for metadata only; page copy is untouched.
  const metaOneLiner = i.oneLiner.replace(/`/g, '');

  // Mirrors what Docusaurus renders into <title> (Layout title + site title), so
  // og:title can't drift from the page title (X falls back to og:title).
  const titleText = i.seoTitle ?? i.name;
  const pageTitle = `${titleText} | Antseed`;

  // Marks up the breadcrumb rendered below so search engines read the hierarchy.
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {'@type': 'ListItem', position: 1, name: 'Home', item: 'https://antseed.com/'},
      {'@type': 'ListItem', position: 2, name: 'Integrations', item: 'https://antseed.com/integrations/'},
      {'@type': 'ListItem', position: 3, name: i.name, item: pageUrl},
    ],
  };

  // Mirrors the Step sections actually rendered below, in the same order, so the
  // markup never claims a step the page doesn't show.
  const howToLd = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: `Connect ${i.name} to Antseed`,
    description: `Route ${i.name} through the Antseed peer-to-peer inference network.`,
    step: [
      ...(i.install.length > 0
        ? [{
            '@type': 'HowToStep',
            name: `Install ${i.name}`,
            text: i.install.map((s) => s.label).join(' '),
            url: `${pageUrl}#install`,
          }]
        : []),
      {
        '@type': 'HowToStep',
        name: `Point ${i.name} at Antseed`,
        text: `Configure ${i.name} to send requests to the local Antseed proxy at http://localhost:8377.`,
        url: `${pageUrl}#configure`,
      },
      ...(i.modelHints
        ? [{
            '@type': 'HowToStep',
            name: 'Pick a model',
            text: `Choose a model available on the network. Suggested: ${i.modelHints.suggested.join(', ')}.`,
            url: `${pageUrl}#model`,
          }]
        : []),
      ...(i.test && i.test.length > 0
        ? [{
            '@type': 'HowToStep',
            name: 'Test it',
            text: i.test.map((s) => s.label).join(' '),
            url: `${pageUrl}#test`,
          }]
        : []),
    ],
  };

  return (
    <Layout
      title={titleText}
      description={`Connect ${i.name} to the Antseed peer-to-peer inference network. ${metaOneLiner}`}>
      <Head>
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={metaOneLiner} />
        <script type="application/ld+json">{JSON.stringify(breadcrumbLd)}</script>
        <script type="application/ld+json">{JSON.stringify(howToLd)}</script>
      </Head>

      <article className={styles.detailWrap}>
        <nav className={styles.breadcrumb}>
          <Link to="/integrations">Integrations</Link> <span className={styles.breadcrumbSep}>/</span>{' '}
          <span>{i.name}</span>
        </nav>

        <header className={styles.detailHeader}>
          <div className={styles.detailLogo}>
            {i.logo ? (
              <img
                src={`/logos/${i.logo}`}
                alt=""
                className={mutedLogo ? styles.mutedLogoImg : undefined}
              />
            ) : (
              <span>{i.glyph ?? i.name[0]}</span>
            )}
          </div>
          <div className={styles.detailHeaderText}>
            <h1>{i.headline ?? i.name}</h1>
            <p className={styles.detailOneLiner}><Ticks>{i.oneLiner}</Ticks></p>
            <div className={styles.detailBadgeRow}>
              <span className={`${styles.detailBadge} ${styles.detailBadgeGreen}`}>{CATEGORY_LABELS[i.category]}</span>
              <span className={styles.detailBadge}>{FORMAT_LABELS[i.format]}</span>
              <span className={styles.detailBadge}>~{i.setupMinutes} min</span>
              {i.status === 'community' && <span className={styles.detailBadge}>{STATUS_LABELS[i.status]}</span>}
              {i.status === 'coming-soon' && <span className={styles.detailBadge}>{STATUS_LABELS[i.status]}</span>}
            </div>
          </div>
        </header>

        <div className={styles.description}>
          {i.description.map((p, idx) => (
            <p key={idx} dangerouslySetInnerHTML={{__html: ticksToHtml(p)}} />
          ))}
        </div>

        <RunFirstBanner />

        {i.prereqs && i.prereqs.length > 0 && (
          <Section eyebrow="Before you start" title="Prerequisites">
            <ul className={styles.bulletList}>
              {i.prereqs.map((p, idx) => <li key={idx}><Ticks>{p}</Ticks></li>)}
            </ul>
          </Section>
        )}

        {i.install.length > 0 && (
          <Section eyebrow="Step 1" title={`Install ${i.name}`}>
            <ul className={styles.stepList}>
              {i.install.map((s, idx) => <StepBlock key={idx} s={s} />)}
            </ul>
          </Section>
        )}

        <Section
          eyebrow={i.install.length > 0 ? 'Step 2' : 'Step 1'}
          title={`Point ${i.name} at Antseed`}>
          <div className={styles.configList}>
            {i.configure.map((b, idx) => <ConfigBlockRenderer key={idx} b={b} />)}
          </div>
        </Section>

        {i.modelHints && (
          <Section eyebrow="Step 3" title="Pick a model">
            <div className={styles.modelChips}>
              {i.modelHints.suggested.map((m) => <span key={m} className={styles.modelChip}>{m}</span>)}
            </div>
            {i.modelHints.note && <p className={styles.modelNote}><Ticks>{i.modelHints.note}</Ticks></p>}
            <p className={styles.modelNote}>
              The full list is every model on the network. Run{' '}
              <code>curl -s localhost:8377/v1/models</code>,{' '}
              <code>antseed network browse</code>, or open the{' '}
              <a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer">live network page</a> to see what's available right now.
            </p>
          </Section>
        )}

        {i.test && i.test.length > 0 && (
          <Section eyebrow="Verify" title="Test it">
            <ul className={styles.stepList}>
              {i.test.map((s, idx) => <StepBlock key={idx} s={s} />)}
            </ul>
          </Section>
        )}

        <WireFormatPanel i={i} />

        {i.troubleshooting && i.troubleshooting.length > 0 && (
          <section className={styles.section}>
            <p className={styles.sectionEyebrow}>If it goes wrong</p>
            <h2 className={styles.sectionTitle}>Troubleshooting</h2>
            <ul className={styles.troubleshootList}>
              {i.troubleshooting.map((t, idx) => (
                <li key={idx}>
                  <strong><Ticks>{t.problem}</Ticks></strong>
                  <Ticks>{t.fix}</Ticks>
                </li>
              ))}
            </ul>
          </section>
        )}

        {i.caveats && i.caveats.length > 0 && (
          <section className={styles.section}>
            <p className={styles.sectionEyebrow}>Heads up</p>
            <h2 className={styles.sectionTitle}>Caveats</h2>
            <ul className={styles.bulletList}>
              {i.caveats.map((c, idx) => <li key={idx}><Ticks>{c}</Ticks></li>)}
            </ul>
          </section>
        )}

        {i.links && i.links.length > 0 && (
          <section className={styles.section}>
            <p className={styles.sectionEyebrow}>Reference</p>
            <h2 className={styles.sectionTitle}>Links</h2>
            <div className={styles.linkRow}>
              {i.links.map((l, idx) => (
                <a key={idx} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
              ))}
            </div>
          </section>
        )}

        {i.agentSummary && (
          <aside className={styles.agentBox}>
            <h3>For agents</h3>
            <p><Ticks>{i.agentSummary}</Ticks></p>
            <p>
              Give your agent the skill: <code>gh skill install Antseed/antseed join-buyer</code>
            </p>
          </aside>
        )}

        {related.length > 0 && (
          <section className={styles.section}>
            <p className={styles.sectionEyebrow}>Same category</p>
            <h2 className={styles.sectionTitle}>Related</h2>
            <div className={styles.relatedRow}>
              {related.map((r) => (
                <Link key={r.slug} to={`/integrations/${r.slug}`}>{r.name}</Link>
              ))}
              <Link to="/integrations">All integrations<ArrowRight size={16} /></Link>
            </div>
          </section>
        )}
      </article>

      <FinalCta
        title={`Run ${i.name} on the open market`}
        sub="Install Antseed, point this tool at your local proxy, and pay per request in USDC."
        note={
          <>
            <a href="/integrations">All integrations</a>
            <a href="/docs/guides/using-the-api">Protocol guide</a>
          </>
        }>
        <Button to="/docs/install" variant="white" size="lg" arrow>Install Antseed</Button>
        <Button to="/providers" variant="light" size="lg">Become a provider</Button>
      </FinalCta>
    </Layout>
  );
}
