import type {JSX, ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {AgentsHeroArt} from '../components/AgentsHeroArt';
import {DownloadButton} from '../components/DownloadButton';
import {faqJsonLd} from '../lib/faqJsonLd';
import {PricingBlock} from '../components/PricingBlock';
import {AgentsLogoBar, SquareGlyph, PiGlyph} from '../components/AgentsLogoBar';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {PrivacyPanel} from '../components/PrivacyPanel';
import {SkillChip} from '../components/SkillChip';

const TITLE = 'Run AI agents for a fraction of the price | Antseed';
const DESCRIPTION =
  'Hermes, OpenClaw, Codex, OpenCode, your own. Your agent installs Antseed from one skill and every request goes to the cheapest verified provider. No usage caps, no sign-up.';

/* Works with the agents you run. One card per supported integration:
   logo, one line, link to its own setup guide. */
type ConnectCard = {name: string; logo?: string; glyph?: ReactNode; body: string; to: string};

const CONNECT_CARDS: ConnectCard[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png', body: "Point Anthropic's CLI at one local address. Same projects, same chats.", to: '/integrations/claude-code'},
  {name: 'Codex', logo: '/logos/openai.png', body: "Run OpenAI's Codex CLI through Antseed with a single command.", to: '/integrations/codex'},
  {name: 'Hermes', logo: '/logos/nousresearch.svg', body: 'Register Antseed as a custom provider in your Hermes config.', to: '/integrations/hermes'},
  {name: 'OpenClaw', logo: '/logos/openclaw.svg', body: "Add Antseed to OpenClaw's provider catalog and run any model.", to: '/integrations/openclaw'},
  {name: 'OpenCode', glyph: SquareGlyph, body: 'Launch OpenCode through Antseed and pick any model on the network.', to: '/integrations/opencode'},
  {name: 'Pi', glyph: PiGlyph, body: 'Use your local endpoint as a model provider in Pi.', to: '/integrations/pi'},
];

function AgentsHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            Run agents freely, for way less.
          </h1>
          <p className={styles.heroSub}>
            Hermes, OpenClaw, Codex, OpenCode, or your own. Your agent installs Antseed itself from
            one skill and runs on the open market.
          </p>
          <div className={styles.heroCtas}>
            <SkillChip />
            <Button to="/docs/install" size="lg" variant="ghost">Install the CLI</Button>
          </div>
          <p className={styles.heroNote}>Give your agent the skill. Free models to start, no account, no API key.</p>
        </div>
        <div className={styles.heroDemo}>
          <AgentsHeroArt />
        </div>
      </div>
    </header>
  );
}

function WishAndBill() {
  return (
    <PricingBlock
      title="Run your agents all day,"
      accent="for a fraction of the cost."
      lead="Agents make hundreds of context-heavy calls. Antseed routes each one to the cheapest verified provider in real time."
    />
  );
}

function ConnectAgents() {
  return (
    <Section tone="tinted" id="connect">
      <Reveal>
        <SectionHeader
          title="Works with the agents you run."
          lead="Nothing changes in how your agent works. It talks to your local endpoint instead of a hosted API."
        />
      </Reveal>
      <div className={styles.connectGrid}>
        {CONNECT_CARDS.map((c, i) => (
          <Reveal key={c.name} className={styles.connectCard} delay={i * 60}>
            <Link to={c.to} className={styles.connectCardLink} aria-label={`${c.name} setup guide`}>
              <span className={styles.connectLogo}>
                {c.logo ? <img src={c.logo} alt="" aria-hidden="true" /> : c.glyph}
              </span>
              <h3>{c.name}</h3>
              <p>{c.body}</p>
              <span className={styles.connectMore}>
                Setup guide
                <ArrowRight size={16} />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>
      <Reveal className={styles.connectAny} delay={120}>
        <span>Any OpenAI-compatible agent works too. Point it at <code>http://localhost:8377/v1</code>.</span>
        <Link to="/docs/guides/agents" className={styles.setupLink}>
          Read the agent guide
          <ArrowRight size={16} />
        </Link>
      </Reveal>
    </Section>
  );
}

const AGENT_POINTS = [
  {icon: 'pt-tools', text: 'Keep your agent. Swap the providers underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route every call by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

const AGENT_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Point any agent at your local endpoint',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'export', cls: 'tPurple'},
      {text: ' '},
      {text: 'OPENAI_BASE_URL', cls: 'tYellow'},
      {text: '='},
      {text: '"http://localhost:8377/v1"', cls: 'tGreen'},
      {text: '\n'},
      {text: '$ ', cls: 'tGreen'},
      {text: 'export', cls: 'tPurple'},
      {text: ' '},
      {text: 'OPENAI_API_KEY', cls: 'tYellow'},
      {text: '='},
      {text: '"antseed"', cls: 'tGreen'},
    ],
  },
  {
    comment: '# Point OpenClaw at Antseed',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'openclaw', cls: 'tPurple'},
      {text: ' '},
      {text: 'models', cls: 'tBlue'},
      {text: ' '},
      {text: 'set', cls: 'tBlue'},
      {text: ' '},
      {text: '"antseed/kimi-k2.6"', cls: 'tOrange'},
    ],
  },
  {
    comment: '# List the models you can route to',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'curl', cls: 'tPurple'},
      {text: ' '},
      {text: '"$OPENAI_BASE_URL/models"', cls: 'tBlue'},
    ],
  },
];

