import { json } from '../_lib/env';
import { cookie, SESSION_COOKIE } from '../_lib/session';

// POST /api/logout — signs out of X on this site (links stay; they're public).
export const onRequestPost = async () => json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
