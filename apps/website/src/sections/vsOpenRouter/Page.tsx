import type {JSX} from 'react';
import {SitePage} from '../../components';
import {Faq} from '../../parts/Faq';
import Top from './Top';
import Comparison from './Comparison';
import Fit from './Fit';
import Install from './Install';
import {QUESTIONS} from './questions';

const TITLE = 'OpenRouter Alternative: P2P, No Account';
const DESCRIPTION =
  'Antseed is a permissionless, peer-to-peer alternative to OpenRouter. Any provider can join. Requests go direct. Pay per request in USDC - no central account.';

/** /vs/openrouter/: Antseed compared with OpenRouter. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<link rel="canonical" href="https://antseed.com/vs/openrouter/" />}>
      <Top />
      <Comparison />
      <Fit />
      <Install />
      <Faq cmp="vs-openrouter/faq" items={QUESTIONS} />
    </SitePage>
  );
}
