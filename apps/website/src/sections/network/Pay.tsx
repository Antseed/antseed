import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Actions, Button, Heading, Section, ThemedImg, Wash} from '../../components';
import {useInView} from '../../lib/useInView';
import {useStill} from '../../lib/useStill';
import {FeatureList} from '../../parts/FeatureList';
import {PAINTING, PAY_PATHS, type Coin, type PayPath} from './payPaths';
import styles from './Pay.module.css';

/** A coin floating over its painting, only while on screen. */
function FloatingCoin({coin, offset}: {coin: Coin; offset: boolean}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useInView(ref);
  const still = useStill();
  const cls = clsx(styles.coin, offset && styles.offset, onScreen && !still && styles.floating, coin.night && styles.cool);
  return (
    <div ref={ref} className={styles.coinBox}>
      {coin.night
        ? <ThemedImg className={cls} day={coin.src} night={coin.night} width={coin.width} height={coin.height} alt={coin.alt} />
        : <img className={cls} src={coin.src} width={coin.width} height={coin.height} alt={coin.alt} loading="lazy" decoding="async" />}
    </div>
  );
}

function Path({path, index}: {path: PayPath; index: number}): JSX.Element {
  return (
    <article className={styles.path}>
      <Wash unveil className={styles.panel} {...PAINTING}>
        <FloatingCoin coin={path.coin} offset={index === 0} />
      </Wash>
      <h3 className={styles.title} data-rv="">{path.title}</h3>
      <FeatureList className={styles.features} itemClassName={styles.feature} items={path.features} />
      <Actions fill className={styles.actions}>
        {path.actions.map((a) => <Button key={a.label} href={a.href} variant={a.variant} size="page">{a.label}</Button>)}
      </Actions>
    </article>
  );
}

/** USDC pays, ANTS makes inference liquid: the two coins facing each other. */
export default function Pay(): JSX.Element {
  return (
    <Section cmp="network/pay" id="token" labelledBy="pay-title" className={styles.pay} railClassName={styles.rail}>
      <header className={styles.head} data-rv="">
        <Heading id="pay-title" secondLine="break" className={styles.heading} title={['USDC pays.', '$ANTS makes inference liquid.']} />
      </header>
      <div className={styles.paths}>
        {PAY_PATHS.map((p, i) => <Path key={p.title} path={p} index={i} />)}
      </div>
    </Section>
  );
}
