import type {JSX} from 'react';
import {Button} from '../../components';
import {AUDIENCE_OFFER, FirstScreen} from '../../parts/FirstScreen';
import {painting} from '../../lib/paintings';

/** The first screen: the same API, with no one in the middle. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="vs-openrouter/top"
      titleId="vs-title"
      {...AUDIENCE_OFFER}
      eyebrow="OpenRouter alternative"
      title={['A permissionless, peer-to-peer', 'alternative to OpenRouter.']}
      titleSize="long"
      sub="Same OpenAI-compatible API. Any provider can join. Pay per request in USDC. No central account, independent providers, open peer-to-peer routing."
      actions={<>
        <Button href="/docs/install/">Install Antseed&nbsp;→</Button>
        <Button href="https://antseedstats.com/network" variant="ghost">Live pricing&nbsp;↗</Button>
      </>}
      painting={{
        ...painting('/site/assets/network/hero', true),
        label: 'Seven small anthills across a meadow, linked by glowing lime trails with no centre.',
      }}
    />
  );
}
