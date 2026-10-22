import { fail, json, type Ctx } from '../_lib/env';
import { getLink } from '../_lib/store';

// GET /api/profiles?a=0x…,0x… — public X names for up to 100 wallets (used by the leaderboard).
export const onRequestGet = async ({ request, env }: Ctx) => {
  const list = (new URL(request.url).searchParams.get('a') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  if (list.length > 100) return fail(400, 'At most 100 addresses.');
  const out: Record<string, { handle: string; name: string; avatar: string }> = {};
  await Promise.all(
    Array.from(new Set(list)).map(async (a) => {
      const l = await getLink(env.PROFILES, a);
      if (l) out[a] = { handle: l.handle, name: l.name, avatar: l.avatar };
    }),
  );
  return json(out);
};
