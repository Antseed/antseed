/**
 * Docusaurus plugin for the hand-built marketing pages in static/site/ (the homepage, /network/, /providers/, /ants/, /colony/ and
 * /ecosystem/: plain HTML, CSS and JS, outside React; static/site/AGENTS.md is their guide):
 *   1. Registers a route for each page, so links to it pass the broken-link check, the sitemap lists it and a client-side
 *      navigation to it lands on a stub that reloads the URL from the host.
 *   2. Under `docusaurus start`, serves each page's HTML at its route (a dev-server middleware), so the dev server shows the real
 *      pages, read from disk on every request.
 *   3. After the build, writes each page's HTML over the stub's, carrying over what the site puts in every page's head (Google Tag
 *      Manager, both Search Console verifications, the Open Graph and Twitter tags, canonical, alternates, JSON-LD), so the static
 *      pages keep them. A tag the page sets itself (its title, description, og:title…) is the page's.
 * Each page's HTML is static/site/<folder>/index.html (PAGES below); its scripts, styles and images are under static/site/ and use
 * absolute /site/ paths. The build's copy of that file under /site/<folder>/ is removed, so each page is served once, at its route.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {LoadContext, Plugin} from '@docusaurus/types';

/** Each route and the static/site/ folder that holds its page. The homepage's folder, hero/, also holds the files every page shares. */
const PAGES: Record<string, string> = {
  '/': 'hero',
  '/network/': 'network',
  '/providers/': 'providers',
  '/ants/': 'ants',
  '/colony/': 'colony',
  '/ecosystem/': 'ecosystem',
};

/** Docusaurus' own head tags a static page has no use for: the app's styles and scripts, its theme and search keys. */
const SKIP_META = /^(viewport|generator|docusaurus_|docsearch:)/;

/** webpack's configuration, as configureWebpack takes and returns it (its types don't list devServer, which Docusaurus reads). */
type WebpackConfig = Parameters<NonNullable<Plugin['configureWebpack']>>[0];

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
      for (const route of Object.keys(PAGES)) actions.addRoute({path: route, component: '@site/src/components/StaticPage', exact: true});
    },
    configureWebpack(_config, isServer) {
      if (isServer || process.env.NODE_ENV === 'production') return {};
      const serve = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = (req.url ?? '').split('?')[0];
        const folder = req.method === 'GET' || req.method === 'HEAD' ? PAGES[url.endsWith('/') ? url : `${url}/`] : undefined;
        if (!folder) return next();
        try {
          const html = await fs.readFile(path.join(context.siteDir, 'static/site', folder, 'index.html'));
          res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
          res.end(req.method === 'HEAD' ? undefined : html);
        } catch {
          next();
        }
      };
      return ({
        devServer: {
          // Docusaurus merges this with its own devServer config through webpack-merge, which calls both setupMiddlewares
          // functions on the same list and concatenates what they return. So this one adds its middleware to the front of that
          // list and returns nothing new; returning the list too would put every middleware in it twice.
          setupMiddlewares: (middlewares: unknown[]) => {
            middlewares.unshift({name: 'static-pages', middleware: serve});
            return [];
          },
        },
      }) as WebpackConfig;
    },
    async postBuild({outDir}) {
      for (const [route, folder] of Object.entries(PAGES)) {
        const built = path.join(outDir, route, 'index.html');
        const stub = await fs.readFile(built, 'utf8');
        let page = await fs.readFile(path.join(context.siteDir, 'static/site', folder, 'index.html'), 'utf8');
        page = page.replace('</head>', `<!-- the site's head tags (plugins/static-pages.ts) -->\n${carriedHead(stub, page)}\n</head>`);
        const gtm = stub.match(/<noscript>(?:(?!<\/noscript>)[\s\S])*googletagmanager[\s\S]*?<\/noscript>/)?.[0];
        if (gtm) page = page.replace(/<body\b[^>]*>/, (body) => `${body}\n${gtm}`);
        await fs.writeFile(built, page);
        await fs.rm(path.join(outDir, 'site', folder, 'index.html'), {force: true});
      }
    },
  };
}
