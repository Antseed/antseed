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
        <Button href="/docs/quickstart/">Set up AI gateway&nbsp;→</Button>
        <Button href="/docs/gateway/" variant="ghost">Read the docs</Button>
      </>}
      note="No signup required"
      painting={{
        day: '/site/assets/colony/build-day.webp',
        night: '/site/assets/colony/build-night.webp',
        focus: '40% 50%',
        label: 'Two ants in a meadow lay out a building plot with stakes and string beside a blank signpost.',
      }}
    />
  );
}
