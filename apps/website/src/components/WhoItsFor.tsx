import Link from '@docusaurus/Link';
import styles from '../pages/index.module.css';
import {Reveal, SectionHeader, ArrowRight} from './ui';
import {AgentsArt, CodingToolsArt, AnonymityArt} from './WhoCardArt';

/**
 * "For the people ready to get the most out of AI." — the three audience
 * cards (agents, usage limits, privacy). Shared by the homepage and the
 * audience pages.
 */

const WHO_CARDS = [
  {
    title: 'Who run agents',
    body: 'Hermes, OpenClaw, Codex, OpenCode, or your own. Your agent reads one skill, installs Antseed itself, and runs on free or frontier models.',
    link: {to: '/agents', label: 'For agents'},
    art: <AgentsArt />,
  },
  {
    title: 'Who hate usage limits',
    body: 'No hourly, weekly, or monthly caps. Point Claude Code, Codex, or Cursor at your local endpoint and keep going for a fraction of the plan price.',
    link: {to: '/coding', label: 'For coding apps'},
    art: <CodingToolsArt />,
  },
  {
    title: 'Who want privacy',
    body: 'No account and no email, so your identity is never part of the request. Pick a TEE provider and your prompt stays private too.',
    link: {to: '/privacy', label: 'For privacy'},
    art: <AnonymityArt />,
  },
];

export function WhoItsFor({title = 'For the people ready to get the most out of AI.'}: {title?: string}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader title={title} />
        </Reveal>
        <div className={`${styles.cardGrid3} ${styles.whoGrid}`}>
          {WHO_CARDS.map((card, i) => (
            <Reveal key={card.title} className={styles.whoCard} delay={i * 100}>
              <div className={styles.whoArt}>{card.art}</div>
              <div className={styles.featureCopy}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <Link to={card.link.to} className={styles.featureLinkArrow}>
                  {card.link.label}
                  <ArrowRight />
                </Link>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
