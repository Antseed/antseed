import type {JSX} from 'react';
import {SitePage} from '../../components';
import {PricingDuo} from '../../parts/PricingDuo';
import {EndpointDuo} from '../../parts/EndpointDuo';
import {Faq} from '../../parts/Faq';
import Top from './Top';
import Features from './Features';
import Setup from './Setup';
import {BLOCKS, POINTS} from './endpoint';
import {QUESTIONS} from './questions';

const TITLE = 'AI Gateway for Apps — Lower API Costs';
const FULL_TITLE = `${TITLE} | Antseed`;
const PAGE_URL = 'https://antseed.com/apps/';
const DESCRIPTION =
  'Lower AI API costs with Antseed Gateway. Access 700+ models, choose providers, manage API keys and budgets, and set routing rules from one console.';

const PAGE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  '@id': `${PAGE_URL}#webpage`,
  url: PAGE_URL,
  name: FULL_TITLE,
  description: DESCRIPTION,
  inLanguage: 'en',
  isPartOf: {'@type': 'WebSite', name: 'Antseed', url: 'https://antseed.com/'},
  about: {
    '@type': 'SoftwareApplication',
    '@id': `${PAGE_URL}#gateway`,
    name: 'Antseed Gateway',
    url: 'https://antseed.com/docs/gateway/',
    applicationCategory: 'DeveloperApplication',
    featureList: [
      'Access AI models and choose providers',
      'Manage API keys, budgets, and usage',
      'Select TEE providers and require verification',
      'Configure routing rules and provider fallback',
      'Connect apps using OpenAI and Anthropic APIs',
    ],
  },
};

/** /apps/: Antseed Gateway for apps. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<>
        <meta name="twitter:title" content={FULL_TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <link rel="canonical" href={PAGE_URL} />
        <script type="application/ld+json">{JSON.stringify(PAGE_LD)}</script>
      </>}>
      <Top />
      <PricingDuo
        cmp="apps/pricing"
        title="Your favorite models"
        accent="at lower prices"
        lead="Choose from free models to the latest frontier models. Pay for what you use, with no subscription."
      />
      <EndpointDuo
        cmp="apps/endpoint"
        title={['Works with your', 'existing app']}
        lead="Connect your app to Antseed by updating its API address, key, and model."
        points={POINTS}
        action={{label: 'Read the API guide', href: '/docs/gateway/api/'}}
        code={{blocks: BLOCKS, status: 'Python example · gateway API', label: 'Python gateway connection example'}}
      />
      <Features />
      <Setup />
      <Faq cmp="apps/faq" items={QUESTIONS} />
    </SitePage>
  );
}
