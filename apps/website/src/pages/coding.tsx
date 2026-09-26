import type {JSX, ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import own from './coding.module.css';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {CodingHeroArt} from '../components/CodingHeroArt';
import {DownloadButton} from '../components/DownloadButton';
import {faqJsonLd} from '../lib/faqJsonLd';
import {PricingBlock} from '../components/PricingBlock';
import {LogoBar, SquareGlyph, PiGlyph, type LogoItem} from '../components/AgentsLogoBar';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {ConnectSwitchArt} from '../components/ConnectSwitchArt';
import {Cursor} from '@lobehub/icons';

const TITLE = 'Coding apps without usage limits, at a fraction of the price | Antseed';
const DESCRIPTION =
  'Claude Code, Codex, Cursor, OpenCode, Pi. Keep the tool you like, point it at Antseed, and pay a fraction of what the same work costs on a plan. No five-hour window, no weekly cap, no sign-up.';

/* Logo band — the coding apps with an integration page */
const CODING_APPS: LogoItem[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png'},
  {name: 'Codex', logo: '/logos/openai.png'},
  {name: 'Cursor', glyph: <Cursor size={22} />},
  {name: 'OpenCode', glyph: SquareGlyph},
  {name: 'Pi', glyph: PiGlyph},
];

/* Connect cards — one per coding app, linking to its setup guide */
type ConnectCard = {name: string; logo?: string; glyph?: ReactNode; to: string};

const CONNECT_CARDS: ConnectCard[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png', to: '/integrations/claude-code'},
  {name: 'Codex', logo: '/logos/openai.png', to: '/integrations/codex'},
  {name: 'Cursor', glyph: <Cursor size={24} />, to: '/docs/guides/public-tunnels#use-it-with-cursor'},
  {name: 'OpenCode', glyph: SquareGlyph, to: '/integrations/opencode'},
  {name: 'Pi', glyph: PiGlyph, to: '/integrations/pi'},
];

function CodingHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            Coding, without the usage limits.
          </h1>
          <p className={styles.heroSub}>
            Keep Claude Code, Codex, Cursor, or OpenCode. Point it at your local endpoint and pay a
            fraction of the plan price, with no hourly, weekly, or monthly limits.
          </p>
          <div className={styles.heroCtas}>
            <DownloadButton />
            <Button to="/docs/install" size="lg" variant="ghost" arrow>Install the CLI</Button>
          </div>
          <p className={styles.heroNote}>Free models to start. No account either way.</p>
        </div>
        <div className={styles.heroDemo}>
          <CodingHeroArt />
        </div>
      </div>
    </header>
  );
}

function CodingPricing() {
  return (
    <PricingBlock
      title="Frontier models,"
      accent="at a fraction of the plan price."
      lead="Pay per request at the lowest market price. No usage limits, no subscription."
    />
  );
}

function ConnectApps() {
  return (
    <Section tone="tinted" id="connect">
      <Reveal>
        <SectionHeader
          title="Works with the coding apps you already use."
          lead="One command launches the tool through Antseed. Your projects, chats, and settings stay the way they were."
        />
      </Reveal>
      <div className={own.connectSplit}>
        <Reveal className={own.appList} delay={40}>
          {CONNECT_CARDS.map((c) => (
            <Link key={c.name} to={c.to} className={own.appRow} aria-label={`${c.name} setup guide`}>
              <span className={own.appMark}>
                {c.logo ? <img src={c.logo} alt="" aria-hidden="true" /> : c.glyph}
              </span>
              <span className={own.appName}>{c.name}</span>
              <span className={own.appLink}>
                Setup guide
                <ArrowRight size={16} />
              </span>
            </Link>
          ))}
        </Reveal>
        <Reveal className={own.artCol} delay={100}>
          <ConnectSwitchArt layout="stack" />
        </Reveal>
      </div>
    </Section>
  );
}

const CODING_POINTS = [
  {icon: 'pt-tools', text: 'Keep your tool. Swap the model and provider underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

/* Commands from the integration guides: antseed claude / codex / opencode */
const CODING_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Run Claude Code through Antseed',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'claude', cls: 'tBlue'},
    ],
  },
  {
    comment: '# Codex, pinned to one model for this run',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'codex', cls: 'tBlue'},
      {text: ' '},
      {text: '--model', cls: 'tYellow'},
      {text: ' '},
      {text: 'deepseek-v4-flash', cls: 'tOrange'},
    ],
  },
  {
    comment: '# OpenCode on an open model',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'opencode', cls: 'tBlue'},
      {text: ' '},
      {text: '--model', cls: 'tYellow'},
      {text: ' '},
      {text: 'gpt-oss-120b', cls: 'tOrange'},
    ],
  },
];

function PointAtLocalhost() {
  return (
    <LocalhostSection
      title={<>Point your tools<br />at localhost.</>}
      lead={
        <>
          Your local endpoint at <code className={styles.inlineCode}>localhost:8377</code> speaks
          the OpenAI and Anthropic APIs. One command launches your tool through it.
        </>
      }
      points={CODING_POINTS}
      blocks={CODING_TERMINAL_BLOCKS}
      ctaLabel="Browse the integrations"
      ctaTo="/integrations"
    />
  );
}

/* FAQ — grounded in the integration guides, the docs FAQ, and the
   Claude Code pricing post. */
const CODING_FAQ = [
  {
    q: 'Do I have to cancel my Claude or ChatGPT plan?',
    a: 'No. Keep it if it earns its price. When the plan’s window runs out, launch the same tool through Antseed and keep working, then switch back whenever you like. Nothing about your projects or settings changes between the two.',
  },
  {
    q: 'Is it the same model I get on the plan?',
    a: 'The live board lists what providers serve, including frontier models, each at the provider’s own price. Every response is signed by the provider and matched against the model’s fingerprint; providers who serve something else lose reputation and stop getting routed. <a href="/docs/guides/verify-tee">How verification works →</a>',
  },
  {
    q: 'Does Cursor work?',
    a: "Yes, through a public endpoint. Some Cursor requests come from Cursor's own servers, which cannot reach your <code>localhost</code>, so publish an authenticated HTTPS endpoint from the AI VPN, then in Cursor's model settings paste the Antseed key as the OpenAI API key and the endpoint as the OpenAI base URL. <a href=\"/docs/guides/public-tunnels#use-it-with-cursor\">Cursor setup →</a>",
  },
  {
    q: 'How do I pick which model my tool uses?',
    a: 'Leave it on auto and every request goes to the cheapest verified provider for the model your tool asks for. To pin a model for one run, pass <code>--model &lt;id&gt;</code> to the wrapper, using an id from <code>curl http://localhost:8377/v1/models</code>. To pin a specific provider, use <code>&lt;peerId&gt;@&lt;model&gt;</code>. <a href="/docs/faq">More questions in the FAQ →</a>',
  },
];

const CODING_FAQ_LD = faqJsonLd(CODING_FAQ);

function CodingFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={CODING_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function CodingPage(): JSX.Element {
  return (
    <Layout title="For coding apps" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/coding/" />
        <script type="application/ld+json">{JSON.stringify(CODING_FAQ_LD)}</script>
      </Head>
      <CodingHero />
      <LogoBar items={CODING_APPS} ariaLabel="Coding apps that work with Antseed" />
      <CodingPricing />
      <ConnectApps />
      <PointAtLocalhost />
      <CodingFaq />
      <FinalCta title="Code on your terms.">
        <DownloadButton />
      </FinalCta>
    </Layout>
  );
}
