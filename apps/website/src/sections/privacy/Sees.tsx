import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Section, SectionHead} from '../../components';
import {CompareTable, type CompareColumn} from '../../parts/CompareTable';
import {SEES_ROWS} from './seesRows';
import styles from './Sees.module.css';

const COLUMNS: readonly CompareColumn[] = [
  {label: 'Standard provider'},
  {label: 'TEE-verified provider', good: true},
  {label: 'Antseed', good: true},
];
const ROWS = SEES_ROWS.map((r) => ({label: r.label, cells: [r.standard, r.tee, r.antseed]}));

/** What a provider sees: who you are, your prompt and your payment, for each kind of provider and for Antseed. */
export default function Sees(): JSX.Element {
  return (
    <Section cmp="privacy/sees" id="who-sees-what" labelledBy="sees-title" pad="all" railClassName={styles.rail}>
      <SectionHead
        id="sees-title"
        title="What a provider sees."
        sub="Who you are and what you asked are handled separately. Pick the provider that fits how sensitive the work is."
      />
      <CompareTable columns={COLUMNS} rows={ROWS} rowsLabel="What" stack="phone" />
      <p className={styles.note} data-rv="">
        Your device checks a provider&apos;s TEE against Intel&apos;s own certificate chain before any payment, with no third party in
        between.{' '}
        <Link to="/docs/verify-tee/" className={styles.link}>Read the TEE guide&nbsp;→</Link>
      </p>
    </Section>
  );
}
