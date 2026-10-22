import { fail, json, type Ctx } from '../../_lib/env';
import { getXByHandle } from '../../_lib/store';

// GET /api/profile/:handle — a public profile: the X account and the wallets it linked.
export const onRequestGet = async ({ env, params }: Ctx<'handle'>) => {
  const handle = String(params.handle || '');
  const rec = await getXByHandle(env.PROFILES, handle);
  if (!rec) return fail(404, 'No Antseed profile for that X account yet.');
  return json({ handle: rec.handle, name: rec.name, avatar: rec.avatar, addresses: rec.addresses });
};
