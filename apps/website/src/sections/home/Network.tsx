import type {JSX} from 'react';
import {Button, Heading, Section, Sub} from '../../components';
import {EyebrowLink} from '../../parts/EyebrowLink';
import NetworkDiagram from '../../parts/NetworkDiagram/NetworkDiagram';
import styles from './network/Network.module.css';

/** The network: the vision, then the board animated in three steps, its points ending on the way to /network/. */
export default function Network(): JSX.Element {
  return (
    <Section cmp="home/network" id="network" labelledBy="network-title" className={styles.network} railClassName={styles.rail}>
      <header className={styles.head}>
        <EyebrowLink to="/network/">How the network works</EyebrowLink>
        <Heading reveal id="network-title" title={['Building the world’s largest', 'inference liquidity network.']} secondLine="break" />
        <Sub reveal className={styles.sub}>
          A fully peer-to-peer network for AI — like BitTorrent for inference. Buyers connect directly to independent providers, with no
          middleman. Anyone can supply intelligence, on their own terms.
        </Sub>
      </header>
      <NetworkDiagram
        boardClassName={styles.board}
        pointsClassName={styles.points}
        pointClassName={styles.point}
        extra={<Button href="/network/">How the network works</Button>}
      />
    </Section>
  );
}
