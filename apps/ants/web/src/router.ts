import { useEffect, useState } from 'react';

/** Sidebar navigation, grouped. `addresses` is a real route reached from the Network page. */
export const NAV_GROUPS = [
  { label: 'Market', items: [{ id: 'stake', label: 'Sellers' }] },
  { label: 'You', items: [{ id: 'positions', label: 'My positions' }, { id: 'rewards', label: 'Rewards' }, { id: 'seller', label: 'Seller' }] },
  { label: 'Protocol', items: [{ id: 'network', label: 'Network' }, { id: 'addresses', label: 'Addresses' }] },
] as const;

export const PAGES = ['stake', 'positions', 'rewards', 'seller', 'network', 'addresses'] as const;

export type Page = (typeof PAGES)[number];

/** Routes from earlier sidebar layouts map onto the current pages. */
const REDIRECTS: Record<string, Page> = {
  overview: 'stake',
  pools: 'stake',
  usage: 'network',
  emissions: 'network',
  verification: 'network',
};

export interface Route {
  page: Page;
  segments: string[];
  query: URLSearchParams;
  /** Set when the hash named an old route; the caller rewrites the URL. */
  redirected: boolean;
}

function isPage(value: string | undefined): value is Page {
  return PAGES.some((p) => p === value);
}

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const first = segments[0];
  const redirect = first !== undefined ? REDIRECTS[first] : undefined;
  const page: Page = isPage(first) ? first : (redirect ?? 'stake');
  return { page, segments: segments.slice(1), query: new URLSearchParams(queryPart), redirected: redirect !== undefined };
}

function readRoute(): Route {
  const route = parseRoute(window.location.hash);
  if (route.redirected) window.history.replaceState(null, '', href(route.page));
  return route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function href(page: Page, ...rest: Array<string | number>): string {
  return `#/${[page, ...rest].join('/')}`;
}
