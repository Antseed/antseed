import {useEffect, useRef, useState, type ReactNode, type JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {PickModelArt} from '../components/StepArt';
import {PricingBlock} from '../components/PricingBlock';
import {StepsBlock} from '../components/StepsBlock';
import {WhoItsFor} from '../components/WhoItsFor';
import {PrivacyPanel} from '../components/PrivacyPanel';
import {Faq, Reveal, SectionHeader, ArrowRight} from '../components/ui';
import {HeroDemo} from '../components/HeroDemo';
import {HeroDotCanvas, HeroStatsRow, HeroUseCta, HeroUseSwitch, HeroCliVisual, type HeroUse} from '../components/HomeHero';
import {HeroAgentMarket} from '../components/HeroAgentMarket';
import {LogoMarquee} from '../components/LogoMarquee';
import {OwnedByNoOne} from '../components/NetworkPanel';
import {SellSection} from '../components/SellSection';
import {HOME_FAQ} from '../components/homeFaq';
import {FinalCtaBand} from '../components/FinalCtaBand';
import {faqJsonLd} from '../lib/faqJsonLd';

/* Split hero: copy on the left and the AI VPN demo (compact scene) on the
   right on wide viewports, collapsing to stacked under 997px. */
function Hero() {
  const [use, setUse] = useState<HeroUse>('app');
  const [visualHeight, setVisualHeight] = useState(0);
  const demoRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const shutdownRef = useRef(0);

  useEffect(() => {
    const host = demoRef.current;
    if (!host) return;
    // Reserve the tallest view, including the agent's command drawer, for all
    // three tabs. Changing tabs must never move the headline or stats.
    const panels = Array.from(host.querySelectorAll<HTMLElement>('[data-view] > div'));
    const update = () => setVisualHeight(Math.ceil(Math.max(
      host.clientWidth * 800 / 660,
      ...panels.map(panel => {
        const drawer = panel.querySelector<HTMLElement>('[data-agent-install]');
        return Math.max(panel.scrollHeight, drawer ? drawer.offsetTop + drawer.offsetHeight : 0) + 8;
      }),
    )));
    const observer = new ResizeObserver(update);
    panels.forEach(panel => observer.observe(panel));
    observer.observe(host);
    update();
    return () => observer.disconnect();
  }, []);

  const visuals: {view: HeroUse; content: ReactNode}[] = [
    {view: 'app', content: <HeroDemo frameRef={frameRef} shutdownRef={shutdownRef} compact />},
    {view: 'cli', content: <HeroCliVisual active={use === 'cli'} />},
    {view: 'agent', content: <HeroAgentMarket active={use === 'agent'} />},
  ];

  return (
    <header className={`${styles.hero} ${styles.heroSplit}`}>
      <HeroDotCanvas frameRef={frameRef} shutdownRef={shutdownRef} originRef={demoRef} compact />
      <div className={`${styles.heroInner} ${styles.heroSplitInner}`}>
        <div className={styles.heroCopy}>
          <HeroUseSwitch use={use} setUse={setUse} />
          <h1 className={styles.heroTitle}>
            Run your agents
            <br className={styles.heroTitleBreak} />
            {' '}on your terms
          </h1>
          <p className={styles.heroSubStatic}>
            Save on every AI model. No usage limits, no middleman, always&nbsp;anonymous.
          </p>
          <HeroUseCta use={use} setUse={setUse} showSwitch={false} />
        </div>
        <div className={`${styles.demoFrame} ${styles.demoFrameSplit} ${styles.heroVisualStack}`} ref={demoRef}
          style={{minHeight: visualHeight || undefined}} id="hero-use-visual" role="tabpanel" aria-labelledby={`hero-tab-${use}`}>
          {visuals.map(({view, content}) => {
            const active = use === view;
            return (
              <div key={view} className={`${styles.heroVisualLayer} ${active ? styles.heroVisualActive : ''}`} data-view={view} inert={!active} aria-hidden={!active}>
                {content}
              </div>
            );
          })}
        </div>
        <HeroStatsRow />
      </div>
    </header>
  );
}

/* ============================================================
   PRICING — the same models, a fraction of the price
   ============================================================ */
function PricingSection() {
  return (
    <PricingBlock
      title="The top AI models,"
      accent="at a fraction of the cost."
      lead="It's an open market, so competition between providers pushes prices down."
    />
  );
}

/* ============================================================
   PRIVATE BY DESIGN — the Anonymous / Private cards, shared with /privacy.
   ============================================================ */
function PrivateByDesign() {
  return <PrivacyPanel title="Private by design." />;
}

/* ============================================================
   PILLARS — the five things Antseed is, one line each. Replaces the
   localhost terminal on the homepage; the audience pages carry the
   long versions.
   ============================================================ */
const PILLARS: {title: string; body: ReactNode}[] = [
  {
    title: 'Every model, lower prices',
    body: 'Free and frontier models, routed to the cheapest verified provider.',
  },
  {
    title: 'Nothing changes in your tools',
    body: (
      <>
        One local endpoint, OpenAI and Anthropic compatible.{' '}
        <Link to="/docs/guides/using-the-api">Read the API guide<ArrowRight size={14} /></Link>
      </>
    ),
  },
  {
    title: 'No account',
    body: 'Nobody knows who you are. A TEE provider cannot even read your prompt.',
  },
  {
    title: 'No usage limits',
    body: 'Pay per request. Never a cap, never a window.',
  },
  {
    title: 'Owned by no one',
    body: 'Peer to peer, open source, settled in USDC on Base.',
  },
];

function PillarsSection() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader title="What you get." />
        </Reveal>
        <div className={styles.pillars}>
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} className={styles.pillar} delay={i * 60}>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   3 STEPS
   ============================================================ */
