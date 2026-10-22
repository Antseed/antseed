# Antseed Points: what the site needs from a backend

The site is a static build (`npm run build` → `dist/`). Everything about points,
providers, staking, claims and the leaderboard numbers is read in the visitor's
browser from Antscan and Base. **Only the X features call a backend**, at `/api/*`
on the same origin. With no backend, the X parts hide themselves and the rest
of the site works as normal.

The code in `functions/` is a **local stand-in** for that backend so the X
features can be built and tested on a laptop. It is not meant to be deployed as
it is: it keeps wallet ↔ X links in a key-value store, and the foundation can't
store user data.

## The rule for a real backend

- **Store nothing about users.** No database, no files, no logs of handles or
  wallets.
- A small stateless server is still needed: X requires a client secret to finish
  a login, and that secret can't ship in a public web page.
- Where the wallet ↔ X links live then has to change. Suggested: the server
  checks the login and the wallet signature, returns a signed statement
  ("wallet 0x… is @handle"), and the person publishes it on Base as an EAS
  attestation from their own wallet (about a cent of gas). The leaderboard
  reads those attestations from the chain. The foundation keeps nothing.

## Endpoints the site calls

All JSON, same origin, cookies sent. Code: `src/lib/social.ts`.

| Method & path | Does | Returns |
| --- | --- | --- |
| `GET /api/auth/x/start?return=/path` | Starts X OAuth 2.0 (PKCE). Only same-site return paths. | 302 to X |
| `GET /api/auth/x/callback` | Finishes the login, sets the sign-in cookie | 302 to `return`, or `/me?signin=failed&reason=…` |
| `GET /api/me` | Who is signed in | `{ signedIn, xEnabled, xId?, handle?, name?, avatar?, addresses? }` (`xEnabled: false` hides the X UI) |
| `POST /api/logout` | Clears the cookie | `{ ok: true }` |
| `POST /api/link` `{ address, issuedAt, signature }` | Links a wallet to the signed-in X account | `{ ok: true }`, or `{ error }` with 401/403 |
| `DELETE /api/link` `{ address }` | Unlinks one of your wallets | `{ ok: true }` |
| `GET /api/profiles?a=0x…,0x…` (≤100) | X names for leaderboard wallets | `{ "<address>": { handle, name, avatar } }` |
| `GET /api/profile/:handle` | A public profile | `{ handle, name, avatar, addresses[] }`, or 404 |
| `GET /u/:handle` | The page itself, with link-preview tags for X | HTML |
| `GET /api/card/:handle.png` | The 1200×630 share image used in the preview | PNG |

With on-chain links, `/api/profiles` and `/api/profile/:handle` can become
chain reads in the browser, and `POST /api/link` returns the signed statement to
publish instead of saving anything.

## Linking rules (keep these)

- The wallet signs the exact text from `functions/_lib/message.ts` (shared with
  the site). It names the X handle and id, the wallet and the time.
- A valid signer is the wallet itself **or its reward wallet**, which is
  `Deposits.getOperator(wallet)` on Base (the only wallet that can claim its ANTS).
- Signatures expire after 10 minutes.
- Checked in `functions/_lib/verify.ts`. Tests: `functions/_lib/backend.test.ts`.

## X developer app

- console.x.com, on the Antseed X account. OAuth 2.0, type **Web App**
  (confidential), permissions **Read**, scopes `users.read tweet.read`.
- Callback URL: `https://<domain>/api/auth/x/callback` (exact match).
- X is pay-per-use: each login reads one user, $0.01, deduplicated per user per
  day. Keep credits topped up or login stops working.
- Config: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `SESSION_SECRET` (cookie signing key),
  `PUBLIC_URL`, `BASE_RPC_URL`.

## Running it locally

```bash
npm run build
npx wrangler pages dev dist --port 8788 --ip 127.0.0.1 \
  --binding SESSION_SECRET=dev-secret-not-for-production DEV_FAKE_X=1
```

`DEV_FAKE_X=1` signs you in as a test X account without talking to X. Wrangler
only simulates the server here; no Cloudflare account is involved.
