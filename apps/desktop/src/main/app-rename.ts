/**
 * Moving to the "Antseed Desktop" name without losing anything.
 *
 * The app's runtime name (app.setName) picks two things: the default userData
 * folder, and the safeStorage key ("<name> Safe Storage" in the macOS
 * keychain, the Linux secret store entry; on Windows the key sits in
 * userData's `Local State`). The first launch under the new name:
 *
 * 1. moves the old userData folder to the new name (before Electron uses it),
 * 2. backs up every safeStorage-encrypted store, decrypts what the new key
 *    can't read with a helper started under the old name, and re-encrypts it
 *    under the new name.
 *
 * Step 2 runs at every launch for any store the new key can't read, not just
 * the first: an older install still under the old name can write a store again
 * after the rename. The old keychain entry and the backups are never deleted,
 * so the previous version can still read its backups. A store neither key
 * reads is left as it is, retried for a few launches, then given up on.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SAFE_STORAGE_EXPORT_ENV,
  SAFE_STORAGE_EXPORT_NAME_ENV,
  SAFE_STORAGE_EXPORT_RESULT_PREFIX,
  SAFE_STORAGE_EXPORT_USER_DATA_ENV,
  type SafeStorageExportResult,
} from './safe-storage-export-protocol.js';

export const MIGRATION_MARKER = 'app-rename.json';
/** After this many launches a store neither key reads is given up on (it stays on disk, with its backup). */
export const MAX_MIGRATION_ATTEMPTS = 3;

export type RenameLog = (line: string) => void;

/**
 * Renames `<appData>/<oldName>` to `<appData>/<newName>` when only the old one
 * exists. Must run before anything opens userData (the single-instance lock,
 * app ready). Returns the folder the old name's data is in now.
 */
export function moveUserDataDir(appData: string, oldName: string, newName: string, log: RenameLog = () => {}): string | null {
  const oldDir = path.join(appData, oldName);
  const newDir = path.join(appData, newName);
  if (!existsSync(oldDir)) return null;
  if (existsSync(newDir)) {
    // Both exist (a dev run, or an older install of the new name): keep both.
    log(`userData: both ${oldDir} and ${newDir} exist; keeping ${oldDir} as it is`);
    return oldDir;
  }
  try {
    renameSync(oldDir, newDir);
    log(`userData: moved ${oldDir} to ${newDir}`);
    return newDir;
  } catch (err) {
    log(`userData: could not move ${oldDir} (${err instanceof Error ? err.message : String(err)}); keeping it`);
    return oldDir;
  }
}

/** One safeStorage-encrypted value inside a file. */
export type EncryptedStore = {
  file: string;
  /** Every encrypted value in the file, base64. */
  read(contents: Buffer): string[];
  /** The file with each value replaced (same order as `read`). */
  write(contents: Buffer, values: string[]): Buffer;
};

/** `~/.antseed/identity.enc`: the whole file is one encrypted blob. */
export function wholeFileStore(file: string): EncryptedStore {
  return {
    file,
    read: (contents) => [contents.toString('base64')],
    write: (_contents, values) => Buffer.from(requiredValue(values, 0, file), 'base64'),
  };
}

function requiredValue(values: readonly string[], index: number, file: string): string {
  const value = values[index];
  if (typeof value !== 'string') throw new Error(`Missing encrypted value in ${file}`);
  return value;
}

/** `desktop-gateway.json`: `localKeys.*.secretEnc` and `remoteKeyEnc`, base64. */
export function gatewaySettingsStore(file: string): EncryptedStore {
  type Settings = { localKeys?: Record<string, { secretEnc?: unknown }>; remoteKeyEnc?: unknown };
  const slots = (settings: Settings): Array<{ get(): string; set(value: string): void }> => {
    const out: Array<{ get(): string; set(value: string): void }> = [];
    for (const entry of Object.values(settings.localKeys ?? {})) {
      if (entry && typeof entry.secretEnc === 'string') {
        out.push({ get: () => entry.secretEnc as string, set: (value) => { entry.secretEnc = value; } });
      }
    }
    if (typeof settings.remoteKeyEnc === 'string') {
      out.push({ get: () => settings.remoteKeyEnc as string, set: (value) => { settings.remoteKeyEnc = value; } });
    }
    return out;
  };
  const parse = (contents: Buffer): Settings => JSON.parse(contents.toString('utf8')) as Settings;
  return {
    file,
    read: (contents) => slots(parse(contents)).map((slot) => slot.get()),
    write: (contents, values) => {
      const settings = parse(contents);
      slots(settings).forEach((slot, index) => slot.set(requiredValue(values, index, file)));
      return Buffer.from(JSON.stringify(settings, null, 2));
    },
  };
}

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type MigrateOptions = {
  stores: EncryptedStore[];
  /** Where the marker goes once everything is readable under the new name. */
  markerDir: string;
  oldName: string;
  newName: string;
  safeStorage: SafeStorageLike;
  /** Decrypts base64 blobs with the old name's key (the helper process). */
  decryptWithOldName(blobs: string[]): Promise<SafeStorageExportResult>;
  now?: () => number;
  log?: RenameLog;
};

export type MigrateResult = { migrated: string[]; failed: string[]; backups: string[]; skipped: boolean };

