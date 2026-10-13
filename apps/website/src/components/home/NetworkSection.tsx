import {Button, Reveal} from '../ui';
import {LazyMount} from '../LazyMount';
import {NetworkGlobe} from '../NetworkGlobe';
import styles from './NetworkSection.module.css';

/**
 * THE NETWORK — "Like BitTorrent, but for AI", with the open-market globe
 * from the motion kit. The globe is slowed for the homepage (one turn every
 * 26 s, fewer and slower requests) and mounts only near the viewport.
 */

const GLOBE_OPTIONS = {loopSeconds: 26, arcsPerSecond: 11, arcSeconds: [0.8, 1.2] as [number, number]};

const POINTS = [
  'Open source, and every payment settles in USDC on Base.',
  'Independent providers all over the world compete on price.',
  'If one provider goes down, your request moves on to another provider.',
];

export function NetworkSection() {
  return (
    <section className={styles.section}>
      <div className={styles.inner}>
        <Reveal className={styles.copy}>
          <p className={styles.kicker}>The network</p>
          <h2 className={styles.title}>
            Like BitTorrent,
            <br />
            but for AI
          </h2>
          <p className={styles.lead}>
            Your device finds providers over Mainline DHT, the same network BitTorrent uses, talks to them
            directly, and pays per request. Nobody sits in the middle.
          </p>
          <ul className={styles.points}>
            {POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <Button to="/network" variant="light" arrow className={styles.cta}>How the network works</Button>
        </Reveal>
        <LazyMount className={styles.globe}>
          <NetworkGlobe theme="dark" options={GLOBE_OPTIONS} />
        </LazyMount>
      </div>
    </section>
  );
}
