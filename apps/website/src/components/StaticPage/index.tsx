import {useEffect, type JSX} from 'react';
import Layout from '@theme/Layout';

/** The route stub of a static page (plugins/static-pages.ts). Built, it gives the site's head tags that the plugin carries into the
 * static page written over it. Reached by a client-side navigation, it reloads the URL so the host (or, under `docusaurus start`,
 * the plugin's dev middleware) serves that static page. A reload that lands on the stub again means nothing serves the page: it
 * stops there instead of reloading forever (a reload within 5 s of the last one, on the same URL). */
const KEY = 'static-page-reload';

export default function StaticPage(): JSX.Element {
  useEffect(() => {
    const here = window.location.pathname, now = Date.now();
    let again = false;
    try {
      const last = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {path?: string; at?: number} | null;
      again = last?.path === here && now - (last.at ?? 0) < 5000;
      sessionStorage.setItem(KEY, JSON.stringify({path: here, at: now}));
    } catch {}
    if (!again) window.location.reload();
  }, []);
  return <Layout><main style={{minHeight: '100vh'}} /></Layout>;
}
