import {themes as prismThemes} from 'prism-react-renderer';
import type {Config, Plugin, PluginConfig, PluginModule} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import integrationsPagesPlugin from './plugins/integrations-pages';
import {integrations as integrationEntries} from './src/integrations/integrations';
import desktopPkg from '../desktop/package.json';

const statsProxyPlugin: PluginModule = () => ({
  name: 'stats-proxy',
  configureWebpack() {
    // Docusaurus merges `config.devServer` during `docusaurus start`, but the
    // exported webpack config type does not include that field.
    return {
      devServer: {
        proxy: [
          {
            context: ['/stats-api'],
            target: 'http://localhost:3001',
            pathRewrite: {'^/stats-api': ''},
            changeOrigin: true,
          },
        ],
      },
    } as unknown as ReturnType<NonNullable<Plugin['configureWebpack']>>;
  },
});

/** Google Tag Manager container for antseed.com. */
const GTM_CONTAINER_ID = process.env.GTM_CONTAINER_ID ?? 'GTM-NHCLBQQK';

/**
 * Typed explicitly: an inline array literal widens to `string | object`, which
 * does not satisfy PluginConfig's [name, options] tuple.
 */
const gtmPlugin: PluginConfig[] = GTM_CONTAINER_ID
  ? [['@docusaurus/plugin-google-tag-manager', {containerId: GTM_CONTAINER_ID}]]
  : [];

