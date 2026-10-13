import type {ReactNode} from 'react';
import {LinkArrow, Reveal, SectionHeader} from '../ui';
import {AGENTS} from '../AgentsLogoBar';
import {VENDOR_GLYPHS} from '../PriceBoard';
import styles from './WhatYouGet.module.css';

/**
 * WHAT YOU GET — what Antseed gives you and who it is for, in one row of
 * four cards (agents, heavy users, privacy, teams). Each card links to the
 * page that tells the long version. The small visuals are static markup.
 */

const MODEL_MARKS = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Qwen', 'Moonshot'];

function AgentsArt() {
  return (
    <div className={styles.logoGrid}>
      {AGENTS.map((a) => (
        <span key={a.name} className={styles.logo} title={a.name}>
          {a.logo ? <img src={a.logo} alt="" width={18} height={18} loading="lazy" /> : a.glyph}
        </span>
      ))}
      {MODEL_MARKS.map((name) => {
        const Glyph = VENDOR_GLYPHS[name];
        return (
          <span key={name} className={styles.logo} title={name}>
            {Glyph ? <Glyph size={18} /> : null}
          </span>
        );
      })}
    </div>
  );
}

function UsageArt() {
  return (
    <div className={styles.usage}>
      <div>
        <span className={styles.usageHead}><span>Plan usage</span><span>Limit reached</span></span>
        <span className={styles.barCapped} />
      </div>
      <div>
        <span className={`${styles.usageHead} ${styles.usageHeadOn}`}><span>Antseed</span><span>No cap</span></span>
        <span className={styles.barOpen} />
      </div>
    </div>
  );
}

function PrivacyArt() {
  return (
    <div className={styles.privacy}>
      <img src="/img/home/spy-dots.png" alt="" width={168} height={168} loading="lazy" />
    </div>
  );
}

function RoutingArt() {
  return (
    <div className={styles.routing}>
      <span className={styles.routeModel}>kimi-k2.7-code</span>
      <svg viewBox="0 0 280 180" preserveAspectRatio="none" className={styles.routeLines}>
        <path d="M140 52 V122" className={styles.routeOn} />
        <path d="M140 52 C140 90 56 84 56 122" className={styles.routeOn} />
        <path d="M140 52 C140 90 224 84 224 122" className={styles.routeOff} />
      </svg>
      <div className={styles.routeNodes}>
        <span>
          <i className={styles.nodeOk}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </i>
          Provider A
        </span>
        <span><i className={styles.nodeIdle} />Provider B</span>
        <span className={styles.nodeOffLabel}>
          <i className={styles.nodeOff}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </i>
          Offline
        </span>
      </div>
    </div>
  );
}

const CARDS: {tag: string; title: string; body: string; cta: string; to: string; art: ReactNode}[] = [
  {
    tag: 'Agents',
    title: 'Every model, lower prices',
    body: 'Connect Hermes, OpenClaw, or your own agent, and access free or frontier models at lower costs.',
    cta: 'Antseed for agents',
    to: '/agents',
    art: <AgentsArt />,
  },
  {
    tag: 'Heavy users',
    title: 'No usage limits',
    body: 'Run AI as much as you want. Pay per request without usage windows.',
    cta: 'Antseed for coding',
    to: '/coding',
    art: <UsageArt />,
  },
  {
    tag: 'Privacy',
    title: 'Private by design',
    body: 'No one knows who you are. No account or email, and TEE providers keep your prompts private.',
    cta: 'How privacy works',
    to: '/privacy',
    art: <PrivacyArt />,
  },
  {
    tag: 'Teams',
    title: 'API keys for everyone',
    body: 'Full control of your teams or agents. Manage access, budgets, and track usage.',
    cta: 'Set up a gateway',
    to: '/docs/gateway/server',
    art: <RoutingArt />,
  },
];

export function WhatYouGet() {
  return (
    <section className={styles.section}>
      <div className={styles.inner}>
        <Reveal className={styles.header}>
          <SectionHeader kicker="What you get" title="For the people ready to get the most out of AI" />
        </Reveal>
        <div className={styles.grid}>
          {CARDS.map((c, i) => (
            <Reveal key={c.tag} className={styles.card} delay={i * 60}>
              <div className={styles.art} aria-hidden="true">{c.art}</div>
              <div className={styles.body}>
                <p className={styles.tag}>{c.tag}</p>
                <h3 className={styles.title}>{c.title}</h3>
                <p className={styles.text}>{c.body}</p>
                <LinkArrow to={c.to} className={styles.cta}>{c.cta}</LinkArrow>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
