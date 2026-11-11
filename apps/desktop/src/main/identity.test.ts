import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { StreamingRunContext } from './chat/streaming-run.js';
import type { RuntimeProcessState, StartOptions } from './runtime/process-manager.js';

// identity.ts imports Electron, which plain node can't load, so Electron is
// stubbed. Everything else is real: the key files live in a temporary HOME, and
// a file operation fails only where a test says so.

const KEY = '11'.repeat(32);
const OTHER_KEY = '22'.repeat(32);
const sealed = (key: string): string => `sealed:${key}`;
const readText = (file: string): string => readFileSync(file, 'utf8');

let encryptCalls = 0;
let decryptCalls = 0;
let home = '';

const safeStorage = {
  isEncryptionAvailable: () => true,
  setUsePlainTextEncryption: () => {},
  encryptString(plain: string): Buffer {
    encryptCalls += 1;
    return Buffer.from(sealed(plain));
  },
  decryptString(blob: Buffer): string {
    decryptCalls += 1;
    const text = blob.toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('Error while decrypting the ciphertext');
    return text.slice('sealed:'.length);
  },
};

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const ipcHandlers = new Map<string, IpcHandler>();
const openedUrls: string[] = [];

// The parts of Electron the code under test uses. Anything else fails loudly,
// so a test can't lean on an Electron call it doesn't declare.
const unexpected = (name: string): unknown => {
  const fail = (): never => { throw new Error(`Unexpected use of electron.${name}`); };
  return new Proxy(fail, { get: fail, construct: fail });
};
const electron: Record<string, unknown> = {
  safeStorage,
  app: { isPackaged: false, setName: () => {} },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { ipcHandlers.set(channel, handler); } },
  shell: { openExternal: async (url: string) => { openedUrls.push(url); } },
  ...Object.fromEntries(['BrowserWindow', 'clipboard', 'dialog', 'Menu', 'nativeImage', 'net', 'protocol', 'screen', 'Tray'].map((name) => [name, unexpected(name)])),
};
Object.assign(globalThis, { identityTestElectron: electron });
const electronSource = Object.keys(electron).map((name) => `export const ${name} = globalThis.identityTestElectron.${name};`).join('\n');

// Not in this repo's @types/node yet.
const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: {
    resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown): unknown;
  }): void;
};

registerHooks({
  resolve: (specifier, context, next) => (
    specifier === 'electron'
      ? { url: `data:text/javascript,${encodeURIComponent(electronSource)}`, shortCircuit: true }
      : next(specifier, context)
  ),
});

// "operation:path" → the code its next calls fail with, and how many of them fail.
const faults = new Map<string, { code: string; times: number }>();
// "operation:path" → a call that has done its work but returns only when released.
const holds = new Map<string, { onDone: () => void; released: Promise<void> }>();
// Every file operation started, as "operation:path".
let fileCalls: string[] = [];

type FileOperation = (file: unknown, ...rest: unknown[]) => Promise<unknown>;
const fileOperations = fsPromises as unknown as Record<'readFile' | 'copyFile', FileOperation>;
for (const name of ['readFile', 'copyFile'] as const) {
  const real = fileOperations[name];
  fileOperations[name] = async (file, ...rest) => {
    fileCalls.push(`${name}:${String(file)}`);
    const fault = faults.get(`${name}:${String(file)}`);
    if (fault && fault.times > 0) {
      fault.times -= 1;
      throw Object.assign(new Error(`${fault.code}: simulated failure, ${name} '${String(file)}'`), { code: fault.code });
    }
    const result = await real(file, ...rest);
    const hold = holds.get(`${name}:${String(file)}`);
    if (hold) {
      hold.onDone();
      await hold.released;
    }
    return result;
  };
}
nodeModule.syncBuiltinESMExports();

function failRead(file: string, code: string, times = Infinity): void {
  faults.set(`readFile:${file}`, { code, times });
}

function failBackup(file: string, code: string, times = Infinity): void {
  faults.set(`copyFile:${file}`, { code, times });
}

