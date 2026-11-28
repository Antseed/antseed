import type {JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {Section, SectionHead, Wash} from '../../components';
import {KeysScene, ModelsScene, PrivacyScene, RoutingScene} from './Scenes';
import styles from './Features.module.css';
import {PAINTINGS, type PaintingName} from '../../lib/paintings';

type Feature = {tag: string; title: string; text: string; cta: string; href: string; painting: PaintingName; scene: ReactNode};

const FEATURES: readonly Feature[] = [
  {
    tag: 'Models & providers',
    title: 'Choose what runs your app',
    text: 'Access 700+ models. Compare providers by price, speed, and trust, then choose who serves your requests.',
    cta: 'Explore models and providers',
    href: '/docs/gateway/models/',
    painting: 'poppies',
    scene: <ModelsScene />,
  },
  {
    tag: 'API keys',
    title: 'A key for every app',
    text: 'Create keys for apps, agents, and teammates. Set budgets and model access for each key, and tag requests to track what each app user costs.',
    cta: 'Manage API keys',
    href: '/docs/gateway/api/',
    painting: 'birches',
    scene: <KeysScene />,
  },
  {
    tag: 'Privacy',
    title: 'Choose TEE providers',
    text: 'Limit requests to providers that offer secure enclaves, and require verification before they can serve your app.',
    cta: 'How verification works',
    href: '/docs/verify-tee/',
    painting: 'clover',
    scene: <PrivacyScene />,
  },
  {
    tag: 'Routing',
    title: 'Set your own rules',
    text: 'Set price caps, rank providers, and define fallback options. Apply rules across your gateway or to individual keys.',
    cta: 'Explore routing rules',
    href: '/docs/gateway/routing/',
    painting: 'horizon',
    scene: <RoutingScene />,
  },
];

/** What you get: four things the gateway lets you decide, each a painting with its scene and the line under it. */
export default function Features(): JSX.Element {
  return (
    <Section cmp="apps/features" id="routing" labelledBy="features-title" pad="all" railClassName={styles.rail}>
      <SectionHead eyebrow="What you get" id="features-title" title="One gateway. Full control." titleClassName={styles.head} />
      <div className={styles.cards}>
        {FEATURES.map((f) => (
          <article key={f.tag} className={styles.card}>
            <Wash unveil className={styles.painting} {...PAINTINGS[f.painting]}>{f.scene}</Wash>
            <div className={styles.copy} data-rv="">
              <p className={styles.tag}>{f.tag}</p>
              <h3 className={styles.title}>{f.title}</h3>
              <p className={styles.text}>{f.text}</p>
              <Link to={f.href} className={styles.cta}>{f.cta}&nbsp;→</Link>
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}
