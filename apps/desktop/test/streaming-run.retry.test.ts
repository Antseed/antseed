/**
 * streaming-run must report the outcome of the attempt Pi finally delivered,
 * not of an earlier attempt that Pi auto-retried.
 *
 * Pi (AgentSession) event order for a failed-then-recovered turn:
 *   message_end(assistant, stopReason 'error', retryable errorMessage)
 *   auto_retry_start { attempt 1 }
 *   ...agent.continue()...
 *   message_end(assistant, stopReason 'stop')
 *   auto_retry_end { success: true }
 * and session.prompt() resolves only after waitForRetry().
 *
 * Lives outside src/main because the main-process `node --test` suite runs the
 * compiled output and cannot replace the Pi module. Run with `pnpm run test:main`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep every chat path inside a temp dir: never read or write ~/.antseed.
vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'retry-repro-'));
  process.env.ANTSEED_DESKTOP_ATTACH_ONLY = '1';
  process.env.ANTSEED_DESKTOP_CONNECT_DATA_DIR = dir;
});

type Listener = (event: Record<string, unknown>) => void;
const fake = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
}));

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }));
vi.mock('../src/main/chat/web-fetch.js', () => ({ webFetchTool: { name: 'web_fetch' } }));
vi.mock('../src/main/chat/dev-tools.js', () => ({
  createBrowserPreviewTool: () => ({ name: 'open_browser_preview' }),
  createStartDevServerTool: () => ({ name: 'start_dev_server' }),
}));
vi.mock('../src/main/chat/conversation-title.js', () => ({
  generateConversationTitleWithModel: async () => null,
  getMessageText: () => '',
  shouldGenerateConversationTitleForSession: () => false,
}));
vi.mock('../src/main/chat/proxy-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/chat/proxy-service.js')>();
  return {
    ...actual,
    resolveProxyPort: async () => 1, // never contacted: isProxyAvailable is stubbed
    resolveSystemPrompt: async () => undefined,
    fetchProxyConversationRoute: async () => null, // no network
  };
});
vi.mock('@mariozechner/pi-coding-agent', () => {
  class AuthStorage {
    static inMemory() { return new AuthStorage(); }
    setRuntimeApiKey() {}
  }
  class ModelRegistry {
    static inMemory() { return new ModelRegistry(); }
  }
  class SettingsManager {
    static create() { return new SettingsManager(); }
  }
  class DefaultResourceLoader {
    async reload() {}
  }
  const createAgentSession = async () => {
    const session = {
      messages: [] as unknown[],
      sessionName: 'Existing conversation',
      agent: { sessionId: '' },
      setActiveToolsByName() {},
      async setModel() {},
      setSessionName() {},
      subscribe(listener: Listener) {
        fake.listeners.push(listener);
        return () => { fake.listeners = fake.listeners.filter((l) => l !== listener); };
      },
      async prompt() {
        for (const event of fake.script) {
          for (const listener of [...fake.listeners]) listener(event);
          await Promise.resolve();
        }
      },
      async abort() {},
    };
    return { session };
  };
  return { AuthStorage, ModelRegistry, SettingsManager, DefaultResourceLoader, createAgentSession };
});

const { createStreamingRunner } = await import('../src/main/chat/streaming-run.js');

const CONVERSATION_ID = 'conv-retry-repro';
const RETRYABLE_ERROR = '503 Service Unavailable: upstream overloaded';

function assistant(stopReason: 'stop' | 'error', text: string, errorMessage?: string) {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions',
    provider: 'antseed-proxy',
    model: 'test-model',
    usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function textDelta(delta: string) {
  return {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
  };
}

function harness() {
  const rendererEvents: Array<{ channel: string; payload: unknown }> = [];
  const streamErrors: unknown[] = [];
  const finished: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const workspace = mkdtempSync(path.join(tmpdir(), 'retry-ws-'));
  const sessionManager = {
    buildSessionContext: () => ({ model: { modelId: 'test-model' }, messages: [] }),
    getEntries: () => [],
    getCwd: () => workspace,
    appendCustomEntry: () => {},
  };
  const run = createStreamingRunner({
    store: {
      openSessionManager: async () => sessionManager,
      setPeer: async () => {},
      markPersistedIfAvailable: () => {},
    } as never,
    activeRunsByConversation: new Map(),
    cachedPaymentRequired: new Map(),
    preferredPeerByConversationId: new Map(),
    configPath: path.join(workspace, 'missing-config.json'),
    sendToRenderer: (channel, payload) => { rendererEvents.push({ channel, payload }); },
    appendSystemLog: (line) => { logs.push(line); },
    isBuyerRuntimeRunning: () => true,
    requestToolApproval: async () => 'allow_once',
    cacheFallbackPaymentRequired: () => {},
    emitChatStreamError: (payload) => {
      streamErrors.push(payload);
      rendererEvents.push({ channel: 'chat:ai-stream-error', payload });
    },
    emitPaymentRequiredStreamError: () => { throw new Error('unexpected payment error'); },
    clearActiveRun: () => {},
    abortAndClearActiveRun: async () => {},
    isProxyAvailable: async () => true,
    waitForBuyerProxy: async () => true,
    resolveProtocolForSend: async () => 'openai-chat-completions',
    getServiceCatalogEntries: () => [],
    getBuyerEligibleServiceCatalogEntries: () => [],
    recordChatRequestFinished: (payload) => { finished.push(payload as Record<string, unknown>); },
  });
  return { run, rendererEvents, streamErrors, finished, logs };
}

describe('streaming-run: Pi auto-retry that succeeds', () => {
  beforeEach(() => {
    fake.listeners = [];
    fake.script = [];
  });

  it('control: a plain successful turn is reported as success', async () => {
    fake.script = [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
      textDelta('Hello!'),
      { type: 'message_end', message: assistant('stop', 'Hello!') },
    ];
    const h = harness();
    const result = await h.run(CONVERSATION_ID, 'hi');
    expect(result.ok).toBe(true);
    expect(h.finished[0]?.outcome).toBe('success');
  });

  it('a retryable error followed by a successful retry is reported as success', async () => {
    fake.script = [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
      // Attempt 1: stream errors with a message Pi's _isRetryableError matches.
      { type: 'message_end', message: assistant('error', '', RETRYABLE_ERROR) },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: RETRYABLE_ERROR },
      // Attempt 2 (agent.continue()): succeeds.
      { type: 'turn_start' },
      textDelta('Recovered answer.'),
      { type: 'message_end', message: assistant('stop', 'Recovered answer.') },
      { type: 'auto_retry_end', success: true, attempt: 1 },
    ];
    const h = harness();
    const result = await h.run(CONVERSATION_ID, 'hi');

    expect(h.logs.some((line) => line.includes('AI stream retry succeeded'))).toBe(true);
    expect(h.streamErrors).toEqual([]);
    expect(h.rendererEvents.map((e) => e.channel)).toContain('chat:ai-done');
    expect(result.ok).toBe(true);
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]).toMatchObject({
      outcome: 'success',
      failure_code: 'none',
      automatic_retry_attempted: true,
      automatic_retry_succeeded: true,
    });
  });

  it('reports the last error when every retry fails', async () => {
    fake.script = [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
      { type: 'message_end', message: assistant('error', '', RETRYABLE_ERROR) },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 2000, errorMessage: RETRYABLE_ERROR },
      { type: 'turn_start' },
      { type: 'message_end', message: assistant('error', '', '502 Bad Gateway') },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: '502 Bad Gateway' },
    ];
    const h = harness();
    const result = await h.run(CONVERSATION_ID, 'hi');

    expect(result.ok).toBe(false);
    expect(h.streamErrors).toHaveLength(1);
    expect(h.streamErrors[0]).toMatchObject({ error: '502 Bad Gateway' });
    expect(h.rendererEvents.map((e) => e.channel)).not.toContain('chat:ai-done');
    expect(h.finished[0]).toMatchObject({
      outcome: 'failed',
      automatic_retry_attempted: true,
      automatic_retry_succeeded: false,
    });
  });

  it('reports a failure when the retry is cancelled during its backoff', async () => {
    fake.script = [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
      { type: 'message_end', message: assistant('error', '', RETRYABLE_ERROR) },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: RETRYABLE_ERROR },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' },
    ];
    const h = harness();
    const result = await h.run(CONVERSATION_ID, 'hi');

    expect(result.ok).toBe(false);
    expect(h.streamErrors).toHaveLength(1);
    expect(h.rendererEvents.map((e) => e.channel)).not.toContain('chat:ai-done');
    expect(h.finished[0]).toMatchObject({ automatic_retry_succeeded: false });
    expect(h.finished[0]?.outcome).not.toBe('success');
  });

  it('does not count output from the abandoned attempt as partial output', async () => {
    fake.script = [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
      textDelta('Half an ans'),
      { type: 'message_end', message: assistant('error', 'Half an ans', 'terminated') },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' },
      { type: 'turn_start' },
      { type: 'message_end', message: assistant('error', '', 'terminated') },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'terminated' },
    ];
    const h = harness();
    await h.run(CONVERSATION_ID, 'hi');

    expect(h.finished[0]).toMatchObject({ outcome: 'failed', had_partial_output: false });
  });
});
