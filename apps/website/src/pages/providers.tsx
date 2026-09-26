import type {JSX} from 'react';
import Layout from '@theme/Layout';
import styles from './providers.module.css';
import {
  Button,
  Faq,
  FinalCta,
  LinkArrow,
  PageHero,
  Reveal,
  Section,
  SectionHeader,
  Terminal,
} from '../components/ui';
import {HugeiconsIcon} from '@hugeicons/react';
import {
  Tick02Icon,
  LockIcon as HugeLockIcon,
  ServerStack01Icon,
  ArtificialIntelligence01Icon,
  FlowConnectionIcon,
} from '@hugeicons/core-free-icons';

/* ── FAQ ─────────────────────────────────────────────────────── */
const FAQ_DATA = [
  {
    q: 'Does the network see my backend, model choice, or routing logic?',
    a: 'The network only sees what you announce: your service names, pricing, capability tags, and onchain reputation. Your backend URL, model provider, routing strategy, system prompt, and fine-tune weights stay under your control. You are responsible for securing your own node, credentials, logs, and infrastructure.',
  },
  {
    q: 'What provider types can I run?',
    a: 'Three: Raw Inference (serve a model or proxy an existing API), Routing Service (select providers on behalf of buyers and receive payment per routed request), or AI Agent (wrap domain expertise as a named always-on service). A single node can run all three at once, each at its own price.',
  },
  {
    q: 'Does my node need to run 24/7?',
    a: 'No. Providers announce uptime windows in their listing. When you go offline, the network routes around you. Your onchain reputation persists across sessions.',
  },
  {
    q: 'How do payments actually reach me?',
    a: 'The buyer reserves a USDC budget onchain before the first request, then signs a running total after each response. Your node settles that total on Base when the channel closes or after 10 minutes idle, and the USDC lands in your wallet automatically. No invoicing, no billing cycles. <a href="/docs/faq">More questions in the FAQ →</a>',
  },
];

/* ── Icons ───────────────────────────────────────────────────── */
function CheckIcon() {
  return <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.6} aria-hidden="true" />;
}

function LockIcon() {
  return <HugeiconsIcon icon={HugeLockIcon} size={16} strokeWidth={1.6} aria-hidden="true" />;
}

/* ── Page data ───────────────────────────────────────────────── */
const PATHS = [
  {
    title: 'Raw Inference',
    icon: <HugeiconsIcon icon={ServerStack01Icon} size={24} strokeWidth={1.6} aria-hidden="true" />,
    body: 'You run a model or proxy an upstream API - Ollama, a fine-tune, a local GPU, OpenAI, Together. Point Antseed at it with one config entry and announce it to the network. Buyers choose you based on price, latency, and onchain reputation; payments depend on demand and successful settlement.',
    points: ['Any model or backend', 'Set your own price per token', 'Reputation built per delivery'],
  },
  {
    title: 'AI Agent',
    icon: <HugeiconsIcon icon={ArtificialIntelligence01Icon} size={24} strokeWidth={1.6} aria-hidden="true" />,
    body: "You've built domain expertise in AI form. A legal agent, a security researcher, a trading analyst. Announce it as a named service. Buyers pay for your expertise, not just the tokens.",
    points: [
      'Persona, guardrails, and knowledge stay private',
      'Announced as a named service on the network',
      'Premium pricing for specialized delivery',
    ],
  },
  {
    title: 'Routing Service',
    icon: <HugeiconsIcon icon={FlowConnectionIcon} size={24} strokeWidth={1.6} aria-hidden="true" />,
    body: 'Build specialized routing logic and offer it on the network. Latency-optimized, cost-minimizing, TEE-only, or domain-aware. Receive payment for settled routed requests without running a single model.',
    points: [
      'No model infrastructure required',
      'Latency, cost, TEE, or domain-aware routing',
      'Payment per settled routed request',
    ],
  },
];

const PUBLIC_FACTS = [
  'Your service names',
  'Your price per token or per request',
  'Your capability tags (TEE, domain, model family…)',
  'Your onchain reputation score',
  'Your latency percentiles',
  'Your uptime window',
];

const PRIVATE_FACTS = [
  'Your backend URL or model provider',
  'Your routing logic and selection criteria',
  'Your system prompt and guardrails',
  'Your RAG sources and knowledge base',
  'Your prompt engineering',
  'Your fine-tune weights',
];

const PAY_STEPS = [
  {
    step: '1',
    title: 'The buyer reserves',
    body: 'Before the first request, the buyer signs a reservation that locks USDC in the deposits contract on Base. It caps what you can collect on that channel.',
  },
  {
    step: '2',
    title: 'You deliver, the buyer authorizes',
    body: 'After each response the buyer signs the running total you may collect, and your node signs a receipt with the exact usage. No onchain transaction per request.',
  },
  {
    step: '3',
    title: 'You settle on Base',
    body: 'Your node submits the latest authorization when the channel closes or after 10 minutes idle. The USDC lands in your wallet and the unused budget returns to the buyer.',
  },
];

