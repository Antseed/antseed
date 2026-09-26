import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {PrivacyHeroArt} from '../components/PrivacyHeroArt';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {PrivacyPanel} from '../components/PrivacyPanel';

const TITLE = 'Private AI: no account, no email, no one in the middle | Antseed';
const DESCRIPTION =
  'Use AI without giving up who you are. No account, no email, requests route peer-to-peer, and a TEE-verified provider keeps even your prompt sealed.';

function DownloadButton({size = 'lg', variant}: {size?: 'md' | 'lg'; variant?: 'dark' | 'white'}) {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <Button href={download.href} size={size} variant={variant} className="vprBtn" onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download the AI VPN</span>
      <span className="vprLabelMobile">Get the AI VPN<ArrowRight /></span>
    </Button>
  );
}

function PrivacyHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            So private, we have no idea who you are.
          </h1>
          <p className={styles.heroSub}>
            No account. No email. Your identity stays private and with a TEE-verified provider, so
            does your prompt.
          </p>
          <div className={styles.heroCtas}>
            <DownloadButton />
            <Button to="/docs/install" size="lg" variant="ghost" arrow>Install the CLI</Button>
          </div>
          <p className={styles.heroNote}>Free models to start. Install, point your tool at it, done.</p>
        </div>
        <div className={styles.heroDemo}>
          <PrivacyHeroArt />
        </div>
      </div>
    </header>
  );
}

/* What a provider sees — the page's real differentiator, pulled from the
   privacy answers in docs/faq.mdx. */
const SEES_ROWS: {label: string; standard: string; tee: string; antseed: string}[] = [
  {
    label: 'Who you are',
    standard: 'A peer id and a wallet. No name, no email, no account.',
    tee: 'A peer id and a wallet. No name, no email, no account.',
    antseed: 'Nothing. There is no account and no central log.',
  },
  {
    label: 'Your prompt',
    standard: 'Can read the prompt it serves.',
    tee: 'Cannot. The hardware seals it, and you get an attestation to prove it.',
    antseed: 'Never. Requests go straight from your device to the provider.',
  },
  {
    label: 'Your payment',
    standard: 'A USDC settlement from a wallet, visible on Base like any onchain transaction.',
    tee: 'A USDC settlement from a wallet, visible on Base like any onchain transaction.',
    antseed: 'A settlement on a public chain, tied to a wallet, not to your name.',
  },
];

function WhatAProviderSees() {
  return (
    <Section tone="tinted" id="who-sees-what">
      <Reveal>
        <SectionHeader
          title="What a provider sees."
          lead="Who you are and what you asked are handled separately. Pick the provider that fits how sensitive the work is."
        />
      </Reveal>
      <Reveal className={styles.seesWrap} delay={80}>
        <table className={styles.seesTable}>
          <thead>
            <tr>
              <th scope="col" aria-label="What"></th>
              <th scope="col">Standard provider</th>
              <th scope="col">TEE-verified provider</th>
              <th scope="col">Antseed</th>
            </tr>
          </thead>
          <tbody>
            {SEES_ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td data-col="Standard provider">{r.standard}</td>
                <td data-col="TEE-verified provider" className={styles.seesGood}>{r.tee}</td>
                <td data-col="Antseed" className={styles.seesGood}>{r.antseed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Reveal>
      <Reveal delay={140}>
        <p className={styles.seesNote}>
          Your device checks a provider&apos;s TEE against Intel&apos;s own certificate chain before
          any payment, with no third party in between.{' '}
          <Link to="/docs/guides/verify-tee" className={styles.setupLink}>
            Read the TEE guide
            <ArrowRight size={16} />
          </Link>
        </p>
      </Reveal>
    </Section>
  );
}

const PRIVACY_POINTS = [
  {icon: 'pt-shield', text: 'Anonymous by default: no account, no email, no platform key.'},
  {icon: 'pt-route', text: 'Route by privacy: set a minimum trust score, prefer TEE-verified providers.'},
  {icon: 'pt-tools', text: "Verify a provider's TEE on your own machine. No special hardware needed."},
  {icon: 'pt-wallet', text: 'Pay per request in USDC. No subscription tied to your name.'},
];

/* Commands from the Verify a Provider's TEE guide */
const PRIVACY_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Verification on, best-effort (the default)',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'buyer', cls: 'tBlue'},
      {text: ' '},
      {text: 'start', cls: 'tBlue'},
    ],
  },
  {
    comment: '# Strict: refuse to route unless the provider passes',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'buyer', cls: 'tBlue'},
      {text: ' '},
      {text: 'start', cls: 'tBlue'},
      {text: ' '},
      {text: '--verifiers', cls: 'tYellow'},
      {text: ' '},
      {text: 'antseed-verifier', cls: 'tOrange'},
      {text: ' '},
      {text: '--require-verifier', cls: 'tYellow'},
    ],
  },
  {
    comment: '# Find providers that advertise a TEE verifier',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'network', cls: 'tBlue'},
      {text: ' '},
      {text: 'browse', cls: 'tBlue'},
    ],
  },
  {
    comment: "# Inspect a provider's verifier before you trust it",
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'network', cls: 'tBlue'},
      {text: ' '},
      {text: 'peer', cls: 'tBlue'},
      {text: ' '},
      {text: '<peer-id>', cls: 'tOrange'},
    ],
  },
];

