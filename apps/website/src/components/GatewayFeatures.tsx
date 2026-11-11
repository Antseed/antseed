import {Reveal, SectionHeader} from './ui';
import {FeatureCards, type FeatureCardItem} from './FeatureCards';
import {VENDOR_GLYPHS} from './PriceBoard';
import {RoutingArt} from './home/RoutingArt';
import styles from './home/WhatYouGet.module.css';
import own from './GatewayFeatures.module.css';

function ModelsArt() {
  return (
    <div className={`${styles.logoGrid} ${own.models}`}>
      {['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Qwen', 'Moonshot'].map((name) => {
        const Glyph = VENDOR_GLYPHS[name];
        return <span key={name} className={styles.logo}>{Glyph && <Glyph size={18} />}</span>;
      })}
    </div>
  );
}

function KeysArt() {
  return (
    <div className={own.keys}>
      {[
        {name: 'Production', key: '…prod', budget: '$100 /mo'},
        {name: 'Staging', key: '…test', budget: '$20 /mo'},
        {name: 'Support', key: '…help', budget: '$50 /mo'},
      ].map((key) => (
        <div className={own.keyRow} key={key.name}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="9" r="4" /><path d="m11 12 9 9m-3-3 3-3m-6 0 3-3" />
          </svg>
          <span>{key.name}<small>antseed_{key.key}</small></span>
          <span className={own.keyBudget}>{key.budget}</span>
        </div>
      ))}
    </div>
  );
}

const FEATURES: FeatureCardItem[] = [
  {
    tag: 'Models & providers',
    title: 'Choose what runs your app',
    body: 'Access 700+ models. Compare providers by price, speed, and trust, then choose who serves your requests.',
    cta: 'Explore models and providers',
    to: '/docs/gateway/models',
    art: <ModelsArt />,
  },
  {
    tag: 'API keys',
    title: 'A key for every app',
    body: 'Create keys for apps, agents, and teammates. Set budgets and model access for each key, and tag requests to track what each app user costs.',
    cta: 'Manage API keys',
    to: '/docs/gateway/api',
    art: <KeysArt />,
  },
  {
    tag: 'Privacy',
    title: 'Choose TEE providers',
    body: 'Limit requests to providers that offer secure enclaves, and require verification before they can serve your app.',
    cta: 'How verification works',
    to: '/docs/verify-tee',
    art: <div className={styles.privacy}><img src="/img/home/spy-dots.webp" alt="" width={168} height={168} loading="lazy" decoding="async" /></div>,
  },
  {
    tag: 'Routing',
    title: 'Set your own rules',
    body: 'Set price caps, rank providers, and define fallback options. Apply rules across your gateway or to individual keys.',
    cta: 'Explore routing rules',
    to: '/docs/gateway/routing',
    art: <RoutingArt model="Your model" />,
  },
];

export function GatewayFeatures() {
  return (
    <section id="routing" className={`${styles.section} ${own.section}`}>
      <div className={styles.inner}>
        <Reveal className={styles.header}>
          <SectionHeader kicker="What you get" title="One gateway. Full control." />
        </Reveal>
        <FeatureCards items={FEATURES} className={own.grid} />
      </div>
    </section>
  );
}
