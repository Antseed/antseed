import { origin, type Ctx } from '../../../_lib/env';
import { cookie, OAUTH_COOKIE, readCookie, sessionCookie, verify } from '../../../_lib/session';
import { upsertX } from '../../../_lib/store';
import { exchangeCode, fetchMe } from '../../../_lib/x';

// GET /api/auth/x/callback?code=…&state=… — X sends the user back here.
export const onRequestGet = async ({ request, env }: Ctx) => {
  const url = new URL(request.url);
  const pending = await verify<{ state: string; verifier: string; back: string; exp: number }>(readCookie(request, OAUTH_COOKIE), env.SESSION_SECRET);
  const fail = (reason: string) =>
    new Response(null, { status: 302, headers: { location: `/me?signin=failed&reason=${encodeURIComponent(reason)}`, 'set-cookie': cookie(OAUTH_COOKIE, '', 0) } });

  if (url.searchParams.get('error')) return fail('cancelled');
  if (!pending || pending.state !== url.searchParams.get('state')) return fail('expired');
  const code = url.searchParams.get('code');
  if (!code || !env.X_CLIENT_ID) return fail('missing');

  try {
    const token = await exchangeCode({
      clientId: env.X_CLIENT_ID,
      clientSecret: env.X_CLIENT_SECRET,
      code,
      redirectUri: `${origin(request, env)}/api/auth/x/callback`,
      verifier: pending.verifier,
    });
    const id = await fetchMe(token);
    await upsertX(env.PROFILES, id);
    const headers = new Headers({ location: pending.back || '/me' });
    headers.append('set-cookie', await sessionCookie(id, env.SESSION_SECRET));
    headers.append('set-cookie', cookie(OAUTH_COOKIE, '', 0));
    return new Response(null, { status: 302, headers });
  } catch {
    return fail('x');
  }
};
