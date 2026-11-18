import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {SIGN_UP_HREF} from './signUpLinks';

/** The march of Macs, the offer beside it. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="colony/top"
      titleId="colony-title"
      eyebrow="Colony · Early access"
      title={['Join the first', 'Mac Colony.']}
      sub="Antseed Colony joins Macs into one AI provider. The first Colony is forming now, starting with Mac Studios."
      subWidth={324}
      actions={<>
        <Button href={SIGN_UP_HREF} size="page">Sign up for early access</Button>
        <Button href="#how" variant="ghost" size="page">How it works</Button>
      </>}
      fillActions
      railStack={{tabletTitle: 'large', subWidth: 540, focus: '50% 50%', phoneFocus: '86% 50%'}}
      gaps={{stacked: [20, 8, 20], phone: [16, 16, 24]}}
      painting={{
        day: '/site/assets/colony/hero-day.webp',
        night: '/site/assets/colony/hero-night.webp',
        focus: '86% 50%',   // the front of the march: the Mac Studio held up
        label: 'A long line of ants carries Macs across a meadow. At the front, three ants hold up a Mac Studio.',
      }}
    />
  );
}
