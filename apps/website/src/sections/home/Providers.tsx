import type {JSX} from 'react';
import {Heading, Section, Sub} from '../../components';
import {EyebrowLink} from '../../parts/EyebrowLink';
import {PathCard} from './providers/PathCard';
import {PATHS} from './providers/paths';
import styles from './providers/Providers.module.css';

/** The vision, then the two ways to provide: on your own, or in a Colony. */
export default function Providers(): JSX.Element {
  return (
    <Section cmp="home/providers" id="providers" labelledBy="providers-h" className={styles.providers} railClassName={styles.rail}>
      <header className={styles.head}>
        <EyebrowLink to="/docs/provide/">Providers</EyebrowLink>
        <Heading reveal id="providers-h" title={['Millions of computers.', 'A world of AI\u00a0providers.']} secondLine="break" className={styles.title} />
        <Sub reveal className={styles.sub}>Antseed lets anyone join in. Go on your own, or join a Colony.</Sub>
      </header>
      <div className={styles.paths}>
        {PATHS.map((p, i) => <PathCard key={p.cta.href} path={p} index={i} />)}
      </div>
    </Section>
  );
}
