import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {painting} from '../../lib/paintings';

/** The offer beside the painted village of projects round the anthill. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="ecosystem/top"
      titleId="ecosystem-title"
      eyebrow="Ecosystem"
      title={['Explore the', 'Antseed ecosystem.']}
      titleSize="tight"
      sub="Connect with builders, providers, explorers, and AI-focused projects growing around peer-to-peer AI infrastructure."
      subGap={24}
      subWidth={440}
      actions={<>
        <Button href="https://antseedstats.com/network" size="page">Explore live network →</Button>
        <Button href="/docs/" variant="ghost" size="page">Build on Antseed</Button>
      </>}
      fillActions
      railStack={{inset: true, ratio: '16 / 10', phoneRatio: '4 / 5', focus: '50% 42%', phoneFocus: '50% 40%', tabletTitle: 'tight', subWidth: 560}}
      painting={{
        ...painting('/site/assets/ecosystem/hero', true),
        label: 'A little village of ant projects around an anthill and its Mac Studio: a market stall, a lookout tower with a telescope, a notice board of charts, a workshop, a map table and a post box, linked by paths and twig bridges',
      }}
    />
  );
}
