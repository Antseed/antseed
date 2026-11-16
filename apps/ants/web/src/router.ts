import { useEffect, useState } from 'react';
import { host } from './host';
import { PAGES, type Page } from './pages';

export { NAV_GROUPS, PAGES, PAGE_AREAS, type Page, type PageArea } from './pages';

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
  const named: Page = isPage(first) ? first : (redirect ?? 'stake');
  const shown = host().pages;
  const page = shown.includes(named) ? named : (shown[0] ?? named);
  return { page, segments: segments.slice(1), query: new URLSearchParams(queryPart), redirected: redirect !== undefined };
}

function readRoute(): Route {
  const route = parseRoute(host().currentPath());
  if (route.redirected) host().replace(route.page);
  return route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    return host().subscribe(onChange);
  }, []);
  return route;
}

export function href(page: Page, ...rest: Array<string | number>): string {
  return host().href([page, ...rest].join('/'));
}
