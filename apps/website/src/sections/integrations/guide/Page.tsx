import type {JSX} from 'react';
import {SitePage} from '../../../components';
import type {Integration} from '../../../integrations/integrations';
import {GuideHead} from './GuideHead';
import {Guide} from './Guide';
import {Related} from './Related';
import {breadcrumbLd, howToLd} from './jsonLd';

/** /integrations/<slug>/: one tool's setup guide. */
export default function Page({integration: i}: {integration: Integration}): JSX.Element {
  // `oneLiner` marks code with backticks; metadata is plain text
  const metaOneLiner = i.oneLiner.replace(/`/g, '');
  return (
    <SitePage
      title={i.seoTitle ?? i.name}
      description={`Connect ${i.name} to the Antseed peer-to-peer inference network. ${metaOneLiner}`}
      head={<>
        <script type="application/ld+json">{JSON.stringify(breadcrumbLd(i))}</script>
        <script type="application/ld+json">{JSON.stringify(howToLd(i))}</script>
      </>}>
      <GuideHead integration={i} />
      <Guide integration={i} />
      <Related integration={i} />
    </SitePage>
  );
}
