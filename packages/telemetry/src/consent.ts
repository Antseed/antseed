/**
 * Whether a process may send telemetry. One rule for every product, highest
 * first:
 * 1. `DO_NOT_TRACK=1`, or `ANTSEED_TELEMETRY=0|false|no|off`: always off.
 * 2. CI (`CI` set and not false): off.
 * 3. No PostHog project configured (source builds bake none): off.
 * 4. The persisted choice (`telemetry.enabled` in the config file, or the
 *    desktop's own preference), when set.
 * 5. The product default: on, with an opt-out.
 */

export const TELEMETRY_ENV = 'ANTSEED_TELEMETRY';
export const DO_NOT_TRACK_ENV = 'DO_NOT_TRACK';
export const POSTHOG_HOST_ENV = 'POSTHOG_HOST';
export const POSTHOG_PROJECT_API_KEY_ENV = 'POSTHOG_PROJECT_API_KEY';

export type ConsentDecision =
  | { enabled: true }
  | { enabled: false; reason: 'do_not_track' | 'env_disabled' | 'ci' | 'not_configured' | 'user_disabled' | 'dev_build' };

const FALSY = new Set(['0', 'false', 'no', 'off']);
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envFlag(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (FALSY.has(normalized)) return false;
  if (TRUTHY.has(normalized)) return true;
  return null;
}

export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const ci = env['CI']?.trim().toLowerCase();
  return Boolean(ci) && ci !== '0' && ci !== 'false';
}

export type PostHogConfig = { host: string; projectApiKey: string };

/** Runtime env wins over baked values; only HTTPS hosts are accepted. */
export function resolvePostHogConfig(
  env: NodeJS.ProcessEnv,
  baked: { host: string | null; projectApiKey: string | null },
): PostHogConfig | null {
  const host = (env[POSTHOG_HOST_ENV]?.trim() || baked.host || '').replace(/\/+$/, '');
  const projectApiKey = env[POSTHOG_PROJECT_API_KEY_ENV]?.trim() || baked.projectApiKey || '';
  if (!host || !projectApiKey) return null;
  try {
    if (new URL(host).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { host, projectApiKey };
}

export function resolveConsent(input: {
  env: NodeJS.ProcessEnv;
  configured: boolean;
  /** The persisted user choice; undefined when never set. */
  persisted?: boolean;
  isDev?: boolean;
}): ConsentDecision {
  const { env } = input;
  if (envFlag(env[DO_NOT_TRACK_ENV]) === true) return { enabled: false, reason: 'do_not_track' };
  if (envFlag(env[TELEMETRY_ENV]) === false) return { enabled: false, reason: 'env_disabled' };
  if (input.isDev) return { enabled: false, reason: 'dev_build' };
  if (isCiEnvironment(env)) return { enabled: false, reason: 'ci' };
  if (!input.configured) return { enabled: false, reason: 'not_configured' };
  if (input.persisted === false) return { enabled: false, reason: 'user_disabled' };
  return { enabled: true };
}