const STEPS = [
  {
    num: '1',
    title: 'Download the AI VPN',
    body: 'Run it on Mac, Windows, or Linux. No account needed. Prefer a terminal? Install the CLI instead.',
    illo: <img src="/img/home/illo-easy-setup.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '2',
    title: 'Connect your favorite app',
    body: 'Point Claude Code, Codex, Hermes, OpenClaw or any tool you already use at one local address.',
    illo: <img src="/img/home/illo-tools-unchanged.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '3',
    title: 'Pick your model',
    body: 'Choose free or frontier models, from more than 700 models. Route to the cheapest verified provider or pin the one you want.',
    illo: <PickModelArt />,
  },
];

function StepsSection() {
  return (
    <StepsBlock
      title="Think of it as a VPN for AI."
      lead={
        <>
          You install it, point your tools at it, and from then on you&apos;ve got full access to the
          open market.
        </>
      }
      steps={STEPS}
    />
  );
}

/* ============================================================
   FAQ — fair questions
   ============================================================ */
function FAQSection() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.faqTitle}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={HOME_FAQ} />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   PAGE
   ============================================================ */
const FAQ_LD = faqJsonLd(HOME_FAQ);

// Standalone Organization entity. The SoftwareApplication block in
// docusaurus.config.ts references the org as `creator`; this declares it in
// its own right so the brand resolves as an entity.
const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Antseed',
  url: 'https://antseed.com/',
  logo: 'https://antseed.com/logo.svg',
  description:
    'Antseed is a decentralized peer-to-peer marketplace for AI inference. Providers compete on price to run any AI model, with no central account.',
  sameAs: [
    'https://github.com/AntSeed/antseed',
    'https://x.com/antseed',
    'https://t.me/antseed',
  ],
};

const HOME_TITLE = 'Antseed | The Open Market for AI Inference';
const HOME_DESCRIPTION =
  'Run your agents on your terms. Save on every AI model. No usage limits, no middleman, always anonymous.';

export default function Home(): JSX.Element {
  return (
    <Layout title={HOME_TITLE} description={HOME_DESCRIPTION} wrapperClassName="homepage-wrapper">
      <Head>
        <title>{HOME_TITLE}</title>
        {/*
          Docusaurus derives og:title / og:description from the Layout title and
          description props above, which override the sitewide values in
          themeConfig.metadata. Declaring them here — after Layout's own tags —
          is what makes the share card copy actually take effect. X falls back
          to these when twitter:title / twitter:description are absent, which is
          why those are not declared anywhere.

          rel=canonical and og:url need no declaration — Docusaurus already
          emits correct per-page values for both.
        */}
        <meta property="og:title" content={HOME_TITLE} />
        <meta property="og:description" content={HOME_DESCRIPTION} />
        <script type="application/ld+json">{JSON.stringify(ORG_LD)}</script>
        <script type="application/ld+json">{JSON.stringify(FAQ_LD)}</script>
      </Head>

      <Hero />
      <LogoMarquee />
      <PricingSection />
      <StepsSection />
      <PillarsSection />
      <WhoItsFor />
      <OwnedByNoOne />
      <PrivateByDesign />
      <div className={styles.stepsSellWrap}>
        <SellSection />
      </div>
      <FAQSection />
      <FinalCtaBand />
    </Layout>
  );
}
