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
import { attachedGateway } from '../runtime/attach-only.js';
import { normalizeGatewayUrl } from './remote-url.js';
import { readStoredKey } from './rotate-keys.js';
import type { GatewayKeyMode, GatewayMode, GatewayPrivacyMode, GatewaySettings, GatewaySettingsPatch } from '../../shared/gateway-types.js';

export type { GatewayKeyMode, GatewayMode, GatewayPrivacyMode, GatewaySettings };

/** The key every surface uses in shared mode, and the chat's key in per-app mode. */
export const DESKTOP_KEY_SCOPE = 'desktop';

export type StoredGatewayKey = {
  /** Gateway key id (`key_…`); null for a pasted remote key we cannot look up. */
  id: string | null;
  label: string;
  secret: string;
};

type StoredFile = GatewaySettings & {
  /** Local keys by scope (`desktop`, or an app profile name), secrets encrypted. */
  localKeys: Record<string, { id: string | null; label: string; secretEnc: string }>;
  /** Ids of local keys the desktop revoked (apps that stopped using their own key), kept so their history still counts. */
  retiredKeyIds: string[];
  remoteKeyEnc: string | null;
};

const DEFAULTS: StoredFile = {
  mode: 'local',
  remoteUrl: null,
  keyMode: 'shared',
  privacy: 'anonymous',
  localKeys: {},
  retiredKeyIds: [],
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
      retiredKeyIds: Array.isArray(raw.retiredKeyIds) ? raw.retiredKeyIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [],
      remoteKeyEnc: typeof raw.remoteKeyEnc === 'string' ? raw.remoteKeyEnc : null,
    };
  } catch {
    cache = { ...DEFAULTS, localKeys: {}, retiredKeyIds: [] };
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
  const attached = attachedGateway();
  if (attached) return { mode: 'remote', remoteUrl: attached.url, keyMode, privacy };
  return { mode, remoteUrl, keyMode, privacy };
}

export function hasRemoteKey(): boolean {
  return attachedGateway() !== null || load().remoteKeyEnc !== null;
}

type StoredSettingsPatch = GatewaySettingsPatch & {
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

export function updateGatewaySettings(patch: StoredSettingsPatch): GatewaySettings {
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
  const attached = attachedGateway();
  if (attached) return attached.key;
  const enc = load().remoteKeyEnc;
  return enc ? decrypt(enc) : null;
}

/** Throws for a saved key whose secret can't be decrypted (see `readStoredKey`). */
export function getLocalKey(scope: string): StoredGatewayKey | null {
  return readStoredKey(load().localKeys[scope], decrypt);
}

/** A saved key's id and label, readable even when its secret is not. */
export function getLocalKeyEntry(scope: string): { id: string | null; label: string } | null {
  const entry = load().localKeys[scope];
  return entry ? { id: entry.id, label: entry.label } : null;
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

/**
 * Forgets a revoked key's secret but keeps its id, so the requests, spend and
 * savings it made still count in the desktop's totals.
 */
export function retireLocalKey(scope: string): void {
  const current = load();
  const entry = current.localKeys[scope];
  if (!entry) return;
  const localKeys = { ...current.localKeys };
  delete localKeys[scope];
  const retiredKeyIds = entry.id && !current.retiredKeyIds.includes(entry.id) ? [...current.retiredKeyIds, entry.id] : current.retiredKeyIds;
  save({ ...current, localKeys, retiredKeyIds });
}

export function listRetiredKeyIds(): string[] {
  return [...load().retiredKeyIds];
}

export function deleteLocalKey(scope: string): void {
  const current = load();
  if (!current.localKeys[scope]) return;
  const localKeys = { ...current.localKeys };
  delete localKeys[scope];
  save({ ...current, localKeys });
}
