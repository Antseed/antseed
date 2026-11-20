import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {TELEGRAM_URL} from './config';
import {useJoinHref} from './useColony';

/** The march of Macs, the offer beside it. */
export default function Top(): JSX.Element {
  const join = useJoinHref();
  return (
    <FirstScreen
      cmp="colony/top"
      titleId="colony-title"
      eyebrow="Colony · Early access"
      title={['Join the first', 'Mac Colony.']}
      sub="Antseed Colony joins Macs into one AI provider. The first Colony is forming now, and any Apple silicon Mac can sign up."
      subWidth={324}
      actions={<>
        <Button href={join} size="page">Join the waitlist</Button>
        {TELEGRAM_URL && <Button href={TELEGRAM_URL} variant="ghost" size="page">Join the local AI Telegram group</Button>}
        <Button href="#how" variant="ghost" size="page">How it works</Button>
      </>}
      fillActions
      railStack={{tabletTitle: 'large', subWidth: 540, focus: '50% 50%', phoneFocus: '86% 50%'}}
      gaps={{stacked: [20, 8, 20], phone: [16, 16, 24]}}
      painting={{
        day: '/site/assets/colony/hero-day.webp',
        night: '/site/assets/colony/hero-night.webp',
        focus: '86% 50%',   // the front of the march: the desktop Mac held up
        label: 'A long line of ants carries their Macs across a meadow, laptops and desktops together.',
      }}
    />
  );
}
