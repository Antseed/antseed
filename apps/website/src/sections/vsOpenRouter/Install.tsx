import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Heading, Section} from '../../components';
import {CommandChip} from '../../parts/CommandChip';
import styles from './Install.module.css';

/** Get started in one command. */
export default function Install(): JSX.Element {
  return (
    <Section cmp="vs-openrouter/install" labelledBy="install-title" pad="all" railClassName={styles.rail}>
      <Heading id="install-title" title="Get started in one command." reveal className={styles.title} />
      <div className={styles.command} data-rv=""><CommandChip command="npm install -g @antseed/cli" /></div>
      <p className={styles.note} data-rv="">
        <span>Open source. Runs locally.</span>
        <Link to="/docs/install/">Full install guide&nbsp;→</Link>
      </p>
    </Section>
  );
}