const ECONOMICS = [
  {label: 'Your price', value: 'You set it - per input token + per output token'},
  {
    label: 'Protocol fee',
    value:
      '4% - may be directed to ecosystem mechanisms such as reserves, grants, incentives, buy-and-burn, or other community-approved uses',
  },
  {label: 'Your payout', value: '96% of what buyers pay, direct to your wallet in USDC'},
  {label: 'Payment methods', value: 'Buyers pay in USDC or by card - your payout is always USDC'},
  {label: 'Settlement chain', value: 'Base mainnet'},
];

const CLI_SNIPPET = `# Point at any OpenAI-compatible endpoint
antseed config seller add-provider together \\
  --plugin openai \\
  --base-url https://api.together.ai

# Announce a service with your price + categories
# (--cached is optional - set it to charge less for
# cached-input tokens when your upstream supports them)
antseed config seller add-service together deepseek-v3.1 \\
  --upstream "deepseek-ai/DeepSeek-V3.1" \\
  --input 0.6 --cached 0.06 --output 1.7 \\
  --categories chat,math,coding

# Start serving
export OPENAI_API_KEY=<your-key>
antseed seller start`;

const CONFIG_SNIPPET = `{
  "seller": {
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "pricing": {
              "inputUsdPerMillion": 0.6,
              "cachedInputUsdPerMillion": 0.06,
              "outputUsdPerMillion": 1.7
            },
            "categories": ["chat", "coding", "math"]
          }
        }
      }
    }
  }
}`;

const WALLET_SNIPPET = `antseed seller status         # earnings, peers, wallet address
antseed seller register       # register on-chain; all you need to sell
antseed seller stake <ants> --epochs <n>  # optional: stake ANTS for rewards`;

