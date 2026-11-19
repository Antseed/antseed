import type {Config, Plugin, PluginConfig, PluginModule} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {MOTION_GATE_SCRIPT} from './src/lib/motionGate';
import {PIXEL_FONT_FACE, PIXEL_FONT_URL} from './src/lib/pixelFont';
import integrationsPagesPlugin from './plugins/integrations-pages';
import docsSearchPlugin from './plugins/docs-search';
import antscanSnapshotPlugin from './plugins/antscan-snapshot';
import {prismLight, prismDark} from './src/lib/prismTheme';
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

/** A preview deployment (SITE_PREVIEW=1, e.g. new.antseed.com): kept out of search engines and analytics. */
const IS_PREVIEW = process.env.SITE_PREVIEW === '1';

/** Google Tag Manager container for antseed.com; none on previews. */
const GTM_CONTAINER_ID = IS_PREVIEW ? undefined : (process.env.GTM_CONTAINER_ID ?? 'GTM-NHCLBQQK');

/**
 * Typed explicitly: an inline array literal widens to `string | object`, which
 * does not satisfy PluginConfig's [name, options] tuple.
 */
const gtmPlugin: PluginConfig[] = GTM_CONTAINER_ID
  ? [['@docusaurus/plugin-google-tag-manager', {containerId: GTM_CONTAINER_ID}]]
  : [];

const config: Config = {
  title: 'Antseed',
  noIndex: IS_PREVIEW,
  tagline: 'The open intelligence network',
  favicon: 'site/assets/home/icons/ant-mark.svg',
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
          customCss: ['./src/styles/custom.css', './src/styles/tokens.css'],
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
          // The $ANTS page moved with the site redesign (a 301 in static/_redirects too).
          {from: '/ants-token', to: '/ants'},
          // Docs restructure: the apps, CLI and older posts link to these.
          {from: '/docs/guides/gateway-console', to: '/docs/gateway'},
          {from: '/docs/guides/gateway-server', to: '/docs/gateway/server'},
          {from: '/docs/guides/gateway-api-keys', to: '/docs/gateway/api'},
          {from: '/docs/guides/vpr', to: '/docs/desktop'},
          {from: '/docs/guides/verify-tee', to: '/docs/verify-tee'},
          {from: '/docs/guides/using-the-api', to: '/docs/api'},
          {from: '/docs/pricing', to: '/docs/api/routing'},
          {from: '/docs/guides/agents', to: '/docs/agents'},
          {from: '/docs/guides/public-tunnels', to: '/docs/tunnels'},
          {from: '/docs/config', to: '/docs/buyer-config'},
          {from: '/docs/guides/become-a-provider', to: '/docs/provide'},
          {from: '/docs/guides/tee-provider', to: '/docs/provide/tee'},
          {from: '/docs/guides/payments', to: '/docs/provide/payments'},
          {from: '/docs/guides/staking', to: '/docs/provide/staking'},
          {from: '/docs/guides/metrics', to: '/docs/provide/metrics'},
          {from: '/docs/guides/metadata-v12-upgrade', to: '/docs/metadata-v12-upgrade'},
          {from: '/docs/create-plugin', to: '/docs/provider-api'},
          {from: '/docs/metering', to: '/docs/payments'},
          {from: '/docs/protocol/legacy-emissions', to: '/docs/legacy-emissions'},
          {from: '/docs/protocol/recognized-usage', to: '/docs/recognized-usage'},
          {from: '/docs/protocol/reward-policies', to: '/docs/reward-policies'},
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
    // Docs search index for src/theme/SearchBar (the ⌘K modal).
    docsSearchPlugin,
    antscanSnapshotPlugin,
  ],

  headTags: [
    // Enables the hidden-until-revealed states before the first paint (src/lib/motionGate.ts), so pages never flash then hide.
    {tagName: 'script', attributes: {}, innerHTML: MOTION_GATE_SCRIPT},
    // Geist Pixel (the marketing titles): asked for while the head is read, and its face declared with the same URL (src/lib/pixelFont.ts).
    {tagName: 'link', attributes: {rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: 'anonymous', href: PIXEL_FONT_URL}},
    {tagName: 'style', attributes: {}, innerHTML: PIXEL_FONT_FACE},
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
            'https://github.com/Antseed/antseed',
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
          'Antseed Desktop',
          'Agent-to-agent commerce support',
        ],
        downloadUrl: 'https://github.com/Antseed/antseed/releases',
        softwareVersion: desktopPkg.version,
        license: 'https://github.com/Antseed/antseed/blob/main/LICENSE',
      }),
    },
  ],

  themeConfig: {
    announcementBar: {
      // A new id, so people who closed the previous bar still see this one.
      id: 'antseed-points-launch',
      content:
        '<a class="funding-announcement" href="https://antseedpoints.com" target="_blank" rel="noopener noreferrer"><strong>Antseed Points are live: get rewarded for using AI.</strong><span>Visit antseedpoints.com <span aria-hidden="true">↗</span></span></a>',
      // The dark band (--site-surface-dark), the same in both themes.
      backgroundColor: '#181d1b',
      textColor: '#eceee9',
      isCloseable: true,
    },
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'description', content: 'Antseed is the open intelligence network. Anyone can provide AI directly to buyers. Providers compete for every request, and you choose who serves you.'},
      {property: 'og:title', content: 'Antseed | The open intelligence network'},
      {property: 'og:description', content: 'Antseed is the open intelligence network. Anyone can provide AI directly to buyers. Providers compete for every request, and you choose who serves you.'},
      {property: 'og:type', content: 'website'},
      {property: 'og:site_name', content: 'Antseed'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:site', content: '@antseed'},
      // A JPEG under 250 KB, since WhatsApp leaves out a preview image that is too large.
      // No og:image:type: blog posts swap in their own PNG or JPEG, and one fixed type would be wrong for some.
      {name: 'twitter:image', content: 'https://antseed.com/og-image-network.jpg'},
      {property: 'og:image', content: 'https://antseed.com/og-image-network.jpg'},
      {property: 'og:image:width', content: '1200'},
      {property: 'og:image:height', content: '630'},
      {property: 'og:image:alt', content: 'Antseed, the open intelligence network'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    navbar: {
      // The site nav is a swizzled component (src/theme/Navbar, links in src/theme/Navbar/links.ts) that renders the design's markup
      // itself. These items only feed Docusaurus' mobile sidebar logic (it needs a non-empty list for its "Back to main menu"); keep
      // them in step with links.ts.
      title: '',
      items: [
        {to: '/network/', label: 'Network', position: 'left'},
        {to: '/providers/', label: 'Own provider', position: 'left'},
        {to: '/colony/', label: 'Join a Colony', position: 'left'},
        {to: '/ecosystem/', label: 'Ecosystem', position: 'left'},
        {href: 'https://antseedstats.com/network', label: 'Live prices', position: 'left'},
        {to: '/docs/', label: 'Docs', position: 'right'},
      ],
    },
    prism: {
      theme: prismLight,
      darkTheme: prismDark,
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
