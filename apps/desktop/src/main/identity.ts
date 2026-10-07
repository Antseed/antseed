// ── Secure Identity (Electron safeStorage) ──
// Uses Electron's safeStorage API to encrypt the identity private key at rest.
// The encrypted blob is stored in a file; the OS keychain protects the encryption key.

import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, unlink, rename, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Identity } from '@antseed/node';
import { bytesToHex, identityFromPrivateKeyHex } from '@antseed/node';
import { CONNECT_DATA_DIR_ENV, isAttachOnly, readAttachOnlyIdentityHex } from './runtime/attach-only.js';

const ENCRYPTED_IDENTITY_PATH = path.join(homedir(), '.antseed', 'identity.enc');
const PLAINTEXT_IDENTITY_PATH = path.join(homedir(), '.antseed', 'identity.key');

export function hasStoredIdentity(): boolean {
  return existsSync(ENCRYPTED_IDENTITY_PATH) || existsSync(PLAINTEXT_IDENTITY_PATH);
}

let secureIdentity: Identity | null = null;
let secureIdentityPromise: Promise<void> | null = null;
let _safeStorageReady: boolean | null = null;

function safeStorageAvailable(): boolean {
  if (_safeStorageReady === null) {
    try {
      _safeStorageReady = safeStorage.isEncryptionAvailable();
    } catch {
      _safeStorageReady = false;
    }
  }
  return _safeStorageReady;
}

function identityFromHex(hex: string): Identity {
  return identityFromPrivateKeyHex(hex);
}

// Returned when identity.enc exists but cannot be decrypted with the current
// safeStorage key. On macOS, safeStorage's encryption key lives in a keychain
// entry named after the app's runtime name set via app.setName() ("<name> Safe
// Storage" — INTERNAL_APP_NAME in main.ts, NOT the electron-builder
// productName). Changing that runtime name rotates the key and makes a
// previously-written identity.enc undecryptable. This MUST be distinguished
// from "file absent" — treating it as absent and creating a fresh identity
// would silently destroy the signer key.
const UNDECRYPTABLE = Symbol('undecryptable-identity');

async function loadEncryptedIdentity(): Promise<string | null | typeof UNDECRYPTABLE> {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(ENCRYPTED_IDENTITY_PATH);
  } catch {
    return null; // No file — safe to migrate/create fresh.
  }
  try {
    const decrypted = safeStorage.decryptString(encrypted);
    const trimmed = decrypted.trim();
    // An empty-but-decryptable file holds no key, so it is safe to overwrite.
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // File present but undecryptable. Do NOT overwrite blindly.
    return UNDECRYPTABLE;
  }
}

