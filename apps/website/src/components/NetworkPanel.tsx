import styles from '../pages/index.module.css';
import {Button, Reveal, SectionHeader} from './ui';

/** "Owned by no one. Available to everyone." — the network section. */
const OWNED_CARDS = [
  {
    title: 'Open source and onchain',
    body: 'Every layer is public code, and every payment settles in USDC on Base.',
    illo: 'illo-best-prices',
  },
  {
    title: 'Nothing in the middle',
    body: 'Your device finds the provider, talks to it directly, and pays it directly.',
    illo: 'illo-private-by-design',
  },
  {
    title: 'Distributed and always on',
    body: 'Independent providers all over the world. If one goes down, your request moves on.',
    illo: 'illo-distributed-always-on',
  },
];

export function OwnedByNoOne() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader
            kicker="The network behind the AI VPN"
            title={
              <>
                Owned by no one. <span className={styles.titleAccent}>Available to everyone.</span>
              </>
            }
            lead="No central server and no company in the middle. Anyone can be a provider, and the Antseed Foundation maintains the open-source protocol."
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button to="/network" variant="ghost" arrow>How the network works</Button>
        </Reveal>
        <div className={styles.cardGrid3}>
          {OWNED_CARDS.map((card, i) => (
            <Reveal key={card.title} className={styles.featureCard} delay={i * 100}>
              <div className={styles.featureIlloWell}>
                <img src={`/img/home/${card.illo}.svg`} alt="" aria-hidden="true" />
              </div>
              <div className={styles.featureDivider} />
              <div className={styles.featureCopy}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
