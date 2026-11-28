import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Button, Heading, Wash} from '../../components';
import {PixelIcon, type PixelIconName} from '../../parts/PixelIcon';
import {INSTRUCTIONS_HASH} from './useStep';
import styles from './GetStarted.module.css';

const CARDS: ReadonlyArray<{icon: PixelIconName; text: string}> = [
  {icon: 'laptop', text: 'For now, Antseed can only run on a server or local computer.'},
  {icon: 'message', text: "To use it from your mobile, you'll go through Telegram instead."},
  {icon: 'check-lg', text: "1 minute now. 30 seconds later on a laptop. Then you're on the network."},
];

/** Screen 1: why the phone path goes through Telegram. */
export function Intro(): JSX.Element {
  return (
    <div className={styles.screen}>
      <header className={styles.bar}>
        <Link to="/" className={styles.back}><span aria-hidden="true">←&nbsp;</span>Back to site</Link>
      </header>
      <Wash
        eager
        unveil
        className={styles.painting}
        day="/site/assets/colony/first-day.webp"
        night="/site/assets/colony/first-night-2.webp"
        label="An ant plants a small flag on a computer at the top of an anthill while others climb up to join it."
      />
      <Heading as="h1" title={['Almost there.', "Let's get you on the network."]} secondLine="break" className={styles.title} />
      <ul className={styles.cards}>
        {CARDS.map((c) => (
          <li key={c.icon} className={styles.card}>
            <span className={styles.badge}><PixelIcon name={c.icon} /></span>
            <p>{c.text}</p>
          </li>
        ))}
      </ul>
      <Button href={INSTRUCTIONS_HASH} size="large" className={styles.wide}>Continue&nbsp;→</Button>
    </div>
  );
}
