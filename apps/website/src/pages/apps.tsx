import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import own from './apps.module.css';
import product from '../components/home/ProductsShowcase.module.css';
import {GatewayConsoleDemo} from '../components/home/GatewayConsoleDemo';
import {GatewayFeatures} from '../components/GatewayFeatures';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {faqJsonLd} from '../lib/faqJsonLd';
import {PricingBlock} from '../components/PricingBlock';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';

const TITLE = 'AI Gateway for Apps — Lower API Costs | Antseed';
const PAGE_URL = 'https://antseed.com/apps/';
const DESCRIPTION =
  'Lower AI API costs with Antseed Gateway. Access 700+ models, choose providers, manage API keys and budgets, and set routing rules from one console.';

function AppsHero() {
  return (
    <header className={`${styles.hero} ${own.hero}`}>
      <div className={own.heroInner}>
        <div className={`${styles.heroCopy} ${own.heroCopy}`}>
          <h1 className={`${styles.heroTitle} ${own.heroTitle}`}>
            Lower AI costs for your app
          </h1>
          <p className={styles.heroSub}>
            Access 700+ AI models, with prices below the official APIs. Choose providers, set budgets,
            and track usage from one console.
          </p>
          <div className={`${styles.heroCtas} ${own.heroCtas}`}>
            <Button to="/docs/quickstart" size="lg" arrow>Set up AI gateway</Button>
            <Button to="/docs/gateway" size="lg" variant="ghost">Read the docs</Button>
          </div>
          <p className={styles.heroNote}>No signup required</p>
        </div>
        <div className={own.heroScreen}>
          <div className={product.browser}>
            <div className={product.browserBar} aria-hidden="true">
              <span className={product.browserDots}><i /><i /><i /></span>
              <span className={product.browserUrl}>llm.example.com/console</span>
            </div>
            <GatewayConsoleDemo />
          </div>
        </div>
      </div>
    </header>
  );
}

function AppsPricing() {
  return (
    <PricingBlock
      title="Your favorite models"
      accent="at lower prices"
      lead="Choose from free models to the latest frontier models. Pay for what you use, with no subscription."
      dropTrail={false}
      deferPrices
    />
  );
}

const APP_POINTS = [
  {icon: 'pt-tools', text: 'Compatible with OpenAI and Anthropic APIs.'},
  {icon: 'pt-route', text: 'Choose models and providers through one endpoint.'},
  {icon: 'pt-wallet', text: 'Give each app its own key and budget.'},
];

/* A minimal OpenAI SDK connection; model IDs come from the gateway catalog. */
const APP_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Python with the openai package installed',
    tokens: [{text: 'import os\nfrom openai import OpenAI', cls: 'tPurple'}],
  },
  {
    comment: '# Use your gateway URL; set ANTSEED_API_KEY to its key',
    tokens: [
      {text: 'client = OpenAI(\n', cls: 'tWhite'},
      {text: '    base_url="https://gateway.example.com/v1",\n', cls: 'tGreen'},
      {text: '    api_key=os.environ["ANTSEED_API_KEY"],\n', cls: 'tGreen'},
      {text: ')', cls: 'tWhite'},
    ],
  },
  {
    comment: '# Replace this model ID with one from your gateway',
    tokens: [
      {text: 'reply = client.chat.completions.create(\n', cls: 'tWhite'},
      {text: '    model="deepseek-v4-flash",\n', cls: 'tGreen'},
      {text: '    messages=[{"role": "user", "content": "Hello"}],\n', cls: 'tWhite'},
      {text: ')\nprint(reply.choices[0].message.content)', cls: 'tWhite'},
    ],
  },
];

function PointAtGateway() {
  return (
    <LocalhostSection
      title={<>Works with your<br />existing app</>}
      lead={
        <>
          Connect your app to Antseed by updating its API address, key, and model.
        </>
      }
      points={APP_POINTS}
      blocks={APP_TERMINAL_BLOCKS}
      ctaLabel="Read the API guide"
      ctaTo="/docs/gateway/api"
      status="Python example · gateway API"
      animateTerminal={false}
    />
  );
}

function GatewaySetup() {
  return (
    <Section id="run" compact>
      <Reveal>
        <SectionHeader title="Set up your gateway" lead="Start on your computer or deploy on a server." />
      </Reveal>
      <div className={own.setupGrid}>
        <Reveal className={own.setupOption}>
          <h3>On your computer</h3>
          <p>Try the gateway locally while you build.</p>
          <Link to="/docs/quickstart#on-your-computer" className={styles.setupLink}>
            Start locally <ArrowRight size={16} />
          </Link>
        </Reveal>
        <Reveal className={own.setupOption} delay={60}>
          <h3>On a server</h3>
          <p>Run your production gateway with HTTPS.</p>
          <Link to="/docs/gateway/server" className={styles.setupLink}>
            Set up a server <ArrowRight size={16} />
          </Link>
        </Reveal>
      </div>
    </Section>
  );
}

/* The remaining questions cover integration, fallback, and payment. */
const APPS_FAQ = [
  {
    q: 'Do I have to change my code?',
    a: 'If your app uses the OpenAI or Anthropic API, start by updating the API address, key, and model. The gateway supports Chat Completions, Responses, and Messages. Features such as tool calling depend on the model and provider, so test the features your app uses before switching production traffic. <a href="/docs/gateway/api#sdks">See code examples →</a>',
  },
  {
    q: 'What happens if a provider fails?',
    a: 'With automatic routing, retryable provider failures can move to another eligible provider. Fallback does not happen after streaming starts or when you pin a specific provider. If no eligible provider can serve, your app receives an error. <a href="/docs/api/routing">How fallback works →</a>',
  },
  {
    q: 'Do I need crypto to pay?',
    a: 'No. Top up by card from the console, or use USDC if you prefer. Provider payments settle in USDC on Base. <a href="/docs/gateway/funding">How funding works →</a>',
  },
];

const APPS_FAQ_LD = faqJsonLd(APPS_FAQ);
const APPS_PAGE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  '@id': `${PAGE_URL}#webpage`,
  url: PAGE_URL,
  name: TITLE,
  description: DESCRIPTION,
  inLanguage: 'en',
  isPartOf: {'@type': 'WebSite', name: 'Antseed', url: 'https://antseed.com/'},
  about: {
    '@type': 'SoftwareApplication',
    '@id': `${PAGE_URL}#gateway`,
    name: 'Antseed Gateway',
    url: 'https://antseed.com/docs/gateway/',
    applicationCategory: 'DeveloperApplication',
    featureList: [
      'Access AI models and choose providers',
      'Manage API keys, budgets, and usage',
      'Select TEE providers and require verification',
      'Configure routing rules and provider fallback',
      'Connect apps using OpenAI and Anthropic APIs',
    ],
  },
};

function AppsFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={APPS_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function AppsPage(): JSX.Element {
  return (
    <Layout title="AI Gateway for Apps — Lower API Costs" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <link rel="canonical" href={PAGE_URL} />
        <script type="application/ld+json">{JSON.stringify(APPS_PAGE_LD)}</script>
        <script type="application/ld+json">{JSON.stringify(APPS_FAQ_LD)}</script>
      </Head>
      <AppsHero />
      <AppsPricing />
      <PointAtGateway />
      <GatewayFeatures />
      <GatewaySetup />
      <AppsFaq />
      <FinalCta title="Run your app on your terms">
        <Button to="/docs/quickstart" size="lg" variant="white" arrow>Set up AI gateway</Button>
      </FinalCta>
    </Layout>
  );
}
