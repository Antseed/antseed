import styles from '../pages/index.module.css';
import {useNetworkStats} from '../lib/useNetworkStats';
import {Button, Reveal} from './ui';
import {CountUp} from './HomeHero';

/** "Anyone can become a provider." — with live provider earnings. */
const SELLABLES = [
  'OpenSource models running on GPU',
  'API capacity',
  'A router you developed',
  'A specialised inference',
];

export function SellSection() {
  const stats = useNetworkStats();
  return (
    <section className={styles.sellSection}>
      <img className={styles.sellAnt} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
      <div className={styles.sectionInner}>
        <div className={styles.sellCardWrap}>
          <img className={styles.sellAntMobile} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
          <Reveal className={styles.sellCard}>
            <div className={styles.sellGrid}>
              <div className={styles.sellCopy}>
                <h2 className={styles.sellTitle}>Anyone can<br />become a provider.</h2>
                <p className={styles.sellLead}>
                  List what you have, set your price, and get on the market in minutes. When a request
                  comes your way, you serve it and the payment goes to your wallet.
                </p>
                <p className={styles.sellListTitle}>You can sell:</p>
                <ul className={styles.sellList}>
                  {SELLABLES.map((item) => (
                    <li key={item}>
                      <img className={styles.sellLine} src="/img/home/greendots.svg" alt="" aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className={styles.buttonRowLeft}>
                  <Button to="/providers" className={styles.sellDarkBtn}>Become a provider</Button>
                  <Button to="/docs/guides/become-a-provider" variant="ghost" arrow className={styles.sellGhostBtn}>
                    Read the provider guide
                  </Button>
                </div>
              </div>
              <div className={styles.earningsCol}>
                <div className={styles.earningsHead}>
                  <span>Live provider earnings</span>
                  <span className={styles.liveTag}>
                    <span className={styles.signalDots} aria-hidden="true"><i /><i /><i /></span>
                    Live
                  </span>
                </div>
                <div className={styles.earningsBig}>
                  <strong><CountUp value={stats.revenueShort} duration={1400} /></strong>
                  <span>Settled to providers on the network</span>
                </div>
                <div className={styles.earningsSmallRow}>
                  <div className={styles.earningsSmall}>
                    <strong><CountUp value={stats.providersCount} /></strong>
                    <span>Providers earning</span>
                  </div>
                  <div className={styles.earningsSmall}>
                    <strong><CountUp value={stats.settlementsPerEpoch} /></strong>
                    <span>Settlements · epoch</span>
                  </div>
                </div>
                <p className={styles.earningsNote}>
                  Live figure pulled from{' '}
                  <a href="https://antscan.co" target="_blank" rel="noopener noreferrer">
                    antscan.co
                  </a>
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
