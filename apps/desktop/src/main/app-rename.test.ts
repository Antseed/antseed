import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gatewaySettingsStore,
  MAX_MIGRATION_ATTEMPTS,
  migrateEncryptedStores,
  MIGRATION_MARKER,
  moveUserDataDir,
  wholeFileStore,
  type SafeStorageLike,
} from './app-rename.js';

/** A safeStorage stand-in whose key is a tag: it reads only what it wrote. */
function fakeSafeStorage(tag: string): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`${tag}:${plain}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith(`${tag}:`)) throw new Error('wrong key');
      return text.slice(tag.length + 1);
    },
  };
}

const oldKey = fakeSafeStorage('old');
const newKey = fakeSafeStorage('new');
const viaOldName = async (blobs: string[]) => ({
  available: true,
  plain: blobs.map((blob) => {
    try {
      return oldKey.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }),
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'app-rename-'));
  const identity = path.join(root, 'identity.enc');
  const settings = path.join(root, 'desktop-gateway.json');
  writeFileSync(identity, oldKey.encryptString('a'.repeat(64)));
  writeFileSync(settings, JSON.stringify({
    mode: 'local',
    localKeys: { desktop: { id: 'key_1', label: 'Desktop', secretEnc: oldKey.encryptString('sk-desktop').toString('base64') } },
    remoteKeyEnc: oldKey.encryptString('sk-remote').toString('base64'),
  }));
  const markerDir = path.join(root, 'userData');
  return { root, identity, settings, markerDir, stores: [wholeFileStore(identity), gatewaySettingsStore(settings)] };
}

const names = { oldName: 'AntStation Desktop', newName: 'Antseed Desktop' };

test('re-encrypts every store under the new name and keeps backups readable by the old one', async () => {
  const env = setup();
  const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  assert.deepEqual(result.migrated, [env.identity, env.settings]);
  assert.equal(newKey.decryptString(readFileSync(env.identity)), 'a'.repeat(64));
  const settings = JSON.parse(readFileSync(env.settings, 'utf8'));
  assert.equal(newKey.decryptString(Buffer.from(settings.localKeys.desktop.secretEnc, 'base64')), 'sk-desktop');
  assert.equal(newKey.decryptString(Buffer.from(settings.remoteKeyEnc, 'base64')), 'sk-remote');
  assert.equal(settings.localKeys.desktop.id, 'key_1', 'other fields are kept');
  assert.equal(result.backups.length, 2);
  assert.equal(oldKey.decryptString(readFileSync(result.backups[0]!)), 'a'.repeat(64));
  assert.ok(result.backups[0]!.includes('.bak-AntStation-Desktop-'));
  const marker = JSON.parse(readFileSync(path.join(env.markerDir, MIGRATION_MARKER), 'utf8'));
  assert.equal(marker.complete, true);

  // Nothing left for the old name to read: later launches don't start the helper.
  const again = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: async () => { throw new Error('should not run'); } });
  assert.equal(again.skipped, true);
});

test('migrates again when the old name rewrites a store after a complete migration', async () => {
  const env = setup();
  await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  // An older install (still under the old name) writes the signer again.
  writeFileSync(env.identity, oldKey.encryptString('c'.repeat(64)));
  const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  assert.deepEqual(result.migrated, [env.identity]);
  assert.equal(newKey.decryptString(readFileSync(env.identity)), 'c'.repeat(64));
});

test('a complete marker that migrated nothing still lets an old-key store through', async () => {
  const env = setup();
  mkdirSync(env.markerDir, { recursive: true });
  writeFileSync(path.join(env.markerDir, MIGRATION_MARKER), JSON.stringify({ complete: true, attempts: 1, migrated: [], failed: [], backups: [] }));
  const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  assert.deepEqual(result.migrated, [env.identity, env.settings]);
});

test('a store given up on stays given up on, without blocking the others', async () => {
  const env = setup();
  writeFileSync(env.identity, Buffer.from('garbage'));
  for (let attempt = 1; attempt <= MAX_MIGRATION_ATTEMPTS; attempt += 1) {
    await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  }
  const settings = JSON.parse(readFileSync(env.settings, 'utf8'));
  settings.remoteKeyEnc = oldKey.encryptString('sk-remote-2').toString('base64');
  writeFileSync(env.settings, JSON.stringify(settings));
  let asked: string[] = [];
  const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: async (blobs) => { asked = blobs; return viaOldName(blobs); } });
  assert.equal(asked.length, 1, 'the given-up identity is not sent to the helper again');
  assert.deepEqual(result.migrated, [env.settings]);
  const marker = JSON.parse(readFileSync(path.join(env.markerDir, MIGRATION_MARKER), 'utf8'));
  assert.deepEqual(marker.failed, [env.identity]);
});

test('leaves a store the new key already reads, and a fresh install, alone', async () => {
  const env = setup();
  writeFileSync(env.identity, newKey.encryptString('b'.repeat(64)));
  let asked: string[] = [];
  await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: async (blobs) => { asked = blobs; return viaOldName(blobs); } });
  assert.equal(asked.length, 2, 'only the two gateway secrets go to the helper');
  assert.equal(newKey.decryptString(readFileSync(env.identity)), 'b'.repeat(64));
  assert.ok(!readdirSync(env.root).some((name) => name.startsWith('identity.enc.bak')));

  const empty = mkdtempSync(path.join(tmpdir(), 'app-rename-empty-'));
  const fresh = await migrateEncryptedStores({ ...names, stores: [wholeFileStore(path.join(empty, 'identity.enc'))], markerDir: empty, safeStorage: newKey, decryptWithOldName: async () => { throw new Error('should not run'); } });
  assert.deepEqual(fresh.migrated, []);
});

test('a store neither name reads is left untouched and retried, then given up on', async () => {
  const env = setup();
  writeFileSync(env.identity, Buffer.from('garbage'));
  for (let attempt = 1; attempt <= MAX_MIGRATION_ATTEMPTS; attempt += 1) {
    const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
    assert.deepEqual(result.failed, attempt === 1 ? [env.identity] : [env.identity]);
    assert.equal(readFileSync(env.identity, 'utf8'), 'garbage');
    const marker = JSON.parse(readFileSync(path.join(env.markerDir, MIGRATION_MARKER), 'utf8'));
    assert.equal(marker.complete, attempt === MAX_MIGRATION_ATTEMPTS);
  }
});

test('a helper that fails migrates nothing', async () => {
  const env = setup();
  const before = readFileSync(env.identity);
  const result = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: async () => { throw new Error('keychain locked'); } });
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(readFileSync(env.identity), before);
});

test('launches where the helper could not run never give up on the stores', async () => {
  const env = setup();
  for (let launch = 1; launch <= MAX_MIGRATION_ATTEMPTS + 2; launch += 1) {
    await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: async () => { throw new Error('timed out'); } });
    const marker = JSON.parse(readFileSync(path.join(env.markerDir, MIGRATION_MARKER), 'utf8'));
    assert.equal(marker.complete, false);
    assert.equal(marker.attempts, 0);
  }
  const recovered = await migrateEncryptedStores({ ...names, stores: env.stores, markerDir: env.markerDir, safeStorage: newKey, decryptWithOldName: viaOldName });
  assert.deepEqual(recovered.migrated.sort(), env.stores.map((store) => store.file).filter((file) => existsSync(file)).sort());
});

test('moveUserDataDir moves the old folder once and never merges into an existing one', () => {
  const appData = mkdtempSync(path.join(tmpdir(), 'app-data-'));
  mkdirSync(path.join(appData, 'AntStation Desktop'));
  writeFileSync(path.join(appData, 'AntStation Desktop', 'Local State'), 'k');
  assert.equal(moveUserDataDir(appData, 'AntStation Desktop', 'Antseed Desktop'), path.join(appData, 'Antseed Desktop'));
  assert.equal(readFileSync(path.join(appData, 'Antseed Desktop', 'Local State'), 'utf8'), 'k');
  assert.ok(!existsSync(path.join(appData, 'AntStation Desktop')));
  assert.equal(moveUserDataDir(appData, 'AntStation Desktop', 'Antseed Desktop'), null);

  mkdirSync(path.join(appData, 'AntStation Desktop'));
  assert.equal(moveUserDataDir(appData, 'AntStation Desktop', 'Antseed Desktop'), path.join(appData, 'AntStation Desktop'));
  assert.ok(existsSync(path.join(appData, 'AntStation Desktop')));
});
