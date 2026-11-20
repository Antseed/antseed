import type {PixelIconName} from '../../parts/PixelIcon';

const SHOTS = '/site/assets/ecosystem/shots';

export type Listing = {
  name: string;
  line: string;
  href: string;
  /** A screenshot of where the card leads, 800 × 600. */
  shot: string;
  alt: string;
};

/** Live projects built on or around Antseed, as listed in its directory. */
export const PROJECTS: readonly Listing[] = [
  {name: 'Diem Antseed.', line: 'A DIEM provider capacity program built around Antseed.', href: 'https://diemantseed.com', shot: `${SHOTS}/diem.webp`, alt: 'The diemantseed.com site'},
  {name: 'AntSeedStats.', line: 'The metrics and intelligence layer of the Antseed ecosystem.', href: 'https://antseedstats.com', shot: `${SHOTS}/stats.webp`, alt: 'The antseedstats.com site'},
  {name: 'Antscan.', line: 'An Antseed explorer for Base settlements, service offers, channels, and emissions.', href: 'https://antscan.co/', shot: `${SHOTS}/antscan.webp`, alt: 'The antscan.co site'},
  {name: 'Antseed Points.', line: 'Earn points when you spend on AI through Antseed.', href: 'https://antseedpoints.com', shot: `${SHOTS}/points.webp`, alt: 'The antseedpoints.com site'},
  {name: 'antseedmarkets.', line: 'Trade lANTS with 0 fees, built on OpenSea’s Seaport, Opensourced since day 1.', href: 'https://antseedmarkets.com', shot: `${SHOTS}/markets.webp`, alt: 'The antseedmarkets.com site'},
  {name: 'lANTS Market.', line: 'A board and USDC market for lANTS staking positions on Antseed.', href: 'https://lants.eth.limo', shot: `${SHOTS}/lants.webp`, alt: 'The lants.eth.limo site'},
  {name: 'SeedStore.', line: 'Live data for your agent, served as models on Antseed by Sippar.', href: 'https://sippar.network/seedstore/', shot: `${SHOTS}/seedstore.webp`, alt: 'The SeedStore on sippar.network site'},
  {name: 'SeedTunnel.', line: 'The easy way into Antseed for teams: top AI models and live data, in your own gateway or in the AI you already use.', href: 'https://sippar.network/seedtunnel/', shot: `${SHOTS}/seedtunnel.webp`, alt: 'The SeedTunnel on sippar.network site'},
];

/** Where builders start: the explorer, the docs, the provider hub. */
export const PLACES: readonly Listing[] = [
  {name: 'Network Explorer.', line: 'Watch live providers, market prices, usage, and routing activity across the Antseed network.', href: 'https://antseedstats.com/network', shot: `${SHOTS}/explorer.webp`, alt: 'The AntSeedStats network page'},
  {name: 'Developer Docs.', line: 'Use Antseed as peer-to-peer AI infrastructure from apps, agents, routers, and existing tools.', href: '/docs/', shot: `${SHOTS}/docs.webp`, alt: 'The Antseed documentation'},
  {name: 'Provider Hub.', line: 'Launch a differentiated AI service, managed product, agent, router, or inference provider.', href: '/providers/', shot: `${SHOTS}/providers.webp`, alt: 'The Antseed providers page'},
];

export type Pillar = {icon: PixelIconName; name: string; line: string};

export const PILLARS: readonly Pillar[] = [
  {icon: 'laptop', name: 'Applications', line: 'Products that turn Antseed providers into user-facing AI workflows.'},
  {icon: 'blocks', name: 'Infrastructure', line: 'Explorers, routers, gateways, dashboards, and services that make the network easier to use.'},
  {icon: 'server', name: 'Providers', line: 'Independent operators serving differentiated AI capabilities, agents, TEE services, or managed products.'},
  {icon: 'plug', name: 'Integrations', line: 'Tools and frameworks that connect existing developer workflows to the local Antseed endpoint.'},
];
