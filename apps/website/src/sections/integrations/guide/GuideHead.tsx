import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Heading, Section, Sub} from '../../../components';
import {Ticks, ticksToHtml} from '../../../parts/Ticks';
import {CATEGORY_LABELS, FORMAT_LABELS, STATUS_LABELS, type Integration} from '../../../integrations/integrations';
import {IntegrationMark} from '../IntegrationMark';
import styles from './GuideHead.module.css';

/** The guide's first screen: where it sits, the tool, what it does, its facts, and the description. */
export function GuideHead({integration: i}: {integration: Integration}): JSX.Element {
  const facts = [
    CATEGORY_LABELS[i.category],
    FORMAT_LABELS[i.format],
    `~${i.setupMinutes} min`,
    ...(i.status === 'verified' ? [] : [STATUS_LABELS[i.status]]),
  ];
  return (
    <Section cmp="integration/head" labelledBy="guide-title" railClassName={styles.rail} pad="x">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/integrations/">Integrations</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{i.name}</span>
      </nav>
      <header className={styles.head} data-rv="">
        <span className={styles.mark} aria-hidden="true"><IntegrationMark integration={i} /></span>
        <Heading as="h1" id="guide-title" title={i.headline ?? i.name} className={styles.title} />
        <Sub className={styles.sub}><Ticks>{i.oneLiner}</Ticks></Sub>
        <ul className={styles.facts} aria-label="About this integration">
          {facts.map((f) => <li key={f} className={styles.fact}>{f}</li>)}
        </ul>
      </header>
      <div className={styles.description} data-rv="">
        {i.description.map((p, idx) => <p key={idx} dangerouslySetInnerHTML={{__html: ticksToHtml(p)}} />)}
      </div>
    </Section>
  );
}
