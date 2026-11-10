import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ATTACH_ONLY_ENV = 'ANTSEED_DESKTOP_ATTACH_ONLY';
export const CONNECT_DATA_DIR_ENV = 'ANTSEED_DESKTOP_CONNECT_DATA_DIR';

export const ATTACH_ONLY_RUNTIME_DISABLED =
  'This desktop is attached to an isolated testbench. Start the testbench buyer first; starting another runtime is disabled.';

export function isAttachOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ATTACH_ONLY_ENV] === '1';
}

// A full desktop (its own buyer, wallet and plugins) launched by the testbench
// with HOME pointed at a throwaway profile. It runs next to the developer's
// real desktop, so it must not touch machine-wide state: the login keychain
// (a mock keychain encrypts the profile identity instead) or OS proxy settings.
export const ISOLATED_PROFILE_ENV = 'ANTSEED_DESKTOP_ISOLATED_PROFILE';

export function isIsolatedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ISOLATED_PROFILE_ENV] === '1';
}

/** True for any testbench-launched desktop: OS proxy settings and connected-app changes are off. */
export function machineWideChangesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAttachOnly(env) || isIsolatedProfile(env);
}

/**
 * Chromium switches that keep a testbench desktop's secret storage away from the
 * developer's real keychain. Both testbench kinds use the mock keychain on macOS
 * and the basic password store on Linux and Windows, so they never reach the
 * real keyring (GNOME Keyring or KWallet via D-Bus does not follow HOME).
 * Attach-only never encrypts a wallet: it reads the testbench buyer's key from
 * its data dir. The isolated profile encrypts its own wallet with that basic
 * store (see usesPlainTextSecretStore); the testbench stops before launching a
 * profile whose identity.enc an older version encrypted with the keyring.
 */
export function secretStoreSwitches(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Array<[string] | [string, string]> {
  if (!machineWideChangesDisabled(env)) return [];
  const switches: Array<[string] | [string, string]> = [['use-mock-keychain']];
  if (platform !== 'darwin') switches.push(['password-store', 'basic']);
  return switches;
}

/**
 * Electron reports encryption as unavailable on Linux's basic store unless plain-text
 * encryption is allowed. The isolated profile encrypts its throwaway test wallet there,
 * so it allows it; a normal desktop and attach-only keep Electron's default.
 */
export function usesPlainTextSecretStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && isIsolatedProfile(env) && !isAttachOnly(env);
}

export function resolveBuyerStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const connectDataDir = env[CONNECT_DATA_DIR_ENV]?.trim();
  if (!connectDataDir) return path.join(home, '.antseed');
  if (connectDataDir.startsWith('~/')) return path.join(home, connectDataDir.slice(2));
  return path.resolve(connectDataDir);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Routing keys the testbench harness owns: they keep the buyer on the testbench's own sellers. */
const TESTBENCH_ROUTING_KEYS = ['allowedPeerIds', 'blockedPeerIds'] as const;

// The renderer syncs its whole routingPreferences object at launch, and the
// config merge replaces that object wholesale. In attach-only mode the testbench
// owns the peer allow/block lists (they confine routing to its sellers), so
// those are kept from the existing file. Its sellers are brand new and have
// no trust score, so the trust floor stays at 0 as well. Other preferences
// come from the UI, so desktop routing settings can still be tested.
export function preserveTestbenchRouting(
  config: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  if (!isAttachOnly(env)) return config;
  const buyer = asRecord(config['buyer']);
  const routing = asRecord(buyer?.['routingPreferences']);
  if (!buyer || !routing) return config;
  const owned = asRecord(asRecord(existing['buyer'])?.['routingPreferences']) ?? {};
  const kept: Record<string, unknown> = {};
  for (const key of TESTBENCH_ROUTING_KEYS) {
    if (key in owned) kept[key] = owned[key];
  }
  return {
    ...config,
    buyer: { ...buyer, routingPreferences: { ...routing, ...kept, minTrustScore: 0 } },
  };
}

export async function readAttachOnlyIdentityHex(dataDir: string): Promise<string> {
  const hex = (await readFile(path.join(dataDir, 'identity.key'), 'utf-8')).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`unexpected identity format (length ${hex.length})`);
  return hex;
}
