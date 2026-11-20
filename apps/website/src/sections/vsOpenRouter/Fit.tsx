import type {JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {Section} from '../../components';
import {PixelIcon} from '../../parts/PixelIcon';
import styles from './Fit.module.css';

type Case = {title: string; ours: boolean; items: readonly ReactNode[]};

const CASES: readonly Case[] = [
  {
    title: 'When to pick Antseed',
    ours: true,
    items: [
      'You want to run inference without creating another SaaS account.',
      "You're building an agent that needs to pay for its own inference.",
      'You want payments to settle per request, on-chain, with no platform holding funds.',
      <>You want to <Link to="/providers/">serve</Link> a model and get paid without applying to a platform.</>,
      'You need open peer-to-peer routing that does not rely on one hosted service.',
    ],
  },
  {
    title: 'When OpenRouter might still fit',
    ours: false,
    items: [
      'You prefer a credit-card-funded account over an on-chain wallet.',
      'You want a single vendor relationship with a support contact.',
      "You're fine with the platform routing every request through their servers.",
    ],
  },
];

/** When each one fits, side by side. */
export default function Fit(): JSX.Element {
  return (
    <Section cmp="vs-openrouter/fit" label="When each fits" railClassName={styles.rail}>
      {CASES.map((c) => (
        <div key={c.title} className={styles.case} data-rv="">
          <h2 className={styles.title}>{c.title}</h2>
          <ul className={styles.list}>
            {c.items.map((item, i) => (
              <li key={i} className={c.ours ? styles.ours : styles.theirs}>
                <PixelIcon name={c.ours ? 'check' : 'chevron-right'} className={styles.icon} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}
