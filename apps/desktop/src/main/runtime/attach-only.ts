import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ATTACH_ONLY_ENV = 'ANTSEED_DESKTOP_ATTACH_ONLY';
export const CONNECT_DATA_DIR_ENV = 'ANTSEED_DESKTOP_CONNECT_DATA_DIR';

export function isAttachOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ATTACH_ONLY_ENV] === '1';
}

// A full desktop (its own buyer, wallet and plugins) launched by the sandbox
// with HOME pointed at a throwaway profile. It runs next to the developer's
// real desktop, so it must not touch machine-wide state: the login keychain
// (a mock keychain encrypts the profile identity instead) or OS proxy settings.
export const ISOLATED_PROFILE_ENV = 'ANTSEED_DESKTOP_ISOLATED_PROFILE';

export function isIsolatedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ISOLATED_PROFILE_ENV] === '1';
}

/** True for any sandbox-launched desktop: OS proxy settings and connected-app changes are off. */
export function machineWideChangesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAttachOnly(env) || isIsolatedProfile(env);
}

export function resolveBuyerStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const connectDataDir = env[CONNECT_DATA_DIR_ENV]?.trim();
  if (!connectDataDir) return path.join(home, '.antseed');
  if (connectDataDir.startsWith('~/')) return path.join(home, connectDataDir.slice(2));
  return path.resolve(connectDataDir);
}

// The isolated sandbox seller is brand new on the fork, so its trust score is
// far below the desktop default floor. The sandbox harness owns that floor;
// renderer preference syncs must not raise it and hide the only seller.
export function preserveSandboxTrustFloor(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  if (!isAttachOnly(env)) return config;
  const buyer = config['buyer'];
  if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) return config;
  const routing = (buyer as Record<string, unknown>)['routingPreferences'];
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return config;
  return {
    ...config,
    buyer: { ...(buyer as Record<string, unknown>), routingPreferences: { ...(routing as Record<string, unknown>), minTrustScore: 0 } },
  };
}

export async function readAttachOnlyIdentityHex(dataDir: string): Promise<string> {
  const hex = (await readFile(path.join(dataDir, 'identity.key'), 'utf-8')).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`unexpected identity format (length ${hex.length})`);
  return hex;
}
