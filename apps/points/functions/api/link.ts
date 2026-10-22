import { fail, json, type Ctx } from '../_lib/env';
import { sessionFrom } from '../_lib/session';
import { link, unlink } from '../_lib/store';
import { chainOperatorReader, checkLink, type LinkRequest } from '../_lib/verify';

// POST /api/link {address, issuedAt, signature} — attach a wallet to the signed-in X account.
export const onRequestPost = async ({ request, env }: Ctx) => {
  const s = await sessionFrom(request, env.SESSION_SECRET);
  if (!s) return fail(401, 'Sign in with X first.');
  let body: LinkRequest;
  try {
    body = (await request.json()) as LinkRequest;
  } catch {
    return fail(400, 'Bad request.');
  }
  const check = await checkLink(body, s, chainOperatorReader(env.BASE_RPC_URL));
  if (!check.ok) return fail(403, check.error);
  return json({ ok: true, link: await link(env.PROFILES, s, body.address, check.signer) });
};

// DELETE /api/link {address} — remove one of your own links.
export const onRequestDelete = async ({ request, env }: Ctx) => {
  const s = await sessionFrom(request, env.SESSION_SECRET);
  if (!s) return fail(401, 'Sign in with X first.');
  const { address } = (await request.json().catch(() => ({}))) as { address?: string };
  if (!address) return fail(400, 'Bad request.');
  return (await unlink(env.PROFILES, s.xId, address)) ? json({ ok: true }) : fail(404, 'That wallet is not linked to your account.');
};
