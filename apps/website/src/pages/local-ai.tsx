import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import shared from './agents.module.css';
import styles from './local-ai.module.css';
import {ArrowRight, Button, Faq, FinalCta, PageHero, Reveal, Section, SectionHeader} from '../components/ui';
import {faqJsonLd} from '../lib/faqJsonLd';

const TITLE = 'Earn From Local AI on Your Mac | Antseed';
const PAGE_URL = 'https://antseed.com/local-ai/';
const DESCRIPTION =
  'Serve Antseed buyers from a model running on your Mac or your own hardware, and earn USDC and ANTS for every answer. Prompts stay encrypted end to end.';

/* The two ways in; both lead to their docs. */
const PATHS = [
  {
    title: 'Join a pool with your Mac',
    body: 'Download the Antseed Mac app. It joins a colony pool, answers encrypted requests on a local model, and pays your share to your wallet. No open ports, no staking.',
    cta: 'Earn with your Mac',
    to: '/docs/local-ai/mac',
  },
  {
    title: 'Run your own seller',
    body: 'Put the Antseed CLI in front of Ollama, llama.cpp or another local server. You set the price, stake and settle as your own seller.',
    cta: 'Become a provider',
    to: '/docs/provide',
  },
  {
    title: 'Run a pool',
    body: 'Deploy the pool contract and run the seller Macs connect to. You choose the models, rank the workers, and take an operator fee.',
    cta: 'Run a pool',
    to: '/docs/local-ai/run-a-pool',
  },
];

/* How a colony pool request travels and gets paid, in four steps. */
const STEPS = [
  {n: '1', title: 'A buyer encrypts', body: 'The buyer encrypts its request for the worker it was assigned. The pool only sees ciphertext.'},
  {n: '2', title: 'Your Mac answers', body: 'The app checks the buyer’s channel on-chain, runs the model, and seals the answer for the buyer.'},
  {n: '3', title: 'The buyer signs', body: 'Every payment the buyer signs names what it has paid your Mac. Your Mac stops serving a buyer who falls behind.'},
  {n: '4', title: 'You claim', body: 'The pool contract splits each settlement between its workers. Claim your USDC and ANTS to your own wallet.'},
];

const MAC_APP_DOWNLOAD = 'https://github.com/Antseed/antseed/releases/download/mac-worker-v0.2.0/Antseed-Worker-0.2.0.dmg';

const INSTALL = [
  {title: 'Install', body: 'Open the DMG and drag Antseed Worker to Applications. It runs in the menu bar.'},
  {title: 'Join a pool', body: 'Paste the pool’s wss:// address and choose Join. The app downloads its model and starts serving.'},
  {title: 'Link your wallet', body: 'Enter your wallet, copy the link code, and paste it under Rewards → Link a Mac.'},
];

const PRIVACY = [
  {title: 'End-to-end encrypted', body: 'The pool routes ciphertext. Only the Mac the buyer chose can read a request.'},
  {title: 'Keys in the Secure Enclave', body: 'The app’s decryption keys never leave the Mac’s Secure Enclave and are bound to the signed app.'},
  {title: 'Apple-verified Macs', body: 'Pools that run an MDM can show buyers Apple’s own attestation that a Mac has System Integrity Protection on.'},
];

const FAQ = [
  {
    q: 'What do I need?',
    a: 'A Mac with Apple silicon on macOS 14 or later, the address of a pool to join, and a wallet on Base for your earnings. <a href="/docs/local-ai/mac">Requirements →</a>',
  },
  {
    q: 'How much do I earn?',
    a: 'Your share of what buyers pay for the answers your Mac gives, after the 2% protocol fee and the pool’s operator fee (10% by default, at most 20%), plus a share of the pool’s ANTS emissions. The app shows today’s estimate. <a href="/docs/local-ai#how-a-worker-gets-paid">How workers are paid →</a>',
  },
  {
    q: 'Can the pool operator read prompts or keep my earnings?',
    a: 'The operator routes only ciphertext, and the pool contract pays workers from what the buyer signed for them. The operator still decides which Mac gets work. <a href="/docs/local-ai/privacy">Privacy and verification →</a>',
  },
  {
    q: 'Is this a TEE?',
    a: 'No. The Mac keeps its keys in the Secure Enclave, but memory is not encrypted and the Mac’s owner can still read prompts in the inference engine. For hardware-encrypted inference, use TEE sellers. <a href="/docs/local-ai/privacy#limits">Limits →</a>',
  },
];

const FAQ_LD = faqJsonLd(FAQ);

export default function LocalAiPage(): JSX.Element {
  return (
    <Layout title="Earn From Local AI on Your Mac" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <link rel="canonical" href={PAGE_URL} />
        <script type="application/ld+json">{JSON.stringify(FAQ_LD)}</script>
      </Head>

      <PageHero
        kicker="Local AI"
        title={<>Put your Mac to work</>}
        lead="Serve Antseed buyers from a model running on your own machine, and earn USDC and ANTS for every answer it gives."
        animatedDots>
        <Button href={MAC_APP_DOWNLOAD} size="lg" arrow>Download for Mac</Button>
        <Button to="/docs/local-ai" size="lg" variant="ghost">How it works</Button>
      </PageHero>

      <Section>
        <Reveal>
          <SectionHeader title="Three ways in" lead="Join a pool, sell on your own, or run the pool others join." />
        </Reveal>
        <div className={styles.paths}>
          {PATHS.map((path, i) => (
            <Reveal key={path.title} className={styles.card} delay={i * 60}>
              <h3>{path.title}</h3>
              <p>{path.body}</p>
              <Link to={path.to} className={shared.setupLink}>
                {path.cta} <ArrowRight size={16} />
              </Link>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section tone="tinted">
        <Reveal>
          <SectionHeader title="How a pool pays your Mac" lead="Many Macs serve buyers as one seller. The split is enforced on-chain." />
        </Reveal>
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
            <Reveal key={step.n} className={styles.step} delay={i * 60}>
              <span className={styles.stepNumber} aria-hidden="true">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </Reveal>
          ))}
        </ol>
      </Section>

      <Section>
        <div className={styles.split}>
          <Reveal>
            <SectionHeader title="Up and running in minutes" lead="Download the app, paste the pool address its operator gave you, and link the wallet your earnings go to." />
            <div className={styles.downloadRow}>
              <Button href={MAC_APP_DOWNLOAD} size="lg" arrow>Download for Mac</Button>
              <Link to="/docs/local-ai/mac" className={shared.setupLink}>
                Read the Mac guide <ArrowRight size={16} />
              </Link>
            </div>
            <p className={styles.downloadNote}>Apple silicon, macOS 14 or later. Signed and notarized.</p>
          </Reveal>
          <Reveal delay={90}>
            <ol className={styles.installSteps}>
              {INSTALL.map((step, i) => (
                <li key={step.title}>
                  <span className={styles.stepNumber} aria-hidden="true">{i + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </Section>

      <Section tone="tinted">
        <Reveal>
          <SectionHeader title="Private by design" lead="The pool can’t read the prompts it routes." />
        </Reveal>
        <div className={styles.paths}>
          {PRIVACY.map((item, i) => (
            <Reveal key={item.title} className={styles.card} delay={i * 60}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Reveal>
          <h2 className={shared.faqTitle}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={FAQ} />
        </Reveal>
      </Section>

      <FinalCta title="Your Mac, earning while it idles">
        <Button href={MAC_APP_DOWNLOAD} size="lg" variant="white" arrow>Download for Mac</Button>
      </FinalCta>
    </Layout>
  );
}
