/** The site nav's links: one list for the bar, the phone menu and the docs' mobile sidebar. Internal links end in a slash. */

export type NavItem = {label: string; href: string};
export type ProviderItem = NavItem & {description: string; shortDescription: string};

export const NETWORK: NavItem = {label: 'Network', href: '/network/'};
export const ECOSYSTEM: NavItem = {label: 'Ecosystem', href: '/ecosystem/'};
export const LIVE_PRICES: NavItem = {label: 'Live prices', href: 'https://antseedstats.com/network'};
export const DOCS: NavItem = {label: 'Docs', href: '/docs/'};
export const BLOG: NavItem = {label: 'Blog', href: '/blog/'};
export const GATEWAY: NavItem = {label: 'Set Up Gateway', href: '/docs/quickstart/'};

/** The Providers menu: `description` in the bar's dropdown, `shortDescription` where the phone menu has less room. */
export const PROVIDERS: readonly ProviderItem[] = [
  {
    label: 'Own provider',
    href: '/providers/',
    description: 'Sell your models or AI service at your price',
    shortDescription: 'Your service, your price',
  },
  {
    label: 'Join a Colony',
    href: '/colony/',
    description: 'Share your computer with a pool while you’re away',
    shortDescription: 'Many computers. One provider.',
  },
];

/** Providers' own page: a row of the phone menu, with the two pages above under it. */
export const PROVIDERS_PAGE: NavItem = {label: 'Providers', href: '/providers/'};

/** The phone menu's rows after the providers' pages. */
export const MENU_TAIL: readonly NavItem[] = [ECOSYSTEM, LIVE_PRICES, DOCS, BLOG];

export const isExternal = (href: string): boolean => /^https?:\/\//.test(href);

/** Doc-like routes keep the nav on screen and carry the docs search. */
export const isDocsRoute = (pathname: string): boolean => /^\/(docs|blog|integrations)(\/|$)/.test(pathname);
