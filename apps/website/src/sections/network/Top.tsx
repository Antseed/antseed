import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {painting} from '../../lib/paintings';

/** The network's first screen: the offer beside anthills linked by trails with no centre. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="network/top"
      titleId="network-title"
      eyebrow="The Antseed network"
      title={['The world’s largest', 'inference liquidity network.']}
      titleSize="tight"
      secondLine="block"
      sub="Intelligence can be produced anywhere. Its market should be open to everyone."
      subWidth={340}
      actions={<Button href="/docs/overview/" size="page">Read the protocol</Button>}
      fillActions
      railStack={{fluidPhoneTitle: true}}
      gaps={{stacked: [16, 24, 28]}}
      painting={{
        ...painting('/site/assets/network/hero', true),
        label: 'Seven small anthills across a meadow, linked by glowing lime trails with no centre. Ants carry envelopes and gold coins from one anthill to another, and a few tend small Mac Studios.',
      }}
    />
  );
}
