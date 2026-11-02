import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, electronRootArgs, playwrightFfmpeg } from '../lib/desktop.mjs';

function fakeApp({ closeHangs }) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    killed: null,
    kill(signal) { this.killed = signal; this.signalCode = signal; this.emit('exit', null, signal); },
  });
  return {
    child,
    process: () => child,
    close: () => (closeHangs ? new Promise(() => {}) : Promise.resolve().then(() => { child.exitCode = 0; child.emit('exit', 0, null); })),
  };
}

describe('closeApp', () => {
  it('waits for a clean exit without killing', async () => {
    const app = fakeApp({ closeHangs: false });
    await closeApp(app, { timeoutMs: 1000 });
    assert.equal(app.child.killed, null);
  });

  it('kills an app whose process does not exit in time', async () => {
    const app = fakeApp({ closeHangs: true });
    const closing = closeApp(app, { timeoutMs: 50 });
    await closing;
    assert.equal(app.child.killed, 'SIGKILL');
  });
});

describe('desktop launch prerequisites', () => {
  it('turns Chromium sandboxing off only for root on Linux', () => {
    assert.deepEqual(electronRootArgs({ platform: 'linux', uid: 0 }), ['--no-sandbox']);
    assert.deepEqual(electronRootArgs({ platform: 'linux', uid: 1000 }), []);
    assert.deepEqual(electronRootArgs({ platform: 'darwin', uid: 0 }), []);
  });

  it("finds Playwright's ffmpeg where Playwright expects it", async () => {
    const browsers = await mkdtemp(join(tmpdir(), 'pw-browsers-'));
    try {
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers };
      const missing = playwrightFfmpeg({ env });
      assert.equal(missing.installed, false);
      assert.ok(missing.location.startsWith(browsers), missing.location);
      assert.match(missing.reason, /not installed/);
      await mkdir(missing.location, { recursive: true });
      await writeFile(join(missing.location, 'ffmpeg-linux'), '');
      assert.equal(playwrightFfmpeg({ env }).installed, true);
    } finally {
      await rm(browsers, { recursive: true, force: true });
    }
  });
});
