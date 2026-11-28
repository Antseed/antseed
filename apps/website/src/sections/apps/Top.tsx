import type {JSX} from 'react';
import {Button} from '../../components';
import {AUDIENCE_OFFER, FirstScreen} from '../../parts/FirstScreen';

/** The first screen: lower AI costs for your app, through your own gateway. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="apps/top"
      titleId="apps-title"
      {...AUDIENCE_OFFER}
      eyebrow="Antseed Gateway"
      title={['Lower AI costs', 'for your app']}
      sub="Access 700+ AI models, with prices below the official APIs. Choose providers, set budgets, and track usage from one console."
      actions={<>
        <Button href="/docs/quickstart/" size="page">Set Up Gateway&nbsp;→</Button>
        <Button href="/docs/gateway/" variant="ghost" size="page">Read the docs</Button>
      </>}
      note="No signup required"
      painting={{
        day: '/site/assets/colony/build-day.webp',
        night: '/site/assets/colony/build-night-2.webp',
        // 40% across, with the night's lantern (x 1070-1145 of 1600) never cut in half: whole on its right edge when the panel holds
        // it and the left ant, otherwise kept out (the painting is 893 high, so 1px of it is 100cqh / 893)
        focus: 'calc(-1 * min(max(71.67cqh - 40cqw, min(130.46cqh - 100cqw, 1000 * (100cqw - 85.67cqh))), '
          + 'max(118.7cqh - 100cqw, 1000 * (100cqw - 85.67cqh)))) 50%',
        label: 'Two ants in a meadow lay out a building plot with stakes and string beside a blank signpost.',
      }}
    />
  );
}
