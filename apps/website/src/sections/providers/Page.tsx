import type {JSX} from 'react';
import {SitePage} from '../../components';
import {Top} from './Top';
import {Figures} from './Figures';
import {Running} from './Running';
import {Reputation} from './Reputation';
import {FoundationStaking} from './FoundationStaking';

/** /providers/: becoming your own provider. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      ctaProps={{titleBreak: true, subWrap: 'pretty'}}
      title="Become your own provider"
      description="Offer open models on your GPUs, capacity you hold, a router you built, a specialized service or an agent.">
      <Top />
      <Figures />
      <Running />
      <Reputation />
      <FoundationStaking />
    </SitePage>
  );
}
