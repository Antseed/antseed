import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSessionEvent, type ExtensionFactory,
} from '@mariozechner/pi-coding-agent';
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from '@mariozechner/pi-ai';

import { OverflowRecoveryTracker } from './overflow-recovery.js';

const CONTEXT_WINDOW = 280_000;

function assistantEnd(errorMessage: string | undefined, stopReason: 'error' | 'stop'): AgentSessionEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'antseed-proxy',
      model: 'opus',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    },
  } as AgentSessionEvent;
}

const REQUEST_TOO_LARGE = '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}';

test('waits through overflow compaction and the retried run', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 50);
  assert.equal(tracker.observe(assistantEnd(REQUEST_TOO_LARGE, 'error')), null);
  assert.equal(tracker.pending, true);

  let settled = false;
  const waiting = tracker.waitUntilSettled().then(() => { settled = true; });

  tracker.observe({ type: 'agent_end', messages: [] } as AgentSessionEvent);
  tracker.observe({ type: 'compaction_start', reason: 'overflow' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, 'compaction itself is not time-limited');

  const transition = tracker.observe({
    type: 'compaction_end', reason: 'overflow', result: undefined, aborted: false, willRetry: true,
  });
  assert.equal(transition, 'retry_scheduled');
  tracker.observe({ type: 'agent_start' } as AgentSessionEvent);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, 'the retried run is not time-limited');

  tracker.observe(assistantEnd(undefined, 'stop'));
  tracker.observe({ type: 'agent_end', messages: [] } as AgentSessionEvent);
  await waiting;
  assert.equal(settled, true);
  assert.equal(tracker.pending, false);
});

test('reports failed recovery and settles', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 50);
  tracker.observe(assistantEnd(REQUEST_TOO_LARGE, 'error'));
  tracker.observe({ type: 'compaction_start', reason: 'overflow' });
  const transition = tracker.observe({
    type: 'compaction_end',
    reason: 'overflow',
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt.',
  });
  assert.equal(transition, 'recovery_failed');
  assert.match(tracker.failureMessage ?? '', /recovery failed/);
  await tracker.waitUntilSettled();
});

test('ignores non-overflow errors and disabled compaction', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 50);
  tracker.observe(assistantEnd('502 Bad Gateway', 'error'));
  assert.equal(tracker.pending, false);
  await tracker.waitUntilSettled();

  const disabled = new OverflowRecoveryTracker(CONTEXT_WINDOW, false, 50);
  disabled.observe(assistantEnd(REQUEST_TOO_LARGE, 'error'));
  assert.equal(disabled.pending, false);
});

test('does not hang when Pi never starts compaction', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 30);
  tracker.observe(assistantEnd(REQUEST_TOO_LARGE, 'error'));
  const started = Date.now();
  await tracker.waitUntilSettled();
  assert.ok(Date.now() - started >= 25);
  assert.equal(tracker.pending, false);
});

test('cancel releases a pending wait', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 10_000);
  tracker.observe(assistantEnd(REQUEST_TOO_LARGE, 'error'));
  tracker.observe({ type: 'compaction_start', reason: 'overflow' });
  const waiting = tracker.waitUntilSettled();
  tracker.cancel();
  await waiting;
  assert.equal(tracker.pending, false);
});


test('a scheduled retry that never starts is a failure, not success', async () => {
  const tracker = new OverflowRecoveryTracker(CONTEXT_WINDOW, true, 10);
  tracker.observe(assistantEnd(REQUEST_TOO_LARGE, 'error'));
  tracker.observe({ type: 'compaction_start', reason: 'overflow' });
  tracker.observe({
    type: 'compaction_end', reason: 'overflow', result: undefined, aborted: false, willRetry: true,
  });
  await tracker.waitUntilSettled();
  assert.match(tracker.failureMessage ?? '', /did not start/i);
});

