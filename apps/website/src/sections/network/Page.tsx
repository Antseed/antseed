import type {JSX} from 'react';
import {SitePage} from '../../components';
import Top from './Top';
import Build from './Build';
import Layers from './Layers';
import Pay from './Pay';
import Where from './Where';
import Trust from './Trust';
import Vision from './Vision';
import Open from './Open';

const TITLE = 'The Antseed network';
const DESCRIPTION = 'Intelligence can be produced anywhere. Its market should be open to everyone.';

/** /network/: how the network works, its token and its principles. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      ctaProps={{titleBreak: true, subWrap: 'pretty'}}
      title={TITLE}
      description={DESCRIPTION}>
      <Top />
      <Build />
      <Layers />
      <Pay />
      <Where />
      <Trust />
      <Vision />
      <Open />
    </SitePage>
  );
}
