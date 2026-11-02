import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { closeApp } from '../lib/desktop.mjs';

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