const config: Config = {
  title: 'Antseed',
  tagline: 'Run your agents on your terms. No gatekeepers.',
  favicon: 'logo.svg',
  url: 'https://antseed.com',
  baseUrl: '/',
  // The host 308-redirects /path to /path/, so without this Docusaurus emitted
  // canonical tags and sitemap entries pointing at the pre-redirect form: every
  // URL was a redirect source and no page's canonical actually resolved to
  // itself. `true` makes the emitted URLs match what the host already serves.
  trailingSlash: true,
  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          // Feeds the sitemap's `lastmod` from the file's git commit date.
          // Without it every URL carried the build date, so each deploy told
          // crawlers all 59 pages had changed.
          showLastUpdateTime: true,
        },
        pages: {
          showLastUpdateTime: true,
        },
        blog: {
          showLastUpdateTime: true,
          showReadingTime: true,
          blogTitle: 'Antseed Blog',
          blogDescription: 'Insights on OpenRouter alternatives, P2P AI networks, and the future of AI inference.',
          postsPerPage: 10,
          blogSidebarCount: 'ALL',
        },
        sitemap: {
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          filename: 'sitemap.xml',
          ignorePatterns: ['/tags/**', '/blog/tags/**', '/blog/archive', '/blog/authors'],
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    // Google Tag Manager. GA4 is configured as a tag *inside* GTM rather than
    // loaded separately, so there is one script on the page and no risk of
    // double-counting pageviews. Adding Ads/LinkedIn/Meta pixels later is a
    // GTM change, not a code change.
    //
    // A GTM container id is public — it ships in the page source — so it lives
    // here rather than in deploy config, and the site works without anyone
    // setting an env var. GTM_CONTAINER_ID still overrides it for staging or a
    // throwaway test container. Set it to an empty string to disable GTM.
    ...gtmPlugin,
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {from: '/lightpaper', to: '/docs/lightpaper'},
          // /connect was renamed to /integrations — keep old links working.
          {from: '/connect', to: '/integrations'},
          ...integrationEntries.map((i) => ({
            from: `/connect/${i.slug}`,
            to: `/integrations/${i.slug}`,
          })),
        ],
      },
    ],
    statsProxyPlugin,
    integrationsPagesPlugin,
  ],

  // General Sans — the design's display/body face (Geist stays for app-chrome/mono).
  stylesheets: [
    {
      href: 'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap',
      type: 'text/css',
    },
  ],

  headTags: [
    // Second Search Console owner. A site can carry several verification tags,
    // one per Google account, and removing one un-verifies that account — so
    // this is additive, not a replacement for the token in themeConfig.metadata.
    //
    // It lives here rather than alongside the other one because themeConfig
    // metadata is rendered through react-helmet, which dedupes <meta> by name:
    // two google-site-verification entries there would collapse into one and
    // this token would silently never ship. headTags is injected verbatim.
    {
      tagName: 'meta',
      attributes: {
        name: 'google-site-verification',
        content: 'wiMhtNPC3UWtvOKXeJBto55Y8F6-7ORyA1aAI_DkZ-A',
      },
    },
    {
      tagName: 'script',
      attributes: {type: 'application/ld+json'},
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Antseed',
        url: 'https://antseed.com',
        description:
          'Run your agents on your terms. Serve or consume AI peer-to-peer. Pay per request in USDC. Anonymous by design, with independent providers and no central account.',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux, Windows',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free and open-source. Pay only for inference consumed.',
        },
        creator: {
          '@type': 'Organization',
          name: 'Antseed',
          url: 'https://antseed.com',
          sameAs: [
            'https://github.com/AntSeed/antseed',
            'https://x.com/antseed',
            'https://t.me/antseed',
          ],
        },
        featureList: [
          'P2P inference routing via DHT',
          'OpenAI Responses API compatible',
          'OpenAI Chat Completions API compatible',
          'Reputation-based provider scoring',
          'TEE attestation for privacy-preserving inference',
          'AI agents with on-demand knowledge and custom tools',
          'Desktop app (AI VPN)',
          'Agent-to-agent commerce support',
        ],
        downloadUrl: 'https://github.com/AntSeed/antseed/releases',
        softwareVersion: desktopPkg.version,
        license: 'https://github.com/AntSeed/antseed/blob/main/LICENSE',
      }),
    },
  ],

  themeConfig: {
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'description', content: 'Run your agents on your terms. Save on every AI model. No usage limits, no middleman, always anonymous.'},
      {property: 'og:title', content: 'Run your agents on your terms'},
      {property: 'og:description', content: 'Antseed lets you run your agents on your terms. Save on every AI model. No usage limits, no middleman, always anonymous.'},
      {property: 'og:type', content: 'website'},
      {property: 'og:site_name', content: 'Antseed'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:site', content: '@antseed'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image-open-market.png'},
      {property: 'og:image', content: 'https://antseed.com/og-image-open-market.png'},
      {property: 'og:image:type', content: 'image/png'},
      {property: 'og:image:width', content: '1200'},
      {property: 'og:image:height', content: '630'},
      {property: 'og:image:alt', content: 'Antseed, run your agents on your terms'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: '',
      logo: {
        alt: 'Antseed',
        src: 'logo-light.svg',
        srcDark: 'logo-dark.svg',
        width: 104,
        height: 36,
      },
      items: [
        {to: '/network', label: 'Network', position: 'left'},
        {
          // "Use it for" — audience pages. Rich rows (icon, title, one-line
          // description) via html items; styled in custom.css (.usecase).
          type: 'dropdown',
          label: 'Use it for',
          position: 'left',
          className: 'header-usecases',
          items: [
            {
              type: 'html',
              value:
                '<a class="usecase" href="/agents"><span class="usecase__icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="10" rx="3"/><path d="M10 6V3.5"/><circle cx="10" cy="2.5" r="1"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="11" r="1" fill="currentColor" stroke="none"/></svg></span><span class="usecase__body"><span class="usecase__title">For agents</span><span class="usecase__desc">Hermes, OpenClaw, Codex, your own</span></span></a>',
            },
            {
              type: 'html',
              value:
                '<a class="usecase" href="/coding"><span class="usecase__icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="3"/><path d="M6 9l2.5 2L6 13"/><path d="M10.5 13h3.5"/></svg></span><span class="usecase__body"><span class="usecase__title">For coding apps</span><span class="usecase__desc">Claude Code, Codex, OpenCode</span></span></a>',
            },
            {
              type: 'html',
              value:
                '<a class="usecase" href="/privacy"><span class="usecase__icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l6 2.5v4.5c0 3.6-2.6 6.3-6 7.5-3.4-1.2-6-3.9-6-7.5V5l6-2.5z"/><path d="M7.5 10l1.8 1.8L12.8 8"/></svg></span><span class="usecase__body"><span class="usecase__title">For privacy</span><span class="usecase__desc">No sign-up, runs on your machine</span></span></a>',
            },
          ],
        },
        {to: '/providers', label: 'Providers', position: 'left'},
        {to: '/ecosystem', label: 'Ecosystem', position: 'left'},
        {
          href: 'https://antseedstats.com/network',
          label: 'Live prices',
          position: 'left',
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'header-pricing-link',
        },
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          label: 'Docs',
          position: 'right',
          className: 'header-docs-link',
        },
        {to: '/blog', label: 'Blog', position: 'right', className: 'header-blog-link'},
        {
          href: 'https://github.com/antseed',
          'aria-label': 'GitHub',
          position: 'right',
          className: 'header-github-link',
        },
        {
          href: 'https://x.com/antseed',
          'aria-label': 'X',
          position: 'right',
          className: 'header-x-link',
        },
        {
          href: 'https://t.me/antseed',
          'aria-label': 'Telegram',
          position: 'right',
          className: 'header-telegram-link',
        },
        {
          // Custom item (src/theme/NavbarItem/DownloadNavbarItem.tsx): links
          // straight to the installer for the visitor's OS/arch, falling back
          // to the releases page when detection fails.
          type: 'custom-download',
          label: 'Download the AI VPN',
          position: 'right',
          className: 'header-download-link',
        },
      ],
    },
    prism: {
      theme: prismThemes.nightOwl,
      darkTheme: prismThemes.nightOwl,
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
