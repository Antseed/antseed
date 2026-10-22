// Cloudflare Pages Functions environment for Antseed Points.
// Secrets (set with `wrangler pages secret put`): X_CLIENT_SECRET, SESSION_SECRET.
// Vars (wrangler.toml): X_CLIENT_ID, PUBLIC_URL, BASE_RPC_URL, DEV_FAKE_X.

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The Pages static-asset binding: serves the built files in dist/. */
export interface Assets {
  fetch(input: Request | string): Promise<Response>;
}

export interface Env {
  PROFILES: KV;
  ASSETS: Assets;
  SESSION_SECRET: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  /** Origin the site is served from, e.g. https://points.example.com (used for the X callback URL). */
  PUBLIC_URL?: string;
  BASE_RPC_URL?: string;
  /** "1" only for local development: skips X and signs you in as a test account. */
  DEV_FAKE_X?: string;
}

export interface Ctx<P extends string = string> {
  request: Request;
  env: Env;
  params: Record<P, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (status: number, error: string) => json({ error }, status);

export function origin(request: Request, env: Env): string {
  return (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, '');
}
