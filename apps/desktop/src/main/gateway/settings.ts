/**
 * Which gateway the desktop talks to, and the API keys it uses there.
 *
 * Local mode runs `antseed gateway` on this machine (same data dir and wallet
 * the buyer always used); remote mode points at a gateway someone else runs,
 * with a key they issued. Key secrets are encrypted with safeStorage — the
 * file on disk only ever holds ciphertext.
 */
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { normalizeGatewayUrl } from './remote-url.js';

export type GatewayMode = 'local' | 'remote';
/** `shared`: one key for the chat and every app. `per-app`: a key per app, so the gateway shows usage per app. */
export type GatewayKeyMode = 'shared' | 'per-app';

/**
 * `anonymous`: any seller the routing policy allows (sellers see a
 * pseudonymous address). `private`: TEE sellers only, through the desktop
 * key's owner routing policy.
 */
export type GatewayPrivacyMode = 'anonymous' | 'private';

/** The key every surface uses in shared mode, and the chat's key in per-app mode. */
export const DESKTOP_KEY_SCOPE = 'desktop';

export type StoredGatewayKey = {
  /** Gateway key id (`key_…`); null for a pasted remote key we cannot look up. */
  id: string | null;
  label: string;
  secret: string;
};

export type GatewaySettings = {
  mode: GatewayMode;
  remoteUrl: string | null;
  keyMode: GatewayKeyMode;
  privacy: GatewayPrivacyMode;
};

type StoredFile = GatewaySettings & {
  /** Local keys by scope (`desktop`, or an app profile name), secrets encrypted. */
  localKeys: Record<string, { id: string | null; label: string; secretEnc: string }>;
  remoteKeyEnc: string | null;
};

const DEFAULTS: StoredFile = {
  mode: 'local',
  remoteUrl: null,
  keyMode: 'shared',
  privacy: 'anonymous',
  localKeys: {},
  remoteKeyEnc: null,
};

/** desktop-gateway.json: settings and the safeStorage-encrypted key secrets. */
export function gatewaySettingsPath(): string {
  return settingsPath();
}

function settingsPath(): string {
  return path.join(resolveConnectDataDir(), 'desktop-gateway.json');
}

function encrypt(secret: string): string {
  return safeStorage.encryptString(secret).toString('base64');
}

function decrypt(value: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

let cache: StoredFile | null = null;

function load(): StoredFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<StoredFile>;
    cache = {
      mode: raw.mode === 'remote' ? 'remote' : 'local',
      remoteUrl: typeof raw.remoteUrl === 'string' && raw.remoteUrl ? raw.remoteUrl : null,
      keyMode: raw.keyMode === 'per-app' ? 'per-app' : 'shared',
      privacy: raw.privacy === 'private' ? 'private' : 'anonymous',
      localKeys: raw.localKeys && typeof raw.localKeys === 'object' ? raw.localKeys : {},
      remoteKeyEnc: typeof raw.remoteKeyEnc === 'string' ? raw.remoteKeyEnc : null,
    };
  } catch {
    cache = { ...DEFAULTS, localKeys: {} };
  }
  return cache;
}

function save(next: StoredFile): void {
  cache = next;
  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function getGatewaySettings(): GatewaySettings {
  const { mode, remoteUrl, keyMode, privacy } = load();
  return { mode, remoteUrl, keyMode, privacy };
}

export function hasRemoteKey(): boolean {
  return load().remoteKeyEnc !== null;
}

type GatewaySettingsPatch = {
  mode?: GatewayMode;
  remoteUrl?: string | null;
  remoteApiKey?: string | null;
  keyMode?: GatewayKeyMode;
  privacy?: GatewayPrivacyMode;
};

/**
 * The remote gateway these settings would use, or null when they aren't remote.
 * Changes nothing, so the switch can be checked before anything is saved or
 * stopped. A saved key was issued by the saved gateway: it never goes to another.
 */
export function remoteGatewayFor(patch: GatewaySettingsPatch): { origin: string; apiKey: string } | null {
  const current = load();
  if ((patch.mode ?? current.mode) !== 'remote') return null;
  const origin = patch.remoteUrl !== undefined
    ? (patch.remoteUrl ? normalizeGatewayUrl(patch.remoteUrl) : null)
    : current.remoteUrl;
  if (!origin) throw new Error('Enter the gateway URL');
  const newKey = patch.remoteApiKey?.trim();
  const apiKey = newKey || (patch.remoteApiKey === undefined && origin === current.remoteUrl ? getRemoteKey() : null);
  if (!apiKey) throw new Error('Enter the API key for this gateway');
  return { origin, apiKey };
}

export function updateGatewaySettings(patch: GatewaySettingsPatch): GatewaySettings {
  const current = load();
  const next: StoredFile = { ...current, localKeys: { ...current.localKeys } };
  if (patch.mode) next.mode = patch.mode;
  if (patch.keyMode) next.keyMode = patch.keyMode;
  if (patch.privacy) next.privacy = patch.privacy;
  if (patch.remoteUrl !== undefined) next.remoteUrl = patch.remoteUrl ? normalizeGatewayUrl(patch.remoteUrl) : null;
  if (patch.remoteApiKey !== undefined) {
    const key = patch.remoteApiKey?.trim() ?? '';
    next.remoteKeyEnc = key ? encrypt(key) : null;
  }
  if (next.mode === 'remote' && !next.remoteUrl) throw new Error('Enter the gateway URL');
  save(next);
  return getGatewaySettings();
}

export function getRemoteKey(): string | null {
  const enc = load().remoteKeyEnc;
  return enc ? decrypt(enc) : null;
}

export function getLocalKey(scope: string): StoredGatewayKey | null {
  const entry = load().localKeys[scope];
  if (!entry) return null;
  const secret = decrypt(entry.secretEnc);
  return secret ? { id: entry.id, label: entry.label, secret } : null;
}

export function listLocalKeys(): Array<{ scope: string; id: string | null; label: string }> {
  return Object.entries(load().localKeys).map(([scope, entry]) => ({ scope, id: entry.id, label: entry.label }));
}

export function setLocalKey(scope: string, key: StoredGatewayKey): void {
  const current = load();
  save({
    ...current,
    localKeys: { ...current.localKeys, [scope]: { id: key.id, label: key.label, secretEnc: encrypt(key.secret) } },
  });
}

export function deleteLocalKey(scope: string): void {
  const current = load();
  if (!current.localKeys[scope]) return;
  const localKeys = { ...current.localKeys };
  delete localKeys[scope];
  save({ ...current, localKeys });
}
