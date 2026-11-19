import type {Integration} from '../../../integrations/integrations';

const SITE = 'https://antseed.com';

/** The page's URL with the trailing slash the host serves, as the canonical tag and sitemap give it. */
export const guideUrl = (i: Integration) => `${SITE}/integrations/${i.slug}/`;

export function breadcrumbLd(i: Integration) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {'@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/`},
      {'@type': 'ListItem', position: 2, name: 'Integrations', item: `${SITE}/integrations/`},
      {'@type': 'ListItem', position: 3, name: i.name, item: guideUrl(i)},
    ],
  };
}

/** The guide's steps in the order the page shows them, so the markup never claims a step the page doesn't have. */
export function howToLd(i: Integration) {
  const url = guideUrl(i);
  const steps: {'@type': 'HowToStep'; name: string; text: string; url: string}[] = [];
  if (i.install.length > 0) {
    steps.push({'@type': 'HowToStep', name: `Install ${i.name}`, text: i.install.map((s) => s.label).join(' '), url: `${url}#install`});
  }
  steps.push({
    '@type': 'HowToStep',
    name: `Point ${i.name} at Antseed`,
    text: `Configure ${i.name} to send requests to your Antseed gateway with a gateway API key, or to the local buyer proxy at http://localhost:8377 when it runs on the same computer.`,
    url: `${url}#configure`,
  });
  if (i.modelHints) {
    steps.push({'@type': 'HowToStep', name: 'Pick a model', text: `Choose a model available on the network. Suggested: ${i.modelHints.suggested.join(', ')}.`, url: `${url}#model`});
  }
  if (i.test && i.test.length > 0) {
    steps.push({'@type': 'HowToStep', name: 'Test it', text: i.test.map((s) => s.label).join(' '), url: `${url}#test`});
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: `Connect ${i.name} to Antseed`,
    description: `Route ${i.name} through the Antseed peer-to-peer inference network.`,
    step: steps,
  };
}
