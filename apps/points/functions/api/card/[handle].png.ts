import { fail, type Ctx } from '../../_lib/env';
import { loadCardData } from '../../_lib/card';
import { renderCardPng } from '../../_lib/cardImage';
import { getXByHandle } from '../../_lib/store';

const MAX_AGE = 300;

// GET /api/card/:handle.png — the profile's share card as a PNG, for og:image.
// Rendering takes real CPU, so each card is kept in the edge cache for 5 minutes.
export const onRequestGet = async ({ request, env, params, waitUntil }: Ctx<'handle'>) => {
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const rec = await getXByHandle(env.PROFILES, String(params.handle || ''));
  if (!rec) return fail(404, 'No Antseed profile for that X account yet.');
  let png: Uint8Array;
  try {
    png = await renderCardPng(await loadCardData(rec));
  } catch (e) {
    console.error('share card failed', rec.handle, e);
    return new Response('The share card is unavailable right now.', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '60' } });
  }
  const res = new Response(png as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${MAX_AGE}` },
  });
  const put = cache.put(request, res.clone()).catch(() => undefined);
  if (waitUntil) waitUntil(put);
  else await put;
  return res;
};
