/** Sidebar navigation, grouped. `addresses` is a real route reached from the Network page. */
export const NAV_GROUPS = [
  { label: 'Market', items: [{ id: 'stake', label: 'Sellers' }] },
  { label: 'You', items: [{ id: 'positions', label: 'My positions' }, { id: 'rewards', label: 'Rewards' }, { id: 'seller', label: 'Seller' }] },
  { label: 'Protocol', items: [{ id: 'network', label: 'Network' }, { id: 'addresses', label: 'Addresses' }] },
] as const;

export const PAGES = ['stake', 'positions', 'rewards', 'seller', 'network', 'addresses'] as const;

export type Page = (typeof PAGES)[number];

/**
 * What each page is about, so an embedding app can pick the pages it has no
 * equivalent for: `staking` is staking itself, `rewards` the reward claims,
 * `seller` running a seller, `protocol` network-wide figures and contracts.
 */
export type PageArea = 'staking' | 'rewards' | 'seller' | 'protocol';

export const PAGE_AREAS: Record<Page, PageArea> = {
  stake: 'staking',
  positions: 'staking',
  rewards: 'rewards',
  seller: 'seller',
  network: 'protocol',
  addresses: 'protocol',
};