// Preserve an undecryptable identity.enc before it gets overwritten, so the
// original ciphertext can still be recovered later (e.g. by restoring the
// original app.setName() value, which brings back the matching keychain key).
async function backupUndecryptableIdentity(): Promise<string | null> {
  const backupPath = `${ENCRYPTED_IDENTITY_PATH}.bak-${Date.now()}`;
  try {
    await copyFile(ENCRYPTED_IDENTITY_PATH, backupPath);
    return backupPath;
  } catch (err) {
    console.error(`[desktop] Failed to back up undecryptable identity: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function saveEncryptedIdentity(hexKey: string): Promise<void> {
  const encrypted = safeStorage.encryptString(hexKey);
  const dir = path.dirname(ENCRYPTED_IDENTITY_PATH);
  const tmpPath = ENCRYPTED_IDENTITY_PATH + '.tmp';
  await mkdir(dir, { recursive: true });
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, ENCRYPTED_IDENTITY_PATH);
}

export function secureIdentityEnv(): Record<string, string> {
  if (!secureIdentity) return {};
  return { ANTSEED_IDENTITY_HEX: bytesToHex(secureIdentity.privateKey) };
}

const MAX_IDENTITY_RETRIES = 3;
let identityRetryCount = 0;

// Isolated sandbox desktops (ANTSEED_DESKTOP_ATTACH_ONLY=1) reuse the sandbox
// buyer's plaintext identity from its data dir. It is held in memory only and
// never written to the OS keychain or ~/.antseed, so the sandbox wallet cannot
// leak into (or overwrite) the developer's real desktop identity.
async function loadAttachOnlyIdentity(): Promise<void> {
  const dataDir = process.env[CONNECT_DATA_DIR_ENV]?.trim();
  if (!dataDir) {
    console.warn('[desktop] attach-only mode without ANTSEED_DESKTOP_CONNECT_DATA_DIR; wallet views stay empty');
    return;
  }
  try {
    secureIdentity = identityFromHex(await readAttachOnlyIdentityHex(dataDir));
    console.log(`[desktop] attach-only mode: using sandbox buyer identity ${secureIdentity.peerId.slice(0, 12)}...`);
  } catch (err) {
    console.error(`[desktop] attach-only identity load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ensureSecureIdentity(): Promise<void> {
  if (secureIdentity) return;
  if (secureIdentityPromise) {
    await secureIdentityPromise;
    return;
  }
  if (identityRetryCount >= MAX_IDENTITY_RETRIES) return;
  if (isAttachOnly()) {
    await loadAttachOnlyIdentity();
    return;
  }

  const attempt = (async () => {
    try {
      if (!safeStorageAvailable()) {
        console.warn('[desktop] safeStorage not available — skipping secure identity');
        return;
      }

      // 1. Try loading from encrypted store
      const encHex = await loadEncryptedIdentity();
      if (encHex === UNDECRYPTABLE) {
        // identity.enc exists but cannot be decrypted with the current key.
        // Back it up (so the original signer is recoverable) and refuse to
        // silently rotate the wallet by overwriting it. Leave secureIdentity
        // null so the failure is surfaced rather than masked by a fresh key.
        const backup = await backupUndecryptableIdentity();
        console.error(
          `[desktop] identity at ${ENCRYPTED_IDENTITY_PATH} could not be decrypted with the current safeStorage key. ` +
          `This usually means the app's runtime name (app.setName / INTERNAL_APP_NAME) changed, which rotates the macOS keychain key. ` +
          `Refusing to overwrite it to avoid destroying the signer.` +
          (backup ? ` A copy was saved to ${backup}.` : '') +
          ` Restore the original app.setName value (or a matching identity.enc) to recover the original signer.`
        );
        return;
      }
      if (encHex) {
        secureIdentity = identityFromHex(encHex);
        console.log(`[desktop] secure identity loaded from encrypted store: ${secureIdentity.peerId.slice(0, 12)}...`);
        return;
      }

      // 2. Migrate existing plaintext file identity into encrypted store
      let migratedHex: string | null = null;
      try {
        const raw = await readFile(PLAINTEXT_IDENTITY_PATH, 'utf-8');
        const trimmed = raw.trim();
        if (trimmed.length === 64) {
          migratedHex = trimmed;
        } else if (trimmed.length > 0) {
          console.warn(`[desktop] Plaintext identity file has unexpected length (${trimmed.length} chars, expected 64); skipping migration.`);
        }
      } catch {
        // No existing file identity.
      }

      if (migratedHex) {
        await saveEncryptedIdentity(migratedHex);
        secureIdentity = identityFromHex(migratedHex);
        await unlink(PLAINTEXT_IDENTITY_PATH).catch((unlinkErr) => {
          console.warn(`[desktop] Failed to delete plaintext identity after migration: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}. Delete ${PLAINTEXT_IDENTITY_PATH} manually.`);
        });
        console.log(`[desktop] secure identity migrated from plaintext: ${secureIdentity.peerId.slice(0, 12)}...`);
        return;
      }

      // 3. No identity anywhere — create fresh and encrypt
      const newHex = bytesToHex(randomBytes(32));

      await saveEncryptedIdentity(newHex);
      secureIdentity = identityFromHex(newHex);
      console.log(`[desktop] secure identity created: ${secureIdentity.peerId.slice(0, 12)}...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[desktop] secure identity init failed: ${message}`);
    }
  })();

  secureIdentityPromise = attempt;
  try {
    await attempt;
  } finally {
    // Reset on transient failure so a subsequent call can retry (up to MAX_IDENTITY_RETRIES).
    // If safeStorage is permanently unavailable, keep the promise so we don't re-warn.
    if (!secureIdentity && safeStorageAvailable() && secureIdentityPromise === attempt) {
      identityRetryCount++;
      secureIdentityPromise = null;
    }
  }
}

export function getSecureIdentity(): Identity | null {
  return secureIdentity;
}

export function exportIdentityPrivateKeyHex(): string | null {
  if (!secureIdentity) return null;
  return bytesToHex(secureIdentity.privateKey);
}

// Preserve the current encrypted identity before an import overwrites it, so
// the previous signer stays recoverable from disk.
async function backupIdentityBeforeImport(): Promise<string | null> {
  const backupPath = `${ENCRYPTED_IDENTITY_PATH}.bak-${Date.now()}`;
  try {
    await copyFile(ENCRYPTED_IDENTITY_PATH, backupPath);
    return backupPath;
  } catch {
    return null; // No existing identity file — nothing to back up.
  }
}

export async function importIdentityPrivateKeyHex(rawKey: string): Promise<{
  ok: boolean;
  address?: string;
  backupPath?: string | null;
  error?: string;
}> {
  if (!safeStorageAvailable()) {
    return { ok: false, error: 'Secure storage is not available on this system.' };
  }
  const hex = rawKey.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return { ok: false, error: 'Invalid private key: expected 64 hex characters (with or without a 0x prefix).' };
  }
  let identity: Identity;
  try {
    identity = identityFromHex(hex);
  } catch (err) {
    return { ok: false, error: `Invalid private key: ${err instanceof Error ? err.message : String(err)}` };
  }
  const backupPath = await backupIdentityBeforeImport();
  await saveEncryptedIdentity(hex);
  secureIdentity = identity;
  return { ok: true, address: identity.wallet.address, backupPath };
}
