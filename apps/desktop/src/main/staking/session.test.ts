import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StakingSessionManager, stakingLaunchUrl, type StakingSession } from './session.js';

function fixture() {
  const events: string[] = [];
  const state = { busy: false };
  let created = 0;
  const manager = new StakingSessionManager(async (): Promise<StakingSession> => {
    const id = ++created;
    events.push(`create ${id}`);
    return {
      get busy() { return state.busy; },
      pauseWrites() { if (state.busy) throw new Error('busy'); events.push(`pause ${id}`); },
      async open() { events.push(`open ${id}`); },
      async copyLink(page = 'stake') { events.push(`copy ${id} ${page}`); },
      async close() { events.push(`close ${id}`); },
    };
  });
  return { manager, events, state };
}

test('concurrent launch requests share one session', async () => {
  const { manager, events } = fixture();
  await Promise.all([manager.open(), manager.open()]);
  assert.deepEqual(events, ['create 1', 'open 1', 'open 1']);
});

test('wallet changes revoke the old session before changing identity and reopening', async () => {
  const { manager, events } = fixture();
  await manager.open();
  await Promise.all([
    manager.reset(async () => { events.push('import'); }),
    manager.open(),
  ]);
  assert.deepEqual(events, ['create 1', 'open 1', 'pause 1', 'close 1', 'import', 'create 2', 'open 2']);
});

test('running transactions block configuration changes without closing the session', async () => {
  const { manager, state, events } = fixture();
  await manager.open();
  state.busy = true;
  assert.equal(manager.busy, true);
  await assert.rejects(manager.reset(async () => { throw new Error('must not change'); }), /busy/);
  await manager.open();
  assert.deepEqual(events, ['create 1', 'open 1', 'open 1']);
  state.busy = false;
  await manager.reset(async () => {});
  assert.equal(manager.busy, false);
});

test('a slow startup finishes before config reset and shutdown prevents another launch', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const manager = new StakingSessionManager(async () => {
    await ready;
    return { busy: false, pauseWrites() { events.push('pause'); }, async open() { events.push('open'); }, async copyLink() {}, async close() { events.push('close'); } };
  });
  const opening = manager.open();
  const reset = manager.reset(async () => { events.push('config'); });
  release();
  await Promise.all([opening, reset]);
  assert.deepEqual(events, ['open', 'pause', 'close', 'config']);
  await manager.stop();
  await assert.rejects(manager.open(), /shutting down/);
});

test('startup failure is retryable and failed identity import leaves no stale session', async () => {
  let attempts = 0;
  const manager = new StakingSessionManager(async () => {
    if (++attempts === 1) throw new Error('wallet unavailable');
    return { busy: false, pauseWrites() {}, async open() {}, async copyLink() {}, async close() {} };
  });
  await assert.rejects(manager.open(), /wallet unavailable/);
  await manager.open();
  await assert.rejects(manager.reset(async () => { throw new Error('invalid key'); }), /invalid key/);
  await manager.open();
  assert.equal(attempts, 3);
});

test('quitting during startup closes the created session without showing a window', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const events: string[] = [];
  const manager = new StakingSessionManager(async () => {
    started();
    await ready;
    return { busy: false, pauseWrites() {}, async open() { events.push('open'); }, async copyLink() {}, async close() { events.push('close'); } };
  });
  const opening = manager.open();
  await starting;
  const stopping = manager.stop();
  release();
  await assert.rejects(opening, /shutting down/);
  await stopping;
  assert.deepEqual(events, ['close']);
});


test('both destinations share one session and keep their intended route and token', async () => {
  let creates = 0;
  const pages: string[] = [];
  const manager = new StakingSessionManager(async () => {
    creates++;
    return { busy: false, pauseWrites() {}, async close() {}, async copyLink() {}, async open(page = 'stake') { pages.push(page); } };
  });
  await manager.open('rewards'); await manager.open('stake'); await manager.open();
  assert.equal(creates, 1);
  assert.deepEqual(pages, ['rewards', 'stake', 'stake']);
  for (const page of ['rewards', 'stake'] as const) {
    const url = new URL(stakingLaunchUrl('http://127.0.0.1:3119/#token=session', page));
    const params = new URLSearchParams(url.hash.slice(1));
    assert.equal(params.get('token'), 'session'); assert.equal(params.get('page'), page);
    assert.equal(url.origin, 'http://127.0.0.1:3119');
  }
});

test('copy starts a session without opening a browser and shares it with later launches', async () => {
  const { manager, events } = fixture();
  await Promise.all([manager.copyLink('rewards'), manager.copyLink()]);
  assert.deepEqual(events, ['create 1', 'copy 1 rewards', 'copy 1 stake']);
  await manager.open('stake');
  assert.deepEqual(events, ['create 1', 'copy 1 rewards', 'copy 1 stake', 'open 1']);
});

test('copy after an identity change uses a fresh session and cannot run after shutdown', async () => {
  const { manager, events } = fixture();
  await manager.copyLink('rewards');
  await Promise.all([
    manager.reset(async () => { events.push('import'); }),
    manager.copyLink('stake'),
  ]);
  assert.deepEqual(events, ['create 1', 'copy 1 rewards', 'pause 1', 'close 1', 'import', 'create 2', 'copy 2 stake']);
  await manager.stop();
  await assert.rejects(manager.copyLink(), /shutting down/);
});

test('copy failures propagate and remain retryable', async () => {
  let copies = 0;
  const manager = new StakingSessionManager(async () => ({
    busy: false,
    pauseWrites() {},
    async open() { assert.fail('copy must not open a browser'); },
    async copyLink() { if (++copies === 1) throw new Error('clipboard unavailable'); },
    async close() {},
  }));
  await assert.rejects(manager.copyLink('rewards'), /clipboard unavailable/);
  await manager.copyLink('rewards');
  assert.equal(copies, 2);
});
