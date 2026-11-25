import type {JSX} from 'react';
import Page from '../sections/integrations/guide/Page';
import type {Integration} from './integrations';

/** The route component plugins/integrations-pages.ts registers for each /integrations/<slug>/. */
export default function IntegrationPage({integration}: {integration: Integration}): JSX.Element {
  return <Page integration={integration} />;
}
