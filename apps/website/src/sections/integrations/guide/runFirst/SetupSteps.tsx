import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {CodeBlock} from '../../../../parts/CodeBlock';
import {Code} from '../../../../parts/Ticks';
import {LIST_MODELS_COMMAND} from '../../../../integrations/integrations';
import styles from './RunFirst.module.css';

/** The one-time setup every integration needs: an endpoint, the network's models, a seller if you want one, funds. */
export function SetupSteps(): JSX.Element {
  return (
    <ol className={styles.steps}>
      <li className={styles.item}>
        <span className={styles.num}>1</span>
        <div className={styles.body}>
          <p className={styles.stepTitle}>
            Run a gateway, ideally on a small server (VPS).
          </p>
          <p className={styles.hint}>
            <strong>Recommended: a gateway on a server.</strong> One command on any
            Linux VPS with systemd installs the buyer and the gateway, serves them over
            HTTPS on your domain and keeps them running. Every tool, on any machine,
            then uses the same URL with its own API key, and keeps working when your
            laptop sleeps. See <Link to="/docs/gateway/server/">Run a gateway on a server</Link>.
          </p>
          <CodeBlock
            code={`# On the server (DNS for the domain points at it, ports 80 and 443 open)\ncurl -fsSL https://antseed.com/install.sh | bash -s -- --domain gateway.example.com\n\n# Then, wherever your tool runs:\nexport ANTSEED_BASE_URL="https://gateway.example.com/v1"\nexport ANTSEED_API_KEY="antseed_…"   # printed by the installer, or from the console's Keys page`}
          />
          <p className={styles.hint}>
            <strong>Just trying it out?</strong> Run the gateway on your own computer
            with <Code>curl -fsSL https://antseed.com/install.sh | bash</Code> and use{' '}
            <Code>http://localhost:8379/v1</Code>. Its keys only work while the computer
            is on, and other machines can't reach it unless you publish it with a{' '}
            <Link to="/docs/tunnels/">tunnel</Link> (<Code>antseed tunnel start</Code>)
            or, on a network you trust, start it
            with <Code>--host 0.0.0.0</Code>. You can{' '}
            <Link to="/docs/gateway/migrate/">move it to a server</Link> later with its
            keys and wallets. See the <Link to="/docs/quickstart/">quickstart</Link>.
          </p>
          <p className={styles.hint}>
            <strong>Same computer, no gateway.</strong> The desktop app runs the buyer
            proxy for you, and its <strong>Apps</strong> view launches tools pre-wired
            to it. Headless:
          </p>
          <CodeBlock
            code={`npm install -g @antseed/cli\nantseed buyer start   # http://localhost:8377/v1, no key needed`}
          />
          <p className={styles.hint}>
            The buyer proxy only listens on localhost and spends from your deposit
            without checking a key. Never publish port 8377 (port forward,{' '}
            <Code>socat</Code>, reverse proxy); put a gateway in front of it instead.
            Back up <Code>~/.antseed/identity.key</Code>: it is the buyer wallet key.
          </p>
        </div>
      </li>

      <li className={styles.item}>
        <span className={styles.num}>2</span>
        <div className={styles.body}>
          <p className={styles.stepTitle}>
            Browse the network as JSON - see who's selling what.
          </p>
          <p className={styles.hint}>
            Pretty TUI table: <Code>antseed network browse</Code>. For docs and
            scripts we use the JSON form instead - it's compact, agent-readable, and
            tells you exactly which fields exist.
          </p>
          <p className={styles.hint}>
            Each peer advertises a list of <strong>services</strong> (model ids).
            Each service has its own native protocol list in{' '}
            <Code>providerServiceApiProtocols</Code> and pricing in USD per 1M
            tokens. The jq below
            projects the raw response down to just those fields.
          </p>
          <CodeBlock
            code={`antseed network browse --json --top 5 \\
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
          <CodeBlock output label="Example response (2 peers, abbreviated - fictional)"
            code={`[
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
          <p className={styles.hint}>
            <strong>How to read it:</strong> each row is a model you can pass as{' '}
            <Code>model</Code> in your tool's config. <Code>protocols</Code> is the
            field to match against your tool's wire format - if your tool sends
            Anthropic Messages, look for <Code>anthropic-messages</Code>; if it
            sends OpenAI Chat, look for <Code>openai-chat-completions</Code>; etc.
            <Code>in</Code> / <Code>cachedIn</Code> / <Code>out</Code> are USD per
            1M tokens (fresh input / cached input / output) -{' '}
            <Code>cachedIn</Code> is what you pay when prompt prefixes are reused
            (system prompts, tool schemas, prior turns), typically 4–10× cheaper
            than <Code>in</Code> and often the dominant cost line for long agents.
            Names and ids in the example are fictional; your real output will list
            the operators currently online.
          </p>
          <p className={styles.hint}>
            Prefer the visual version? <Code>antseed network browse</Code> (no flags)
            prints a table with prices, sessions, on-chain volume, and a{' '}
            <Code>✓</Code> for vouched peers. Or open the same view in a browser:{' '}
            <a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer">live network page</a>.
          </p>
        </div>
      </li>

      <li className={styles.item}>
        <span className={styles.num}>3</span>
        <div className={styles.body}>
          <p className={styles.stepTitle}>
            Inspect one peer's full menu - every service, every price.
          </p>
          <CodeBlock
            code={`antseed network peer cccccccccccccccccccccccccccccccccccccccc --json \\
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
          <CodeBlock output label="Example response (Demo Provider, abbreviated - fictional)"
            code={`{
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
          <p className={styles.hint}>
            <strong>How to read it:</strong>
          </p>
          <ul className={styles.fields}>
            <li>
              <Code>service</Code> - the model id. This is what you put in your
              tool's <Code>model</Code> field.
            </li>
            <li>
              <Code>protocols</Code> - projected from{' '}
              <Code>providerServiceApiProtocols</Code>; the wire formats this
              service accepts <em>natively</em>. Match your tool's wire format
              against this list: if it's in there, the request passes through untouched; if not,{' '}
              <Code>@antseed/api-adapter</Code> translates on the fly. Note:{' '}
              <Code>openai-responses</Code>-only services require streaming.
            </li>
            <li>
              <Code>in</Code> / <Code>out</Code> - USD per <strong>1M tokens</strong>{' '}
              (fresh input / output). <Code>0 / 0</Code> = free.
            </li>
            <li>
              <Code>cachedIn</Code> - USD per 1M <em>cached</em> input tokens.
              When a request reuses prefix tokens (the system prompt, tool
              schemas, prior turns of a conversation, a long file you keep
              re-asking about, …) those tokens bill at this rate instead of{' '}
              <Code>in</Code>. Typically <strong>4–10× cheaper</strong> - e.g.{' '}
              <Code>minimax-m2.7</Code> charges $0.21/M for fresh input but only
              $0.04/M for cache hits. For long-running coding agents and
              chatbots, this is often the dominant cost line; use it when
              comparing peers.
            </li>
            <li>
              <Code>tags</Code> - capability hints. <Code>coding</Code>,{' '}
              <Code>vision</Code>, <Code>fast</Code>, <Code>free</Code>, etc.
            </li>
            <li>
              <Code>sessions</Code> / <Code>ghosts</Code> - on-chain reputation.
              Sessions = settled streams. Ghosts = streams that opened but never
              closed cleanly.
            </li>
          </ul>
          <p className={styles.hint}>
            Free-text version with on-chain stats and pin command:{' '}
            <Code>antseed network peer &lt;peerId&gt;</Code> (without{' '}
            <Code>--json</Code>).
          </p>
        </div>
      </li>

      <li className={styles.item}>
        <span className={styles.num}>4</span>
        <div className={styles.body}>
          <p className={styles.stepTitle}>
            Verify your endpoint sees the models — and optionally pick a seller.
          </p>
          <p className={styles.hint}>
            <strong>No pin needed.</strong> A request that names only a model
            selects the highest-ranked eligible offer under your shared Price +
            Trust preferences and fails over to the next-ranked seller on
            retryable peer errors.{' '}
            <Code>/v1/models</Code> lists every model on the network,
            aggregated across sellers:
          </p>
          <CodeBlock
            code={`# Every model on the network (free, no seller is called)\n${LIST_MODELS_COMMAND}\n\n# Local buyer proxy: no key\ncurl -s http://localhost:8377/v1/models | jq '.data[].id'`}
          />
          <CodeBlock output label="Example response"
            code={`"deepseek-v4-flash"
"gpt-oss-120b"
"gemma-3-27b"
"glm-5.2"
"kimi-k2.6"
"minimax-m2.7"`}
          />
          <p className={styles.hint}>
            These are the values you can pass as <Code>model</Code> in your
            tool's config (close aliases like <Code>opus-5</Code> for{' '}
            <Code>claude-opus-5</Code> also resolve). A model no seller your routing
            policy allows serves returns <Code>502 model_not_found</Code>. A gateway
            key limited to certain models lists only those.
          </p>
          <p className={styles.hint}>
            Automatic routes keep soft conversation affinity when the tool sends
            stable session metadata: later turns prefer the seller and service that
            actually served the chat, but can fail over if that route becomes
            unavailable or ineligible. Explicit pins remain hard.
          </p>
          <p className={styles.hint}>
            To force a <em>specific</em> seller instead of auto-selection,
            pick one of three overrides — you can mix them:
          </p>
          <p className={styles.hint}>
            <strong>Option A - session pin (local buyer proxy only).</strong> One
            command, every future request goes to that peer. Persists in{' '}
            <Code>~/.antseed/buyer.state.json</Code> across restarts. On a gateway, use
            a routing policy or preset instead.
          </p>
          <CodeBlock
            code={`# Pin the peer you chose for every request from now on (survives restart).\n# Replace the id below with one from your real \`antseed network browse\` output.\nantseed buyer connection set --peer cccccccccccccccccccccccccccccccccccccccc`}
          />
          <p className={styles.hint}>
            <strong>Option B - per-request header.</strong> Send{' '}
            <Code>x-antseed-pin-peer: &lt;peerId&gt;</Code> on each call. Overrides
            any session pin for that one request. Best for scripts, schedulers, and
            multi-tenant deployments that fan out to different peers per call.
          </p>
          <CodeBlock
            code={`curl "$ANTSEED_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $ANTSEED_API_KEY" \\
  -H 'content-type: application/json' \\
  -H 'x-antseed-pin-peer: cccccccccccccccccccccccccccccccccccccccc' \\
  -d '{
    "model": "minimax-m2.7",
    "messages": [{"role": "user", "content": "hi"}]
  }'`}
          />
          <p className={styles.hint}>
            <strong>Option C - model prefix (works in any tool).</strong> Set the{' '}
            <Code>model</Code> field to <Code>&lt;peerId&gt;@&lt;service-id&gt;</Code>.
            Antseed pins that peer for the request and strips the prefix before
            routing, so the seller just sees the service id. This is the way to pick
            a peer from tools where you can only type a model name.
          </p>
          <CodeBlock
            code={`curl "$ANTSEED_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $ANTSEED_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "cccccccccccccccccccccccccccccccccccccccc@minimax-m2.7",
    "messages": [{"role": "user", "content": "hi"}]
  }'`}
          />
        </div>
      </li>

      <li className={styles.item}>
        <span className={styles.num}>5</span>
        <div className={styles.body}>
          <p className={styles.stepTitle}>
            <span className={styles.optional}>Optional</span>
            Add funds - only needed for paid services:
          </p>
          <p className={styles.hint}>
            <strong>Gateway:</strong> open <strong>Wallet &amp; Funding</strong> in
            the console and add funds by card or with USDC on Base. Each workspace
            pays from its own wallet. See <Link to="/docs/gateway/funding/">Funding</Link>.
          </p>
          <p className={styles.hint}>
            <strong>Local buyer proxy:</strong>
          </p>
          <CodeBlock code={`antseed buyer deposit`} />
          <p className={styles.hint}>
            Prints your buyer&apos;s funding address and a QR code (an EIP-681
            payment request). Send USDC to it from any wallet or exchange —
            incoming funds are swept into the Deposits contract and credited to
            your buyer automatically: a permissionless relayer submits the
            transaction for a fixed ~$0.05 USDC fee, so the buyer never needs
            ETH. Verify with <Code>antseed buyer balance</Code>.
          </p>
          <p className={styles.hint}>
            <strong>Send USDC on the Base network only</strong> - other tokens or
            networks are not recoverable by the sweep.
          </p>
        </div>
      </li>
    </ol>
  );
}
