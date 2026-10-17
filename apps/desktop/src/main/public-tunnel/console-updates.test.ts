import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { consoleUpdatePaths, consoleUpdaterEnv, createConsoleUpdates, isNewerVersion } from './console-updates.js';

function harness(appVersion = '0.2.62', install: () => Promise<void> = async () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'console-updates-'));
  const paths = consoleUpdatePaths(dir);
  const installs: string[] = [];
  const downloads: string[] = [];
  let clock = 1_000;
  const make = (version: string, run: () => Promise<void> = install) => createConsoleUpdates({
    paths,
    appVersion: version,
    download: () => { downloads.push(version); },
    install: async () => { installs.push(version); await run(); },
    log: () => {},
    now: () => clock,
  });
  const status = () => JSON.parse(readFileSync(paths.status, 'utf8')) as Record<string, any>;
  const request = (action?: 'download' | 'install') => writeFileSync(paths.request, JSON.stringify(action ? { action } : {}));
  return {
    paths, installs, downloads, status, request, make,
    updates: make(appVersion),
    tick: (ms: number) => { clock += ms; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('versions compare like semver, pre-releases before their release', () => {
  assert.equal(isNewerVersion('0.2.63', '0.2.62'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.2.62', '0.2.62'), false);
  assert.equal(isNewerVersion('0.2.61', '0.2.62'), false);
  assert.equal(isNewerVersion('0.2.63-alpha.1', '0.2.62'), true);
  assert.equal(isNewerVersion('0.2.63-alpha.1', '0.2.63'), false);
  assert.equal(isNewerVersion('0.2.63', '0.2.63-alpha.2'), true);
  assert.equal(isNewerVersion(null, '0.2.62'), false);
});

test('the tunnel CLI is told where to ask, and that the app answers', () => {
  const paths = consoleUpdatePaths('/data');
  assert.deepEqual(consoleUpdaterEnv(paths), {
    ANTSEED_UPDATER_REQUEST: path.join('/data', 'tunnel', 'update-request'),
    ANTSEED_UPDATER_STATUS: path.join('/data', 'tunnel', 'update-status.json'),
    ANTSEED_UPDATER_KIND: 'desktop',
  });
});

test('the app reports its versions, and a console request installs the release its updater found', async () => {
  const h = harness();
  try {
    assert.deepEqual(h.status().app, { current: '0.2.62', latest: null, checkedAt: null, error: null });
    h.updates.checked('0.2.63');
    assert.equal(h.status().app.latest, '0.2.63');

    h.request();
    h.updates.poll();
    await settle();
    assert.equal(existsSync(h.paths.request), false, 'the request is consumed');
    assert.deepEqual(h.installs, ['0.2.62']);
    assert.deepEqual([h.status().state, h.status().from, h.status().to], ['running', '0.2.62', '0.2.63']);
    assert.equal(h.updates.running(), true);

    // A second click while it runs starts nothing new.
    h.request();
    h.updates.poll();
    await settle();
    assert.equal(h.installs.length, 1);

    // The app restarts on the new version and finishes the run.
    h.tick(30_000);
    h.make('0.2.63');
    assert.deepEqual([h.status().state, h.status().to, h.status().finishedAt, h.status().app.current], ['succeeded', '0.2.63', 31_000, '0.2.63']);
  } finally {
    h.cleanup();
  }
});

test('a request with nothing newer, a failed install, or a restart on the old version is reported as failed', async () => {
  const h = harness();
  try {
    h.updates.checked('0.2.62');
    h.request();
    h.updates.poll();
    await settle();
    assert.deepEqual(h.installs, []);
    assert.deepEqual([h.status().state, h.status().error], ['failed', 'Antseed Desktop 0.2.62 is already the latest version']);

    const broken = h.make('0.2.62', async () => { throw new Error('download failed'); });
    broken.checked('0.2.63');
    h.request();
    broken.poll();
    await settle();
    assert.deepEqual([h.status().state, h.status().error], ['failed', 'download failed']);

    const updates = h.make('0.2.62', () => new Promise(() => {}));
    updates.checked('0.2.63');
    h.request();
    updates.poll();
    await settle();
    assert.equal(h.status().state, 'running');
    h.make('0.2.62');
    assert.deepEqual([h.status().state, h.status().error], ['failed', 'Antseed Desktop restarted without installing 0.2.63']);
  } finally {
    h.cleanup();
  }
});

test('an updater error while installing ends the run; a failed background check is only reported', async () => {
  const h = harness('0.2.62', () => new Promise(() => {}));
  try {
    h.updates.checked(null, 'net::ERR_INTERNET_DISCONNECTED');
    assert.deepEqual([h.status().app.latest, h.status().app.error], [null, 'net::ERR_INTERNET_DISCONNECTED']);
    assert.equal(h.status().state, undefined);
    h.updates.failed('ignored: nothing is running');
    assert.equal(h.status().state, undefined);

    h.updates.checked('0.2.63');
    h.request();
    h.updates.poll();
    await settle();
    h.updates.failed('code signature invalid');
    assert.deepEqual([h.status().state, h.status().error], ['failed', 'code signature invalid']);
    assert.equal(h.updates.running(), false);
  } finally {
    h.cleanup();
  }
});

test('Download, then Restart & update, as on the app\'s banner', async () => {
  const h = harness();
  try {
    h.updates.checked('0.2.63');
    h.request('download');
    h.updates.poll();
    await settle();
    assert.deepEqual([h.downloads, h.installs], [['0.2.62'], []]);
    assert.deepEqual([h.status().state, h.status().action, h.status().to], ['running', 'download', '0.2.63']);

    h.updates.downloaded('0.2.63');
    assert.deepEqual([h.status().state, h.status().action, h.status().to], ['ready', 'download', '0.2.63']);
    assert.equal(h.updates.running(), false);

    // Asking again downloads nothing.
    h.request('download');
    h.updates.poll();
    await settle();
    assert.equal(h.downloads.length, 1);

    h.request('install');
    h.updates.poll();
    await settle();
    assert.deepEqual(h.installs, ['0.2.62']);
    assert.deepEqual([h.status().state, h.status().action], ['running', 'install']);
    h.make('0.2.63');
    assert.deepEqual([h.status().state, h.status().app.current], ['succeeded', '0.2.63']);
  } finally {
    h.cleanup();
  }
});

test('a download from the banner shows as ready, and one the app quits on is installed or kept', () => {
  const h = harness();
  try {
    h.updates.checked('0.2.63');
    h.updates.downloaded('0.2.63');
    assert.deepEqual([h.status().state, h.status().to], ['ready', '0.2.63']);
    // Relaunched without installing: still downloaded as far as the console goes.
    h.make('0.2.62');
    assert.deepEqual([h.status().state, h.status().to], ['ready', '0.2.63']);
    // The updater installed it on quit.
    h.make('0.2.63');
    assert.deepEqual([h.status().state, h.status().to], ['succeeded', '0.2.63']);

    // A download the app quit during is forgotten.
    h.updates.checked('0.2.64');
    const updates = h.make('0.2.63');
    updates.checked('0.2.64');
    h.request('download');
    updates.poll();
    assert.equal(h.status().state, 'running');
    h.make('0.2.63');
    assert.equal(h.status().state, undefined);
  } finally {
    h.cleanup();
  }
});

test('an incomplete request starts nothing', async () => {
  const h = harness();
  try {
    h.updates.checked('0.2.63');
    writeFileSync(h.paths.request, '');
    h.updates.poll();
    await settle();
    writeFileSync(h.paths.request, '{"action":"downl');
    h.updates.poll();
    await settle();
    assert.deepEqual([h.downloads, h.installs], [[], []]);
    assert.equal(h.status().state, undefined);
    assert.equal(existsSync(h.paths.request), false);
  } finally {
    h.cleanup();
  }
});
