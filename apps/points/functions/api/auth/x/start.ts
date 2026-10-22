import { origin, type Ctx } from '../../../_lib/env';
import { cookie, OAUTH_COOKIE, pkceChallenge, randomToken, sessionCookie, sign } from '../../../_lib/session';
import { upsertX } from '../../../_lib/store';
import { authorizeUrl } from '../../../_lib/x';

// GET /api/auth/x/start?return=/me — begins "Sign in with X".
export const onRequestGet = async ({ request, env }: Ctx) => {
  const back = safeReturn(new URL(request.url).searchParams.get('return'));

  if (env.DEV_FAKE_X === '1') {
    // Local development only: sign in as a test account without talking to X.
    const id = { xId: 'dev-1', handle: 'antseed_dev', name: 'Antseed Dev', avatar: '' };
    await upsertX(env.PROFILES, id);
    return new Response(null, { status: 302, headers: { location: back, 'set-cookie': await sessionCookie(id, env.SESSION_SECRET) } });
  }
  if (!env.X_CLIENT_ID) return new Response('X sign-in is not configured yet.', { status: 503 });

  const state = randomToken();
  const verifier = randomToken(48);
  const redirectUri = `${origin(request, env)}/api/auth/x/callback`;
  const pending = await sign({ state, verifier, back, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl({ clientId: env.X_CLIENT_ID, redirectUri, state, challenge: await pkceChallenge(verifier) }),
      'set-cookie': cookie(OAUTH_COOKIE, pending, 600),
    },
  });
};

/** Only same-site paths, so the login can't be used as an open redirect. */
export function safeReturn(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/me';
}
