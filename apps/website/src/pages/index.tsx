import type {JSX} from 'react';
import {SitePage} from '../components';
import Hero from '../sections/home/Hero';
import Prices from '../sections/home/Prices';
import Gateway from '../sections/home/Gateway';
import Desktop from '../sections/home/Desktop';
import Products from '../sections/home/Products';
import Privacy from '../sections/home/Privacy';
import Providers from '../sections/home/Providers';
import Network from '../sections/home/Network';
import Faq from '../sections/home/Faq';

export default function Home(): JSX.Element {
  return (
    <SitePage
      title="Antseed | The open intelligence network"
      fullTitle
      description="The open intelligence network. Give your agents, apps, and team 700+ AI models at lower prices, with built-in privacy and full control."
      hero={<Hero />}>
      <Prices />
      <Products>
        <Gateway />
        <Desktop />
      </Products>
      <Privacy />
      <Providers />
      <Network />
      <Faq />
    </SitePage>
  );
}
