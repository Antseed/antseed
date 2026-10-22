import { origin, type Ctx } from '../_lib/env';
import { injectMeta, profileMeta } from '../_lib/og';
import { getXByHandle } from '../_lib/store';

// GET /u/:handle — the SPA's index.html, with link-preview tags for that profile
// so a profile link posted on X shows the share card. Unknown handles (and any
// KV hiccup) get the plain page; the app then shows its own "no profile" state.
export const onRequestGet = async ({ request, env, params }: Ctx<'handle'>) => {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  const rec = await getXByHandle(env.PROFILES, String(params.handle || '')).catch(() => null);
  if (!rec || !page.ok) return page;
  const html = injectMeta(await page.text(), profileMeta(rec, origin(request, env)));
  const headers = new Headers(page.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: 200, headers });
};