/** The next such call on a file finishes (`done` resolves) but doesn't return until `release` is called. */
function hold(operation: 'readFile' | 'copyFile', file: string): { done: Promise<void>; release: () => void } {
  let onDone = (): void => {};
  let release = (): void => {};
  const done = new Promise<void>((resolve) => { onDone = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  holds.set(`${operation}:${file}`, { onDone, released });
  return { done, release };
}

let dir = '';
let encryptedPath = '';
let plaintextPath = '';
let logged: string[] = [];
let instance = 0;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'antseed-identity-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  // A developer's shell must not point these tests at a real buyer or config.
  for (const name of ['ANTSEED_DESKTOP_ATTACH_ONLY', 'ANTSEED_DESKTOP_ISOLATED_PROFILE', 'ANTSEED_DESKTOP_MULTI_INSTANCE', 'ANTSEED_DESKTOP_CONNECT_DATA_DIR', 'ANTSEED_CONFIG_PATH']) {
    delete process.env[name];
  }
  dir = path.join(home, '.antseed');
  mkdirSync(dir);
  encryptedPath = path.join(dir, 'identity.enc');
  plaintextPath = path.join(dir, 'identity.key');
  faults.clear();
  holds.clear();
  fileCalls = [];
  encryptCalls = 0;
  decryptCalls = 0;
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    mock.method(console, level, (...args: unknown[]) => { logged.push(args.join(' ')); });
  }
});

afterEach(() => {
  mock.restoreAll();
  rmSync(home, { recursive: true, force: true });
});

/** A fresh module per test: it holds the loaded signer and reads HOME when it loads. */
async function loadIdentityModule(): Promise<typeof import('./identity.js')> {
  instance += 1;
  return await import(`./identity.js?instance=${instance}`) as typeof import('./identity.js');
}

function assertStoredSignerUntouched(): void {
  assert.equal(readText(encryptedPath), sealed(KEY), 'the stored signer must stay on disk unchanged');
  assert.equal(encryptCalls, 0, 'no new key may be encrypted');
}

/** What the user reads: one plain sentence, not a stack trace or the raw system error. */
function assertClearToUser(message: unknown, expected: RegExp): void {
  assert.equal(typeof message, 'string', 'the user must get a message');
  assert.match(message as string, expected);
  assert.doesNotMatch(message as string, /\n|\bat .+:\d+|simulated failure/);
  assert.equal((message as string).includes(home), false, 'messages can leave the machine, so they name no home directory');
}

const UNREADABLE = /^Your signer key at ~.\.antseed.identity\.enc can't be read \(EIO\)\./;
const NOT_BACKED_UP = /^Your signer key at ~.\.antseed.identity\.enc couldn't be backed up \(EIO\)/;

for (const code of ['EIO', 'EACCES', 'EPERM', 'EMFILE', 'EBUSY']) {
  test(`a stored signer that can't be read (${code}) stays on disk and no new signer is made`, async () => {
    writeFileSync(encryptedPath, sealed(KEY));
    failRead(encryptedPath, code);
    const identity = await loadIdentityModule();

    await identity.ensureSecureIdentity();

    assertStoredSignerUntouched();
    assert.equal(identity.getSecureIdentity(), null);
    assert.deepEqual(readdirSync(dir), ['identity.enc'], 'nothing else may be written');
  });
}

test('a plaintext key does not replace a stored signer that can\'t be read', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  writeFileSync(plaintextPath, OTHER_KEY);
  failRead(encryptedPath, 'EIO');
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  assertStoredSignerUntouched();
  assert.equal(readText(plaintextPath), OTHER_KEY, 'the plaintext key must stay on disk');
  assert.equal(identity.getSecureIdentity(), null);
});

test('a plaintext key that can\'t be read stays on disk and no new signer is made', async () => {
  writeFileSync(plaintextPath, KEY);
  failRead(plaintextPath, 'EACCES');
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  assert.equal(readText(plaintextPath), KEY, 'the plaintext key must stay on disk');
  assert.equal(existsSync(encryptedPath), false, 'no encrypted signer may be created');
  assert.equal(encryptCalls, 0, 'no new key may be encrypted');
  assert.equal(identity.getSecureIdentity(), null);
  for (const handOut of [identity.secureIdentityEnv, identity.exportIdentityPrivateKeyHex]) {
    assert.throws(handOut, (err: Error) => {
      assertClearToUser(err.message, /^Your signer key at ~.\.antseed.identity\.key can't be read \(EACCES\)\./);
      return true;
    });
  }
});

test('a plaintext read that keeps failing recovers on a later call, without a restart', async () => {
  writeFileSync(plaintextPath, KEY);
  const failures = 6;
  failRead(plaintextPath, 'EACCES', failures);
  const identity = await loadIdentityModule();

  for (let call = 0; call < failures; call += 1) {
    await identity.ensureSecureIdentity();
    assert.throws(identity.secureIdentityEnv, /can't be read \(EACCES\)/);
  }
  await identity.ensureSecureIdentity();

  assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: KEY });
  assert.equal(readText(encryptedPath), sealed(KEY));
  assert.equal(existsSync(plaintextPath), false);
});

