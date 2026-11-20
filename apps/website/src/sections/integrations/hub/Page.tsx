import type {JSX} from 'react';
import {SitePage} from '../../../components';
import Top from './Top';
import Catalog from './Catalog';
import Help from './Help';

const DESCRIPTION = 'Every way to use Antseed: coding agents, autonomous agents, editors, SDKs, frameworks, partner platforms. Anthropic and OpenAI compatible. Drop-in via your Antseed gateway.';

const BREADCRUMB_LD = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {'@type': 'ListItem', position: 1, name: 'Home', item: 'https://antseed.com/'},
    {'@type': 'ListItem', position: 2, name: 'Integrations', item: 'https://antseed.com/integrations/'},
  ],
};

/** /integrations/: the catalog of tools that work with an Antseed gateway. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title="Integrations"
      description={DESCRIPTION}
      head={<script type="application/ld+json">{JSON.stringify(BREADCRUMB_LD)}</script>}>
      <Top />
      <Catalog />
      <Help />
    </SitePage>
  );
}
