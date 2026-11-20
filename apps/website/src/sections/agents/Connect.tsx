import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Section, SectionHead} from '../../components';
import {LinkRows} from '../../parts/LinkRows';
import {AGENT_ROWS} from './agentRows';
import styles from './Connect.module.css';

/** Works with the agents you run: a row per agent, then the way in for any other. */
export default function Connect(): JSX.Element {
  return (
    <Section cmp="agents/connect" id="connect" labelledBy="connect-title" pad="all" railClassName={styles.rail}>
      <SectionHead
        id="connect-title"
        title="Works with the agents you run."
        sub="Nothing changes in how your agent works. It talks to your local endpoint instead of a hosted API."
      />
      <LinkRows rows={AGENT_ROWS} columns={2} />
      <p className={styles.any} data-rv="">
        <span>Any OpenAI-compatible agent works too. Point it at <code>http://localhost:8377/v1</code>.</span>
        <Link to="/docs/agents/" className={styles.guide}>Read the agent guide&nbsp;→</Link>
      </p>
    </Section>
  );
}
