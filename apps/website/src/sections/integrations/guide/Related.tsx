import type {JSX} from 'react';
import {Section, SectionHead} from '../../../components';
import {LinkRows, type LinkRow} from '../../../parts/LinkRows';
import {Ticks} from '../../../parts/Ticks';
import {CATEGORY_LABELS, integrations, type Integration} from '../../../integrations/integrations';
import {IntegrationMark} from '../IntegrationMark';
import styles from './Related.module.css';

const RELATED_COUNT = 4;

/** Other guides in the same category, and the way back to all of them. */
export function Related({integration: i}: {integration: Integration}): JSX.Element {
  const rows: LinkRow[] = integrations
    .filter((x) => x.category === i.category && x.slug !== i.slug)
    .slice(0, RELATED_COUNT)
    .map((x) => ({name: x.name, href: `/integrations/${x.slug}/`, text: <Ticks>{x.oneLiner}</Ticks>, mark: <IntegrationMark integration={x} />, action: 'Guide'}));
  rows.push({name: 'All integrations', href: '/integrations/', text: 'Every tool that works with an Antseed gateway.', action: 'Browse'});
  return (
    <Section cmp="integration/related" labelledBy="related-title" pad="all">
      <SectionHead eyebrow={CATEGORY_LABELS[i.category]} id="related-title" title={['More guides,', 'same endpoint.']} />
      <LinkRows rows={rows} columns={2} className={styles.rows} />
    </Section>
  );
}