/* ── MAIN PAGE ───────────────────────────────────────────────── */
export default function Providers(): JSX.Element {
  return (
    <Layout
      title="Become a Provider"
      description="Build an Antseed provider for your AI capability. Providers are independent operators responsible for their own infrastructure, policies, compliance, and data handling."
    >
      <PageHero
        title={
          <>
            Serve AI on the open market.<br />
            <em>No permission needed.</em>
          </>
        }
        lead="Set your price. Announce to the network. Receive USDC for settled deliveries - whether you run a model, a routing service, or a specialized agent."
      >
        <Button to="/docs/guides/become-a-provider" arrow>Read the provider guide</Button>
        <Button to="/docs/install" variant="ghost">Install the CLI</Button>
      </PageHero>

      {/* ── THREE WAYS TO PROVIDE ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="Three ways to provide"
            lead="All three serve buyers on the open market. What runs behind is entirely yours."
          />
        </Reveal>
        <div className={styles.pathsGrid}>
          {PATHS.map((path, i) => (
            <Reveal key={path.title} className={styles.pathCard} delay={i * 100}>
              <div className={styles.pathIcon}>{path.icon}</div>
              <h3>{path.title}</h3>
              <p>{path.body}</p>
              <ul className={styles.pathList}>
                {path.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>

        <Reveal className={styles.compliance} delay={120}>
          <span className={styles.complianceIcon} aria-hidden="true">!</span>
          <div className={styles.complianceBody}>
            <p>
              Providers must add value on top of upstream APIs: TEE-secured inference, agents,
              fine-tunes, or managed products. Reselling raw API access or subscription
              credentials is <strong>not</strong> allowed.
            </p>
          </div>
        </Reveal>
      </Section>

      {/* ── WHAT THE NETWORK SEES ── */}
      <Section>
        <Reveal>
          <SectionHeader
            title="What the network sees. What stays private."
            lead="Buyers see enough to route and verify. Everything else stays on your machine."
          />
        </Reveal>
        <div className={styles.privacyGrid}>
          <Reveal className={`${styles.privacyCol} ${styles.privacyColPublic}`}>
            <p className={`${styles.privacyColLabel} ${styles.public}`}>Public to the network</p>
            {PUBLIC_FACTS.map((item) => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyIcon}><CheckIcon /></span>
                <span>{item}</span>
              </div>
            ))}
          </Reveal>
          <Reveal className={styles.privacyCol} delay={100}>
            <p className={`${styles.privacyColLabel} ${styles.private}`}>
              Under your control - secure your node
            </p>
            {PRIVATE_FACTS.map((item) => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyIcon}><LockIcon /></span>
                <span>{item}</span>
              </div>
            ))}
          </Reveal>
        </div>
      </Section>

      {/* ── CONFIG ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="One JSON file. Full control."
            lead="No code to write. Point Antseed at an OpenAI-compatible endpoint, set your prices and categories, and offer capacity to buyers."
          />
        </Reveal>
        <div className={styles.codeGrid}>
          <Reveal className={styles.codeCard}>
            <p className={styles.codeCardLabel}>1 · Configure with the CLI</p>
            <Terminal title="terminal">{CLI_SNIPPET}</Terminal>
            <p className={styles.codeNote}>
              Compatible with any OpenAI-API endpoint - your own Ollama, vLLM, a
              fine-tune, or an upstream you have the right to resell. You are
              responsible for complying with your upstream's terms of service.
            </p>
          </Reveal>
          <Reveal className={styles.codeCard} delay={100}>
            <p className={styles.codeCardLabel}>2 · Or edit config.json directly</p>
            <Terminal title="~/.antseed/config.json">{CONFIG_SNIPPET}</Terminal>
            <p className={styles.codeNote}>
              Your backend URL, API key, and routing logic are intended to remain under your control.
              The network only sees the service name, price, and categories; you are responsible for
              securing your node and credentials.{' '}
              <LinkArrow to="/docs/config">Read the config reference</LinkArrow>
            </p>
          </Reveal>
        </div>
      </Section>

      {/* ── SETTLEMENT ── */}
      <Section width="md">
        <Reveal>
          <SectionHeader
            title="Direct settlement. No invoicing."
            lead="The buyer reserves a budget. You deliver and the buyer authorizes. You settle on Base."
          />
        </Reveal>
        <Reveal className={styles.payFlow}>
          {PAY_STEPS.map((s) => (
            <div key={s.step} className={styles.payStep}>
              <span className={styles.payStepNum}>{s.step}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </Reveal>

        <Reveal className={styles.factTable} delay={80}>
          {ECONOMICS.map((row) => (
            <div key={row.label} className={styles.factRow}>
              <span className={styles.factLabel}>{row.label}</span>
              <span className={styles.factValue}>{row.value}</span>
            </div>
          ))}
        </Reveal>

        <Reveal className={styles.walletBlock} delay={120}>
          <Terminal title="wallet management">{WALLET_SNIPPET}</Terminal>
          <p className={styles.walletNote}>
            Your EVM wallet is derived automatically from your node's secp256k1 identity key.
            Payouts land in it on every settlement - no claim step, no separate wallet setup.{' '}
            <LinkArrow to="/docs/payments">Read the payment protocol</LinkArrow>
          </p>
        </Reveal>
      </Section>

      {/* ── REPUTATION ── */}
      <Section tone="tinted" width="md">
        <Reveal>
          <SectionHeader
            title="Build reputation that compounds."
            lead="Every delivery is recorded onchain. Your reputation belongs to your wallet. No platform can revoke it."
          />
        </Reveal>
        <Reveal delay={80}>
          <p className={styles.repNote}>
            Every settled delivery is recorded onchain against your wallet: success rate, latency,
            token accuracy from signed receipts, and uptime across the windows you announce. Buyers
            and routers read those stats when they rank you, so a strong track record brings more
            traffic and can command a higher price.{' '}
            <LinkArrow to="/docs/reputation">How trust is computed</LinkArrow>
          </p>
        </Reveal>
      </Section>

      {/* ── BEFORE YOU START ── */}
      <Section width="md">
        <Reveal className={styles.compliance}>
          <span className={styles.complianceIcon} aria-hidden="true">!</span>
          <div className={styles.complianceBody}>
            <p className={styles.complianceTitle}>Before you start</p>
            <p>
              Providers are independent operators and are solely responsible for their models,
              infrastructure, outputs, logs, privacy practices, data handling, security,
              sanctions/export compliance, tax obligations, applicable AI laws, and upstream API
              provider terms.
            </p>
            <p>
              Provider-side ANTS emissions are currently tracked but locked in a dedicated Provider
              Pool while Antseed develops stronger validation and proof systems. Fake usage, sybil
              behavior, or incentive extraction may be excluded or subject to future slashing.
            </p>
          </div>
        </Reveal>
      </Section>

      {/* ── FAQ ── */}
      <Section width="md">
        <Reveal>
          <SectionHeader title="Common questions" />
        </Reveal>
        <Reveal delay={80}>
          <Faq items={FAQ_DATA} />
        </Reveal>
      </Section>

      {/* ── CLOSING CTA ── */}
      <FinalCta
        title="Ready to provide?"
        sub="Install the CLI, configure your provider, and offer AI capacity as an independent operator."
        note={
          <>
            <a href="/docs/lightpaper">Read the lightpaper</a>
            <a href="/docs/payments">Read the payment protocol</a>
            <a href="/docs/faq">Read the FAQ</a>
          </>
        }>
        <Button to="/docs/guides/become-a-provider" variant="white" size="lg" arrow>Read the provider guide</Button>
      </FinalCta>
    </Layout>
  );
}