test('while the stored signer can\'t be read, handing out a key fails with the reason', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO');
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  for (const handOut of [identity.secureIdentityEnv, identity.exportIdentityPrivateKeyHex]) {
    assert.throws(handOut, (err: Error) => {
      assertClearToUser(err.message, UNREADABLE);
      return true;
    });
  }
  assert.equal(logged.filter((line) => /can't be read \(EIO\)/.test(line)).length, 1, 'the failure is logged');
});

test('a read that keeps failing recovers on a later call, without a restart', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  const failures = 6;
  failRead(encryptedPath, 'EIO', failures);
  const identity = await loadIdentityModule();

  for (let call = 0; call < failures; call += 1) {
    await identity.ensureSecureIdentity();
    assert.equal(identity.getSecureIdentity(), null);
  }
  await identity.ensureSecureIdentity();

  assertStoredSignerUntouched();
  assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: KEY });
  assert.equal(logged.filter((line) => /can't be read/.test(line)).length, 1, 'repeats of one failure are logged once');
});

test('the failure stays in place while a retry is running', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO');
  const identity = await loadIdentityModule();
  await identity.ensureSecureIdentity();

  const retry = identity.ensureSecureIdentity();

  assert.throws(identity.secureIdentityEnv, (err: Error) => UNREADABLE.test(err.message), 'a child process must not start during a retry');
  await retry;
});

test('a different read failure is logged again', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO', 1);
  const identity = await loadIdentityModule();
  await identity.ensureSecureIdentity();

  failRead(encryptedPath, 'EACCES', 1);
  await identity.ensureSecureIdentity();

  assert.equal(logged.filter((line) => /\(EIO\)/.test(line)).length, 1);
  assert.equal(logged.filter((line) => /\(EACCES\)/.test(line)).length, 1);
});

test('the key never appears in logs or in the failure', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO', 1);
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();
  let failure = '';
  try {
    identity.secureIdentityEnv();
  } catch (err) {
    failure = String(err);
  }
  await identity.ensureSecureIdentity();

  assert.notEqual(failure, '');
  assert.equal(identity.exportIdentityPrivateKeyHex(), KEY);
  assert.equal([...logged, failure].some((line) => line.includes(KEY)), false);
});

test('with no key on disk a new signer is created and stored encrypted', async () => {
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  const key = identity.secureIdentityEnv()['ANTSEED_IDENTITY_HEX'] ?? '';
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(readText(encryptedPath), sealed(key));
  assert.equal(existsSync(plaintextPath), false);
});

test('a plaintext key moves into the encrypted store', async () => {
  writeFileSync(plaintextPath, `${KEY}\n`);
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: KEY });
  assert.equal(readText(encryptedPath), sealed(KEY));
  assert.equal(existsSync(plaintextPath), false);
});

test('a stored signer loads without being rewritten', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  assert.equal(identity.exportIdentityPrivateKeyHex(), KEY);
  assertStoredSignerUntouched();
});

test('a stored signer that can\'t be decrypted is kept and backed up', async () => {
  const blob = 'encrypted with another key';
  writeFileSync(encryptedPath, blob);
  const identity = await loadIdentityModule();

  await identity.ensureSecureIdentity();

  assert.equal(readText(encryptedPath), blob);
  assert.equal(encryptCalls, 0, 'no new key may be encrypted');
  assert.equal(identity.getSecureIdentity(), null);
  const backups = readdirSync(dir).filter((name) => name.startsWith('identity.enc.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readText(path.join(dir, backups[0] ?? '')), blob);
});

test('a signer that can\'t be decrypted is only tried a few times', async () => {
  writeFileSync(encryptedPath, 'encrypted with another key');
  const identity = await loadIdentityModule();

  for (let call = 0; call < 6; call += 1) await identity.ensureSecureIdentity();

  assert.equal(decryptCalls, 3);
});

for (const code of ['EIO', 'EACCES', 'ENOSPC']) {
  test(`an import stops when the current signer can't be backed up (${code})`, async () => {
    writeFileSync(encryptedPath, sealed(KEY));
    failBackup(encryptedPath, code);
    const identity = await loadIdentityModule();
    await identity.ensureSecureIdentity();

    await assert.rejects(identity.importIdentityPrivateKeyHex(OTHER_KEY), (err: Error) => {
      assertClearToUser(err.message, new RegExp(`couldn't be backed up \\(${code}\\)`));
      return true;
    });

    assertStoredSignerUntouched();
    assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: KEY }, 'the loaded signer stays in use');
  });
}

const nextTurnOfTheEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

for (const [kind, stored] of [['stored signer', () => encryptedPath], ['plaintext key', () => plaintextPath]] as const) {
  test(`an import waits for a load of a ${kind} that is still running`, async () => {
    writeFileSync(stored(), kind === 'stored signer' ? sealed(KEY) : KEY);
    const identity = await loadIdentityModule();
    const { done, release } = hold('readFile', stored());

    const load = identity.ensureSecureIdentity();
    await done;
    const imported = identity.importIdentityPrivateKeyHex(OTHER_KEY);
    await nextTurnOfTheEventLoop();
    assert.equal(fileCalls.includes(`copyFile:${encryptedPath}`), false, 'the import must not start during the load');
    release();
    await load;
    const result = await imported;

    assert.equal(result.ok, true);
    assert.equal(readText(encryptedPath), sealed(OTHER_KEY), 'the imported key must end up on disk');
    assert.equal(readText(result.backupPath ?? ''), sealed(KEY), 'the loaded key must be backed up');
    assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: OTHER_KEY });
  });
}

test('a load that waited for an import keeps the imported key', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  const identity = await loadIdentityModule();
  const { done, release } = hold('copyFile', encryptedPath);

  const imported = identity.importIdentityPrivateKeyHex(OTHER_KEY);
  await done;
  const load = identity.ensureSecureIdentity();
  await nextTurnOfTheEventLoop();
  assert.equal(fileCalls.includes(`readFile:${encryptedPath}`), false, 'the load must not start during the import');
  release();
  await Promise.all([imported, load]);

  assert.equal(decryptCalls, 0, 'the load has nothing left to do');
  assert.equal(readText(encryptedPath), sealed(OTHER_KEY));
  assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: OTHER_KEY });
});

test('an import backs up the current signer first', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  const identity = await loadIdentityModule();

  const result = await identity.importIdentityPrivateKeyHex(OTHER_KEY);

  assert.equal(result.ok, true);
  assert.equal(readText(result.backupPath ?? ''), sealed(KEY));
  assert.equal(readText(encryptedPath), sealed(OTHER_KEY));
});

test('an import with no key on disk needs no backup', async () => {
  const identity = await loadIdentityModule();

  const result = await identity.importIdentityPrivateKeyHex(OTHER_KEY);

  assert.equal(result.ok, true);
  assert.equal(result.backupPath, null);
  assert.equal(readText(encryptedPath), sealed(OTHER_KEY));
});

test('an import works after a read failure has cleared', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO', 1);
  const identity = await loadIdentityModule();
  await identity.ensureSecureIdentity();
  assert.equal(identity.getSecureIdentity(), null);

  const result = await identity.importIdentityPrivateKeyHex(OTHER_KEY);

  assert.equal(result.ok, true);
  assert.equal(readText(result.backupPath ?? ''), sealed(KEY));
  assert.deepEqual(identity.secureIdentityEnv(), { ANTSEED_IDENTITY_HEX: OTHER_KEY });
});

test('a chat that can\'t start the buyer shows why', async () => {
  const { createStreamingRunner } = await import('./chat/streaming-run.js');
  const reason = 'Your signer key can\'t be read.';
  const context = {
    activeRunsByConversation: new Map(),
    configPath: path.join(home, 'no-config.json'),
    appendSystemLog: (line: string) => { logged.push(line); },
    isBuyerRuntimeRunning: () => false,
    isProxyAvailable: async () => false,
    ensureBuyerRuntimeStarted: async () => { throw new Error(reason); },
  } as unknown as StreamingRunContext;

  const result = await createStreamingRunner(context)('conversation', 'hello');

  assert.equal(result.ok, false);
  assert.equal(result.error, reason);
  assert.equal(result.stopReason?.message, reason);
  assert.equal(result.stopReason?.retryable, false, 'a retry or another peer can\'t help with a local problem');
  assert.equal(logged.some((line) => line.includes(reason)), true, 'the reason is in the runtime log');
});