function PointAtLocalhost() {
  return (
    <LocalhostSection
      title={<>Point your agents<br />at localhost.</>}
      lead={
        <>
          Your local endpoint at <code className={styles.inlineCode}>localhost:8377</code> speaks
          the OpenAI and Anthropic APIs. The key is a placeholder; there is no account behind it.
        </>
      }
      points={AGENT_POINTS}
      blocks={AGENT_TERMINAL_BLOCKS}
      ctaLabel="Read the agent guide"
      ctaTo="/docs/guides/agents"
    />
  );
}

/* What the skill does — the four steps in skills/join-buyer/SKILL.md,
   which the chip installs (and /skill.md serves). */
const SKILL_STEPS = [
  {num: '1', title: 'Install', body: 'Installs the Antseed CLI on the machine the agent runs on.'},
  {num: '2', title: 'Start', body: 'Starts your local endpoint. No account, no API key.'},
  {num: '3', title: 'Fund', body: 'Shows you where to top up for paid models. Free models need nothing.'},
  {num: '4', title: 'Run', body: 'Points itself at the endpoint and picks a model. Every call goes to the best provider.'},
];

function WhatTheSkillDoes() {
  return (
    <Section id="skill">
      <Reveal>
        <SectionHeader
          title="What the skill does."
          lead="One file your agent reads. It handles the setup and tells you when it needs you."
        />
      </Reveal>
      <div className={styles.skillSteps}>
        {SKILL_STEPS.map((s, i) => (
          <Reveal key={s.num} className={styles.skillStep} delay={i * 80}>
            <span className={styles.skillStepNum}>{s.num}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </Reveal>
        ))}
      </div>
      <Reveal className={styles.stepsCtaRow} delay={200}>
        <SkillChip size="md" />
      </Reveal>
    </Section>
  );
}

/* FAQ — the three questions only an agent operator asks. The shared ones
   (usage limits, desktop vs CLI, what a provider sees) live in /docs/faq. */
const AGENT_FAQ = [
  {
    q: 'Does my agent need an account or API key?',
    a: 'No account, whether you run the AI VPN or the Antseed CLI. The local endpoint does not validate a key, but most agent SDKs want a non-empty value, so use a placeholder like <code>antseed</code>. Only a public endpoint you publish from the Agents view uses a real, generated key.',
  },
  {
    q: 'Which agents work with Antseed?',
    a: 'Anything that speaks the OpenAI or Anthropic API: Hermes, OpenClaw, Claude Code, Codex, OpenCode, Pi, or your own. Hermes and OpenClaw have maintained setup skills; Claude Code, Codex, and OpenCode also have CLI wrappers (<code>antseed claude</code>, <code>antseed codex</code>, <code>antseed opencode</code>). Any other agent uses its custom provider settings with the base URL and key above. <a href="/docs/guides/agents">Read the agent guide →</a>',
  },
  {
    q: 'My agent runs on a server. Can it still use Antseed?',
    a: "Yes. The simplest way is to install the CLI on that server and start the endpoint next to the agent, so it talks to <code>localhost:8377</code> as usual. If the agent must reach an endpoint on a different machine, publish an authenticated endpoint from the AI VPN's Agents view, using ngrok or Cloudflare, and swap in the URL and key it shows. <a href=\"/docs/guides/public-tunnels\">Public HTTPS tunnels guide →</a> <a href=\"/docs/faq\">More questions in the FAQ →</a>",
  },
];

const AGENT_FAQ_LD = faqJsonLd(AGENT_FAQ);

function AgentPrivacy() {
  return (
    <PrivacyPanel
      title="Your agent runs without a name."
      anonymous={{
        text: 'No signup, no email, no platform key. The agent pays per request from a wallet, so the provider never learns whose agent it is.',
        to: '/privacy',
      }}
      privateCard={{
        text: 'Require TEE verification when you start its endpoint and the agent only talks to verified providers. Its prompts and tool calls run in a secure enclave, hidden even from the provider.',
        to: '/docs/guides/verify-tee',
      }}
    />
  );
}

function AgentFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={AGENT_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function AgentsPage(): JSX.Element {
  return (
    <Layout title="For agents" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/agents/" />
        <link rel="alternate" type="text/markdown" href="/skill.md" title="Agent-readable setup skill" />
        <script type="application/ld+json">{JSON.stringify(AGENT_FAQ_LD)}</script>
      </Head>
      <AgentsHero />
      <AgentsLogoBar />
      <WishAndBill />
      <ConnectAgents />
      <PointAtLocalhost />
      <WhatTheSkillDoes />
      <AgentPrivacy />
      <AgentFaq />
      <FinalCta title="Run your agents on your terms." sub="Give your agent the skill, or download the AI VPN and connect it yourself.">
        <DownloadButton variant="white" />
        <SkillChip dark />
      </FinalCta>
    </Layout>
  );
}
