import type {JSX} from 'react';
import clsx from 'clsx';
import {Button, Heading} from '../../components';
import {useShare} from './useShare';
import styles from './GetStarted.module.css';

type Step = {image: string; alt: string; width: number; height: number; text: string; flush?: boolean; telegram?: boolean};

const STEPS: readonly Step[] = [
  {
    image: '/img/get-started/step-botfather.webp', width: 1930, height: 730, telegram: true,
    alt: 'Telegram chat with @BotFather showing the /newbot command',
    text: 'In Telegram, message @BotFather, send /newbot, and pick any name.',
  },
  {
    image: '/img/get-started/step-token.webp', width: 1258, height: 270,
    alt: "BotFather's reply with the bot token",
    text: "You'll get a token back, keep it, you'll paste it into Antseed Desktop after installing.",
  },
  {
    image: '/img/get-started/step-vpr.webp', width: 684, height: 400, flush: true,
    alt: "Antseed Desktop's Telegram Bot settings with the token field",
    text: 'When you get to your computer, install Antseed Desktop and paste the token into it.',
  },
];

/** Screen 2: create the bot now, paste its token into Antseed Desktop later. */
export function Instructions({onBack}: {onBack: () => void}): JSX.Element {
  const {share, copied} = useShare('Get started with Antseed', '/get-started/');
  return (
    <div className={styles.screen}>
      <header className={styles.bar}>
        <button type="button" className={styles.back} onClick={onBack}><span aria-hidden="true">←&nbsp;</span>Back</button>
        <button type="button" className={styles.share} onClick={share} aria-label="Share this page">{copied ? 'Copied' : 'Share'}</button>
      </header>
      <Heading as="h1" title="Do this before you leave" className={styles.title} />
      <ol className={styles.steps}>
        {STEPS.map((s, i) => (
          <li key={s.image} className={styles.step}>
            <img className={clsx(styles.shot, s.flush && styles.flush)} src={s.image} alt={s.alt} width={s.width} height={s.height} loading="lazy" decoding="async" />
            <div className={styles.stepText}>
              <span className={styles.number}>{i + 1}</span>
              <p>{s.text}</p>
            </div>
            {s.telegram && <Button href="https://t.me/BotFather" variant="ghost" className={styles.wide}>Open Telegram&nbsp;↗</Button>}
          </li>
        ))}
      </ol>
    </div>
  );
}
