import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Actions, Button, Heading, Section} from '../../components';
import styles from './Open.module.css';

const LAYERS = [
  {name: 'Discovery', text: 'Finding peers and signed listings', href: '/docs/discovery/'},
  {name: 'Transport', text: 'Verified peers and encrypted traffic', href: '/docs/transport/'},
  {name: 'Metering & payments', text: 'Signed usage and USDC settlement', href: '/docs/payments/'},
  {name: 'Reputation', text: 'Trust scoring and identity signals', href: '/docs/reputation/'},
  {name: 'Model verification', text: 'Public audits of what is served', href: '/docs/model-verification/'},
] as const;

/** Every layer is open: the way in at the left, each layer's docs at the right. */
export default function Open(): JSX.Element {
  return (
    <Section cmp="network/open" labelledBy="open-title" className={styles.open} railClassName={styles.rail}>
      <div className={styles.head}>
        <Heading id="open-title" secondLine="break" className={styles.title} title={['Every layer is open.', <>Read it, run it,<br /> build on it.</>]} />
        <Actions fill>
          <Button href="/providers/" size="page">Become a provider</Button>
          <Button href="https://github.com/Antseed/antseed" variant="ghost" size="page">Source on GitHub&nbsp;↗</Button>
        </Actions>
      </div>
      <ul className={styles.docs}>
        {LAYERS.map((l) => (
          <li key={l.name}>
            <Link to={l.href} className={styles.doc}><b>{l.name}</b><span>{l.text}</span></Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
