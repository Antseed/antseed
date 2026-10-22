import { json, type Ctx } from '../_lib/env';
import { sessionFrom } from '../_lib/session';
import { getX } from '../_lib/store';

// GET /api/me — who is signed in with X, and which wallets they've linked.
export const onRequestGet = async ({ request, env }: Ctx) => {
  const s = await sessionFrom(request, env.SESSION_SECRET);
  if (!s) return json({ signedIn: false, xEnabled: Boolean(env.X_CLIENT_ID) || env.DEV_FAKE_X === '1' });
  const rec = await getX(env.PROFILES, s.xId);
  return json({ signedIn: true, xEnabled: true, xId: s.xId, handle: s.handle, name: s.name, avatar: s.avatar, addresses: rec?.addresses ?? [] });
};
