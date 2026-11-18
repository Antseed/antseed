/**
 * Docusaurus plugin for the hand-built marketing pages in static/site/ (the homepage, /network/, /providers/, /ants/, /colony/ and /ecosystem/, made by AstraOS as plain
 * HTML, CSS and JS, outside React):
 *   1. Registers a route for each page, so links to it pass the broken-link check, the sitemap lists it and a client-side
 *      navigation to it lands on a stub that reloads the URL from the host.
 *   2. After the build, writes each page's HTML over the stub's, carrying over what the site puts in every page's head (Google Tag
 *      Manager, both Search Console verifications, the Open Graph and Twitter tags, canonical, alternates, JSON-LD), so the static
 *      pages keep them. A tag the page sets itself (its title, description, og:title…) is the page's.
 * Each page's HTML is static/site/pages/<route>/index.html; its scripts, styles and images are under static/site/ and use
 * absolute /site/ paths.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type {LoadContext, Plugin} from '@docusaurus/types';

const PAGES = ['/', '/network/', '/providers/', '/ants/', '/colony/', '/ecosystem/'];

/** Docusaurus' own head tags a static page has no use for: the app's styles and scripts, its theme and search keys. */
const SKIP_META = /^(viewport|generator|docusaurus_|docsearch:)/;

const keyOf = (tag: string) => tag.match(/\b(?:name|property)="([^"]+)"/)?.[1];

function carriedHead(stub: string, page: string): string {
  const head = stub.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  const own = new Set([...page.matchAll(/<meta\b[^>]*>/g)].map((m) => keyOf(m[0])).filter(Boolean));
  const tags: string[] = [];
  for (const m of head.matchAll(/<meta\b[^>]*>/g)) {
    const key = keyOf(m[0]);
    if (!key || SKIP_META.test(key) || (own.has(key) && key !== 'google-site-verification')) continue;
    tags.push(m[0]);
  }
  for (const m of head.matchAll(/<link\b[^>]*>/g)) {
    if (/rel="(canonical|alternate)"/.test(m[0]) || /googletagmanager/.test(m[0])) tags.push(m[0]);
  }
  for (const m of head.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)) {
    if (/application\/ld\+json|dataLayer|googletagmanager/.test(m[0])) tags.push(m[0]);
  }
  return tags.join('\n');
}

export default function staticPagesPlugin(context: LoadContext): Plugin {
  return {
    name: 'static-pages',
    async contentLoaded({actions}) {
      for (const route of PAGES) actions.addRoute({path: route, component: '@site/src/components/StaticPage', exact: true});
    },
    async postBuild({outDir}) {
      for (const route of PAGES) {
        const built = path.join(outDir, route, 'index.html');
        const stub = await fs.readFile(built, 'utf8');
        let page = await fs.readFile(path.join(context.siteDir, 'static/site/pages', route, 'index.html'), 'utf8');
        page = page.replace('</head>', `<!-- the site's head tags (plugins/static-pages.ts) -->\n${carriedHead(stub, page)}\n</head>`);
        const gtm = stub.match(/<noscript>(?:(?!<\/noscript>)[\s\S])*googletagmanager[\s\S]*?<\/noscript>/)?.[0];
        if (gtm) page = page.replace(/<body\b[^>]*>/, (body) => `${body}\n${gtm}`);
        await fs.writeFile(built, page);
      }
    },
  };
}
