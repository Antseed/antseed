import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {Faq, Reveal} from '../components/ui';
import {LaunchHero} from '../components/home/LaunchHero';
import {ProductsShowcase} from '../components/home/ProductsShowcase';
import {WhatYouGet} from '../components/home/WhatYouGet';
import {NetworkSection} from '../components/home/NetworkSection';
import {SellSection} from '../components/SellSection';
import {HOME_FAQ} from '../components/homeFaq';
import {faqJsonLd} from '../lib/faqJsonLd';

/* ============================================================
   FAQ — fair questions. The gateway question leads on the homepage
   only; HOME_FAQ itself is shared with /network.
   ============================================================ */
const FAQ_ITEMS = [
  {
    q: 'What is the difference between the gateway and the AI VPN?',
    a: 'Use the gateway to manage shared access: run your own endpoint on a server and give each agent, app, or teammate their own API key, with budgets and the models and providers you choose. Use the AI VPN to connect the tools on your computer, without deploying a server. Both reach the same market. <a href="/docs/gateway/">Read the gateway docs →</a>',
  },
  ...HOME_FAQ,
];

function FAQSection() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={`${styles.faqTitle} ${styles.faqTitleStrong}`}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={FAQ_ITEMS} />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   PAGE
   ============================================================ */
const FAQ_LD = faqJsonLd(FAQ_ITEMS);

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
  'Give your agents, apps, and team access to 700+ AI models at lower prices, with built-in privacy and full control.';

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

      <LaunchHero />
      <ProductsShowcase />
      <WhatYouGet />
      <SellSection />
      <NetworkSection />
      <FAQSection />
    </Layout>
  );
}