function readable(safeStorage: SafeStorageLike, blob: string): boolean {
  try {
    safeStorage.decryptString(Buffer.from(blob, 'base64'));
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(file: string, contents: Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Backs up and re-encrypts every store the new name's key can't read. */
export async function migrateEncryptedStores(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const marker = path.join(options.markerDir, MIGRATION_MARKER);
  const result: MigrateResult = { migrated: [], failed: [], backups: [], skipped: false };
  let attempts = 0;
  let helperUnavailable = false;
  // Stores given up on by an earlier launch. Anything else the new key can't
  // read is migrated again, even after a complete marker: the old name's app
  // (an older install, a downgrade) can rewrite a store under its key later.
  let givenUp = new Set<string>();
  try {
    const previous = JSON.parse(readFileSync(marker, 'utf8')) as { complete?: unknown; attempts?: unknown; failed?: unknown };
    if (previous.complete === false) {
      attempts = typeof previous.attempts === 'number' ? previous.attempts : 0;
    } else {
      givenUp = new Set(Array.isArray(previous.failed) ? previous.failed.filter((file): file is string => typeof file === 'string') : []);
    }
  } catch {
    // No marker yet: the first launch under the new name.
  }
  if (!options.safeStorage.isEncryptionAvailable()) {
    log('safeStorage is not available; the stores will be migrated at a later launch');
    return { ...result, skipped: true };
  }

  const pending: Array<{ store: EncryptedStore; contents: Buffer; values: string[]; unreadable: number[] }> = [];
  for (const store of options.stores) {
    if (!existsSync(store.file) || givenUp.has(store.file)) continue;
    try {
      const contents = readFileSync(store.file);
      const values = store.read(contents);
      const unreadable = values.flatMap((value, index) => (readable(options.safeStorage, value) ? [] : [index]));
      if (unreadable.length > 0) pending.push({ store, contents, values, unreadable });
    } catch (err) {
      log(`${store.file}: could not read it (${err instanceof Error ? err.message : String(err)})`);
      result.failed.push(store.file);
    }
  }
  if (pending.length === 0 && result.failed.length === 0 && existsSync(marker)) {
    // Everything reads under the new name and the marker already says so.
    return { ...result, skipped: true };
  }

  if (pending.length > 0) {
    const blobs = pending.flatMap((entry) => entry.unreadable.map((index) => entry.values[index]!));
    let exported: SafeStorageExportResult;
    try {
      exported = await options.decryptWithOldName(blobs);
    } catch (err) {
      log(`could not read the stores under "${options.oldName}": ${err instanceof Error ? err.message : String(err)}`);
      exported = { available: false, plain: blobs.map(() => null) };
    }
    // The helper couldn't run (a timeout, a keychain that was locked): that says
    // nothing about the stores, so this launch doesn't count toward giving up.
    if (exported.available === false) helperUnavailable = true;
    const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    let cursor = 0;
    for (const entry of pending) {
      const plains = entry.unreadable.map(() => exported.plain[cursor++] ?? null);
      if (plains.some((plain) => plain === null)) {
        log(`${entry.store.file}: "${options.oldName}" could not read it either; left as it is`);
        result.failed.push(entry.store.file);
        continue;
      }
      const backup = `${entry.store.file}.bak-${options.oldName.replace(/\s+/g, '-')}-${stamp}`;
      copyFileSync(entry.store.file, backup);
      result.backups.push(backup);
      const values = [...entry.values];
      entry.unreadable.forEach((index, position) => {
        const plain = plains[position];
        if (plain == null) throw new Error(`Missing decrypted value for ${entry.store.file}`);
        values[index] = options.safeStorage.encryptString(plain).toString('base64');
      });
      writeAtomic(entry.store.file, entry.store.write(entry.contents, values));
      // Read it back before calling it done.
      const check = entry.store.read(readFileSync(entry.store.file));
      if (!check.every((value) => readable(options.safeStorage, value))) {
        copyFileSync(backup, entry.store.file);
        log(`${entry.store.file}: the re-encrypted copy did not read back; restored the original`);
        result.failed.push(entry.store.file);
        continue;
      }
      log(`${entry.store.file}: re-encrypted under "${options.newName}" (backup: ${backup})`);
      result.migrated.push(entry.store.file);
    }
  }

  if (!helperUnavailable) attempts += 1;
  const complete = result.failed.length === 0 || attempts >= MAX_MIGRATION_ATTEMPTS;
  if (!complete) log(`${result.failed.length} store(s) not migrated yet; trying again at the next launch`);
  mkdirSync(options.markerDir, { recursive: true });
  writeFileSync(marker, JSON.stringify({
    from: options.oldName,
    to: options.newName,
    at: new Date(options.now?.() ?? Date.now()).toISOString(),
    complete,
    attempts,
    migrated: result.migrated,
    failed: complete ? [...givenUp, ...result.failed] : result.failed,
    backups: result.backups,
  }, null, 2));
  return result;
}

/**
 * Starts this app under `oldName` as the safeStorage export helper and returns
 * what it decrypted. `appArgs` is the app path in development (`electron .`).
 */
export function exportWithOldName(options: {
  execPath: string;
  appArgs: string[];
  oldName: string;
  userData: string;
  blobs: string[];
  timeoutMs?: number;
}): Promise<SafeStorageExportResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [SAFE_STORAGE_EXPORT_ENV]: '1',
      [SAFE_STORAGE_EXPORT_NAME_ENV]: options.oldName,
      [SAFE_STORAGE_EXPORT_USER_DATA_ENV]: options.userData,
    };
    delete env['ELECTRON_RUN_AS_NODE'];
    const child = spawn(options.execPath, options.appArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the helper did not answer in time'));
    }, options.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(SAFE_STORAGE_EXPORT_RESULT_PREFIX));
      if (!line) {
        reject(new Error(`the helper exited with ${code ?? 'a signal'} and no result${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(SAFE_STORAGE_EXPORT_RESULT_PREFIX.length)) as SafeStorageExportResult);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stdin.end(JSON.stringify({ blobs: options.blobs }));
  });
}
