export type FooterLink = {label: string; to: string; external?: boolean};
export type FooterColumn = {title: string; links: readonly FooterLink[]};

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {title: 'Product', links: [
    {label: 'Antseed Desktop', to: '/docs/desktop/'},
    {label: 'Gateway', to: '/docs/gateway/'},
    {label: 'Live prices\u00a0↗', to: 'https://antseedstats.com/network', external: true},
    {label: 'Integrations', to: '/integrations/'},
    {label: 'Ecosystem', to: '/ecosystem/'},
  ]},
  {title: 'Network', links: [
    {label: 'How it works', to: '/network/'},
    {label: 'Become a Provider', to: '/providers/'},
    {label: 'Colony', to: '/colony/'},
    {label: '$ANTS', to: '/ants/'},
    {label: 'vs OpenRouter', to: '/vs/openrouter/'},
    {label: 'AntSeedStats\u00a0↗', to: 'https://antseedstats.com', external: true},
    {label: 'AIPs\u00a0↗', to: 'https://aips.antseed.com', external: true},
  ]},
  {title: 'Resources', links: [
    {label: 'Blog', to: '/blog/'},
    {label: 'Brand', to: '/brand/'},
    {label: 'Docs', to: '/docs/'},
    {label: 'GitHub\u00a0↗', to: 'https://github.com/antseed', external: true},
  ]},
  {title: 'Legal', links: [
    {label: 'Terms of Service', to: '/terms-of-service/'},
    {label: 'Privacy Policy', to: '/privacy-policy/'},
  ]},
];

export type SocialLink = {label: string; href: string; viewBox: string; path: string};

export const SOCIAL_LINKS: readonly SocialLink[] = [
  {label: 'Antseed on X', href: 'https://x.com/antseed', viewBox: '0 0 24 24',
    path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'},
  {label: 'Antseed on GitHub', href: 'https://github.com/Antseed/antseed', viewBox: '0 0 16 16',
    path: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'},
  {label: 'Antseed on Telegram', href: 'https://t.me/antseed', viewBox: '0 0 24 24',
    path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z'},
];
