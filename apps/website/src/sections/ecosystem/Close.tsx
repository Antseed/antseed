import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import {Actions, Button, Section, SectionHead} from '../../components';
import styles from './Ecosystem.module.css';

type TextLink = {href: string; label: string};

const LINKS: readonly TextLink[] = [
  {href: '/docs/', label: 'Docs'},
  {href: '/integrations/', label: 'Integrations'},
  {href: 'https://t.me/antseed', label: 'Telegram ↗'},
];

/** The close: where to go next. */
export default function Close(): JSX.Element {
  return (
    <Section cmp="ecosystem/add" labelledBy="close-title" className={styles.section} railClassName={styles.rail} pad="y">
      <SectionHead
        center
        padX
        title={['Build, learn, and grow', 'with Antseed.']}
        id="close-title"
        sub="Use the docs, connect your tools, or launch a provider to help expand the peer-to-peer AI network."
        className={clsx(styles.head, styles.close)}
        titleClassName={styles.title}
        subClassName={clsx(styles.sub, styles.centeredSub)}>
        <Actions fill className={styles.actions}>
          <Button href="/docs/" size="page">Explore resources →</Button>
          <Button href="/providers/" variant="ghost" size="page">Become a provider</Button>
        </Actions>
        <p className={styles.links}>
          {LINKS.map((l) => /^https?:/.test(l.href)
            ? <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
            : <Link key={l.href} to={l.href}>{l.label}</Link>)}
        </p>
      </SectionHead>
    </Section>
  );
}
