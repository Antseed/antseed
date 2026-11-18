import {useEffect, type JSX} from 'react';
import Layout from '@theme/Layout';

/** The route stub of a static page (plugins/static-pages.ts). Built, it gives the site's head tags that the plugin carries into the
 * static page written over it; reached by a client-side navigation, it reloads the URL so the host serves that static page. */
export default function StaticPage(): JSX.Element {
  useEffect(() => { window.location.reload(); }, []);
  return <Layout><main style={{minHeight: '100vh'}} /></Layout>;
}
