import type {JSX} from 'react';
import {Duo, Wash} from '../../components';
import type {Feature} from '../../parts/FeatureList';
import {ProductCopy} from './products/ProductCopy';
import {GatewayFilm} from './gateway/GatewayFilm';
import styles from './gateway/Gateway.module.css';
import {PAINTINGS} from '../../lib/paintings';

const FEATURES: readonly Feature[] = [
  {icon: 'lock', text: 'Your endpoint. A key and budget for each agent.'},
  {icon: 'directions', text: 'Route by price, speed, privacy or provider'},
  {icon: 'user', text: 'Run your own workspace for your team'},
  {icon: 'analytics', text: 'Track your balances and usage. Pay by card, Apple Pay and more'},
];

/** Antseed Gateway: the pitch beside the console on film, over a painting. */
export default function Gateway(): JSX.Element {
  return (
    <Duo
      cmp="home/gateway"
      id="gateway"
      labelledBy="gateway-title"
      text={
        <ProductCopy
          eyebrow={{label: 'Antseed Gateway', href: '/docs/gateway/'}}
          titleId="gateway-title"
          title={['Be your own', 'AI router.']}
          sub="Run the gateway and route every agent’s requests across the network on your rules. Your keys, your budgets, no middleman."
          subWidth={420}
          features={FEATURES}
          primary={{label: 'Set Up Gateway', href: '/docs/quickstart/'}}
          secondary={{label: 'Learn more', href: '/docs/gateway/'}}
        />
      }
      panel={
        <Wash unveil reveal="panel" className={styles.panel} {...PAINTINGS.horizon}>
          <GatewayFilm />
        </Wash>
      }
    />
  );
}