test('a chat whose buyer did not come up keeps the generic message', async () => {
  const { createStreamingRunner } = await import('./chat/streaming-run.js');
  const context = {
    activeRunsByConversation: new Map(),
    configPath: path.join(home, 'no-config.json'),
    appendSystemLog: () => {},
    isBuyerRuntimeRunning: () => false,
    isProxyAvailable: async () => false,
    ensureBuyerRuntimeStarted: async () => false,
  } as unknown as StreamingRunContext;

  const result = await createStreamingRunner(context)('conversation', 'hello');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Buyer proxy is not reachable/);
  assert.equal(result.stopReason, undefined, 'this one stays retryable');
});

// Runs once: the handlers share one identity module for the whole process.
test('through the app\'s own handlers, a failed read or backup is explained and nothing starts', async () => {
  writeFileSync(encryptedPath, sealed(KEY));
  failRead(encryptedPath, 'EIO');
  failBackup(encryptedPath, 'EIO');
  // Not a valid port, so the portal could never take a real one or hold this process open.
  process.env['ANTSEED_PAYMENTS_PORT'] = '70000';

  const [{ registerAppIpc }, { registerFreeTierIpc }, { registerPaymentsIpc }, { registerRuntimeIpc }, { ProcessManager }, { stakingSessions }] = await Promise.all([
    import('./ipc/app.js'),
    import('./ipc/free-tier.js'),
    import('./ipc/payments.js'),
    import('./ipc/runtime.js'),
    import('./runtime/process-manager.js'),
    import('./staking/portal.js'),
  ]);

  const spawned: StartOptions[] = [];
  const runtimeLog: string[] = [];
  class RecordingProcessManager extends ProcessManager {
    override async start(options: StartOptions): Promise<RuntimeProcessState> {
      spawned.push(options);
      return this.getState().find((state) => state.mode === options.mode) as RuntimeProcessState;
    }
  }
  const processManager = new RecordingProcessManager((_mode, _stream, line) => { runtimeLog.push(line); });
  registerAppIpc();
  registerFreeTierIpc();
  registerPaymentsIpc();
  registerRuntimeIpc({
    processManager,
    logBuffer: [],
    appendLog: () => {},
    getCombinedProcessState: () => processManager.getState(),
    killOrphanBuyerProxy: async () => {},
    requestBuyerPeerRefresh: async () => {},
  });
  const invoke = async (channel: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string | null }> => (
    await (ipcHandlers.get(channel) as IpcHandler)({}, ...args) as { ok: boolean; error?: string | null }
  );
  const startBuyer = { mode: 'connect', router: 'local' };

  const exported = await invoke('identity:export-key');
  assert.equal(exported.ok, false);
  assertClearToUser(exported.error, UNREADABLE);

  await assert.rejects(invoke('runtime:start', startBuyer), (err: Error) => {
    assertClearToUser(err.message, UNREADABLE);
    return true;
  });
  assert.equal(spawned.length, 0, 'no buyer may start without the signer');
  const buyer = processManager.getState().find((state) => state.mode === 'connect');
  assertClearToUser(buyer?.lastError, UNREADABLE);
  assert.equal(runtimeLog.filter((line) => UNREADABLE.test(line)).length, 1, 'the reason stays in the runtime log');

  const payPage = await invoke('payments:open-pay-page', { kind: 'deposit' });
  assert.equal(payPage.ok, false);
  assertClearToUser(payPage.error, UNREADABLE);
  assert.deepEqual(openedUrls, [], 'no payment page may open');

  const signAuth = { channelId: `0x${'ab'.repeat(32)}`, cumulativeAmountBaseUnits: '1', metadataHash: `0x${'cd'.repeat(32)}` };
  for (const [channel, arg] of [['deposits:watch-start'], ['payments:open-card-provider'], ['payments:sign-spending-auth', signAuth], ['freeTier:list']] as const) {
    const refused = await invoke(channel, arg);
    assert.equal(refused.ok, false, channel);
    assertClearToUser(refused.error, UNREADABLE);
  }

  await assert.rejects(stakingSessions.open(), (err: Error) => {
    assertClearToUser(err.message, UNREADABLE);
    return true;
  });

  const imported = await invoke('identity:import-key', OTHER_KEY);
  assert.equal(imported.ok, false);
  assertClearToUser(imported.error, NOT_BACKED_UP);
  assertStoredSignerUntouched();

  faults.clear();
  await invoke('runtime:start', startBuyer);
  assert.equal(spawned[0]?.env?.['ANTSEED_IDENTITY_HEX'], KEY, 'once the file reads again the buyer starts with the real signer');
});
