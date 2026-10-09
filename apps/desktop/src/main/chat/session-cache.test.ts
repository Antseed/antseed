import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

import { ChatSessionCache, fingerprintEquals, type SessionFingerprint } from './session-cache.js';

const baseFingerprint: SessionFingerprint = {
  serviceId: 'svc',
  peerId: 'peer-a',
  routeMode: 'pinned',
  protocol: 'anthropic-messages',
  supportsMultimodal: false,
  proxyPort: 8377,
  permissionMode: 'manual',
  workspaceDir: '/tmp/ws',
  userSystemPrompt: '',
  skillPaths: ['/skills/a'],
};

function fakeSession(state: Partial<Pick<AgentSession, 'isStreaming' | 'isCompacting' | 'isRetrying'>> = {}) {
  let disposed = 0;
  const session = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    ...state,
    dispose: () => { disposed += 1; },
  } as unknown as AgentSession;
  return { session, disposed: () => disposed };
}

test('fingerprint equality covers every baked-in field', () => {
  assert.equal(fingerprintEquals(baseFingerprint, { ...baseFingerprint }), true);
  const changes: Partial<SessionFingerprint>[] = [
    { serviceId: 'other' }, { peerId: null }, { routeMode: 'auto' }, { protocol: 'openai-responses' },
    { supportsMultimodal: true }, { proxyPort: 1 }, { permissionMode: 'full' }, { workspaceDir: '/x' },
    { userSystemPrompt: 'custom' }, { skillPaths: [] }, { skillPaths: ['/skills/b'] },
  ];
  for (const change of changes) {
    assert.equal(fingerprintEquals(baseFingerprint, { ...baseFingerprint, ...change }), false, JSON.stringify(change));
  }
});

test('reuses a matching entry, rejects a changed fingerprint or an invalidated entry', () => {
  const cache = new ChatSessionCache({ sweep: false });
  const { session } = fakeSession();
  cache.set('c1', session, baseFingerprint);
  assert.equal(cache.getReusable('c1', { ...baseFingerprint })?.session, session);
  assert.equal(cache.getReusable('c1', { ...baseFingerprint, permissionMode: 'full' }), null);
  cache.invalidate('c1');
  assert.equal(cache.getReusable('c1', baseFingerprint), null);
  assert.equal(cache.peek('c1')?.session, session, 'invalidated entry stays alive until rebuilt');
});

test('replacing or deleting an entry disposes the old session once and notifies', () => {
  const disposedIds: string[] = [];
  const cache = new ChatSessionCache({ sweep: false, onDispose: (id) => disposedIds.push(id) });
  const first = fakeSession();
  const second = fakeSession();
  cache.set('c1', first.session, baseFingerprint);
  cache.set('c1', second.session, baseFingerprint);
  assert.equal(first.disposed(), 1);
  cache.disposeConversation('c1');
  cache.disposeConversation('c1');
  assert.equal(second.disposed(), 1);
  assert.deepEqual(disposedIds, ['c1', 'c1']);
  assert.equal(cache.size, 0);
});

test('idle sweep disposes only idle sessions that are not running or recovering', () => {
  let now = 0;
  const inUse = new Set<string>();
  const cache = new ChatSessionCache({ sweep: false, now: () => now, idleTimeoutMs: 1000, isInUse: (id) => inUse.has(id) });
  const idle = fakeSession();
  const recent = fakeSession();
  const running = fakeSession();
  const compacting = fakeSession({ isCompacting: true });
  const retrying = fakeSession({ isRetrying: true });
  cache.set('idle', idle.session, baseFingerprint);
  cache.set('running', running.session, baseFingerprint);
  cache.set('compacting', compacting.session, baseFingerprint);
  cache.set('retrying', retrying.session, baseFingerprint);
  inUse.add('running');
  now = 1500;
  cache.set('recent', recent.session, baseFingerprint);
  cache.sweepIdle();
  assert.equal(idle.disposed(), 1);
  assert.equal(recent.disposed(), 0);
  assert.equal(running.disposed(), 0, 'never dispose mid-run');
  assert.equal(compacting.disposed(), 0, 'never dispose mid-compaction');
  assert.equal(retrying.disposed(), 0, 'never dispose mid-retry');
  assert.deepEqual(['compacting', 'recent', 'retrying', 'running'].map((id) => cache.peek(id) !== null), [true, true, true, true]);
});

test('disposeAll disposes every entry', () => {
  const cache = new ChatSessionCache({ sweep: false });
  const sessions = [fakeSession(), fakeSession()];
  sessions.forEach((entry, index) => cache.set(`c${index}`, entry.session, baseFingerprint));
  cache.disposeAll();
  assert.deepEqual(sessions.map((entry) => entry.disposed()), [1, 1]);
  assert.equal(cache.size, 0);
});