// Exercise the installed SDK's event ordering and real compaction/retry loop.
// The faux provider is entirely local: no HTTP requests or credentials are used.
async function createRecoverySession(
  t: test.TestContext,
  replies: AssistantMessage[],
  extensions: ExtensionFactory[] = [],
) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'antseed-overflow-test-'));
  const provider = registerFauxProvider({
    provider: path.basename(cwd),
    api: path.basename(cwd),
    tokensPerSecond: 1e9,
    models: [{ id: 'test', contextWindow: CONTEXT_WINDOW, maxTokens: 2048 }],
  });
  const model = provider.getModel();
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, 'local-test-key');
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: extensions,
    systemPrompt: 'Local recovery test.',
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  for (let i = 0; i < 10; i++) {
    sessionManager.appendMessage({
      role: 'user', content: [{ type: 'text', text: 'old history '.repeat(1000) }], timestamp: Date.now() - 10000 + i,
    });
    sessionManager.appendMessage({
      ...fauxAssistantMessage('old answer '.repeat(1000)),
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() - 9000 + i,
    });
  }
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, authStorage, settingsManager, sessionManager, resourceLoader, model, noTools: 'all',
  });
  t.after(async () => {
    session.abortCompaction();
    await session.abort();
    session.dispose();
    provider.unregister();
    await rm(cwd, { recursive: true, force: true });
  });
  let attempt = 0;
  provider.setResponses(Array.from({ length: 20 }, () => (context) => {
    if (context.systemPrompt !== session.systemPrompt) return fauxAssistantMessage('Summarized old history.');
    const reply = replies[attempt++];
    assert.ok(reply, 'no unexpected extra request');
    return { ...reply, timestamp: Date.now() };
  }));
  const tracker = new OverflowRecoveryTracker(model.contextWindow, true);
  const unsubscribeAgent = session.agent.subscribe((event) => {
    if (event.type === 'message_end') tracker.observe(event);
  });
  t.after(unsubscribeAgent);
  let error: string | null = null;
  let answer: string | null = null;
  session.subscribe((event) => {
    const transition = tracker.observe(event, session.isRetrying);
    if (transition === 'retry_started') error = null;
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
        error = event.message.errorMessage ?? 'Request aborted';
      } else {
        answer = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      }
    }
  });
  return { session, tracker, result: () => ({ error, answer, attempts: attempt }) };
}

const overflowReply = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE });
const transientReply = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '502 Bad Gateway' });

test('Pi recovery finishes before the per-request session is disposed', { timeout: 5000 }, async (t) => {
  const { session, tracker, result } = await createRecoverySession(t, [
    overflowReply(), fauxAssistantMessage('Recovered answer'),
  ]);
  await session.prompt('Please answer.');
  assert.equal(result().answer, null, 'prompt returns before the overflow retry');
  await tracker.waitUntilSettled();
  session.dispose();
  assert.deepEqual(result(), { error: null, answer: 'Recovered answer', attempts: 2 });
});

test('Pi transient retries after compaction finish before cleanup', { timeout: 5000 }, async (t) => {
  const { session, tracker, result } = await createRecoverySession(t, [
    overflowReply(), transientReply(), fauxAssistantMessage('Recovered after 502'),
  ]);
  await session.prompt('Please answer.');
  await tracker.waitUntilSettled();
  assert.equal(session.isRetrying, false, 'must not clean up while Pi still has a retry pending');
  session.dispose();
  assert.deepEqual(result(), { error: null, answer: 'Recovered after 502', attempts: 3 });
});

test('Pi exhausted retries after compaction remain failures', { timeout: 5000 }, async (t) => {
  const { session, tracker, result } = await createRecoverySession(t, [
    overflowReply(), transientReply(), transientReply(),
  ]);
  await session.prompt('Please answer.');
  await tracker.waitUntilSettled();
  assert.equal(session.isRetrying, false);
  assert.deepEqual(result(), { error: '502 Bad Gateway', answer: null, attempts: 3 });
});

test('delayed Pi extension events do not let cleanup overtake recovery', { timeout: 5000 }, async (t) => {
  const { session, tracker, result } = await createRecoverySession(t, [
    overflowReply(), fauxAssistantMessage('Recovered with delayed events'),
  ], [(pi) => {
    pi.on('agent_start', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }]);
  await session.prompt('Please answer.');
  await tracker.waitUntilSettled();
  assert.deepEqual(result(), { error: null, answer: 'Recovered with delayed events', attempts: 2 });
});

test('Pi reports a second overflow as failure instead of retrying indefinitely', { timeout: 5000 }, async (t) => {
  const { session, tracker, result } = await createRecoverySession(t, [overflowReply(), overflowReply()]);
  await session.prompt('Please answer.');
  await tracker.waitUntilSettled();
  assert.match(tracker.failureMessage ?? '', /after one compact-and-retry attempt/i);
  assert.equal(result().attempts, 2);
  assert.equal(result().answer, null);
});

for (const phase of ['compaction_start', 'auto_retry_start'] as const) {
  test(`cancelling during Pi ${phase} releases cleanup and preserves the abort`, { timeout: 5000 }, async (t) => {
    const { session, tracker, result } = await createRecoverySession(t, [
      overflowReply(), transientReply(), fauxAssistantMessage('Must not reach this answer'),
    ]);
    let abortTask: Promise<void> | undefined;
    session.subscribe((event) => {
      if (event.type === phase) {
        // Pi installs the abort controller just after emitting the start event.
        queueMicrotask(() => {
          tracker.cancel();
          session.abortCompaction();
          abortTask = session.abort();
        });
      }
    });
    await session.prompt('Please answer.');
    await tracker.waitUntilSettled();
    await abortTask;
    assert.equal(tracker.failureMessage, 'Request aborted');
    assert.equal(session.isRetrying, false);
    assert.equal(result().answer, null);
  });
}