function StaysOnYourMachine() {
  return (
    <LocalhostSection
      title={<>Everything stays<br />on your machine.</>}
      lead={
        <>
          The AI VPN runs on your computer. Your settings, your signing key, and every routing
          decision stay on your device. Each request goes peer-to-peer over an encrypted
          connection to the provider you picked.
        </>
      }
      points={PRIVACY_POINTS}
      blocks={PRIVACY_TERMINAL_BLOCKS}
      ctaLabel="Read the TEE guide"
      ctaTo="/docs/guides/verify-tee"
    />
  );
}

/* FAQ — the four questions only a privacy-minded visitor asks. The rest,
   including what a passing TEE check proves, lives in /docs/faq. */
const PRIVACY_FAQ = [
  {
    q: 'Can providers see my prompts?',
    a: 'Standard providers can. TEE-verified providers cannot, because the hardware prevents it even if the operator wanted to look. When you pay for a TEE-verified request you receive a cryptographic attestation proving the enclave was genuine. <a href="/docs/guides/verify-tee">How verification works →</a>',
  },
  {
    q: 'What does a provider learn about me?',
    a: 'A pseudonymous peer or wallet identity, and the request it serves. Not your name, your email, or your account on the tool you connected. Antseed does not tell the provider who you are; who you are and what you asked are handled separately.',
  },
  {
    q: 'Does Antseed log my requests?',
    a: 'The protocol creates no central request log. Independent providers, nodes, RPC providers, analytics tools, or other infrastructure may still log or observe data, and each provider has its own data handling practices. Prefer TEE-verified providers where stronger confidentiality matters.',
  },
  {
    q: 'Is paying anonymous too?',
    a: 'There is no account to pay from. You can top up by card or Apple Pay in the AI VPN, or with USDC from the CLI. Settlement happens in USDC on Base, so payments are tied to a wallet, not to your name, and like any public chain that activity is visible onchain. <a href="/docs/faq">More questions in the FAQ →</a>',
  },
];

function PrivacyFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={PRIVACY_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function PrivacyPage(): JSX.Element {
  return (
    <Layout title="For privacy" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/privacy/" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: PRIVACY_FAQ.map(({q, a}) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]+>/g, '')},
            })),
          })}
        </script>
      </Head>
      <PrivacyHero />
      <PrivacyPanel title="Privacy by design" />
      <WhatAProviderSees />
      <StaysOnYourMachine />
      <PrivacyFaq />
      <FinalCta title="Privacy on your terms.">
        <DownloadButton variant="white" />
      </FinalCta>
    </Layout>
  );
}
