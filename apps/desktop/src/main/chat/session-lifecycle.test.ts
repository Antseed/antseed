/**
 * Long-lived Pi session lifecycle, end to end through the real chat engine
 * (`registerPiChatHandlers` + `createStreamingRunner`) and the installed Pi
 * SDK. The proxy wire is replaced by Pi's local faux provider registered
 * under the proxy model's API id; no HTTP requests or credentials are used.
 * Electron is stubbed and HOME points at a temp dir so session files and
 * settings stay out of the user's profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, Context } from '@mariozechner/pi-ai';

const electronStub = [
  'export const app = { getPath: () => process.env.HOME, isPackaged: false, on() {}, whenReady: async () => {} };',
  'export class BrowserWindow { static getAllWindows() { return []; } }',
  'export const net = {}; export const protocol = { handle() {}, registerSchemesAsPrivileged() {} };',
  'export const shell = {}; export const dialog = {}; export const ipcMain = {};',
  'export default {};',
].join('\n');
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown,
) => unknown;
// Node 24 API; the repo's @types/node predates it.
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve: ResolveHook }): void };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: `data:text/javascript,${encodeURIComponent(electronStub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(path.join(tmpdir(), 'antseed-session-lifecycle-'));
process.env.HOME = home;
const agentDir = path.join(home, '.antseed', 'chat', 'pi-agent');
await mkdir(agentDir, { recursive: true });
// Tight compaction/retry settings so the 413 recovery path runs in milliseconds.
await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
  compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
  retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 },
}));

const { registerFauxProvider, fauxAssistantMessage } = await import('@mariozechner/pi-ai');
const { registerPiChatHandlers } = await import('./engine.js');
const { SessionManager } = await import('@mariozechner/pi-coding-agent');

const REQUEST_TOO_LARGE = '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}';
const SUMMARY_MARKER = 'context summarization assistant';

type Reply = AssistantMessage | ((context: Context, signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>);

// The proxy model uses api 'anthropic-messages'; route that api to a faux
// provider for the whole file. Requests are answered from `replies`; Pi's
// compaction summary requests are answered automatically.
const faux = registerFauxProvider({
  api: 'anthropic-messages',
  provider: 'antseed-proxy',
  tokensPerSecond: 1e9,
  // One delta per reply keeps the large seeded history cheap to stream.
  tokenSize: { min: 1_000_000, max: 1_000_000 },
});
let replies: Reply[] = [];
let requests = 0;
const nextReply = async (context: Context, options?: { signal?: AbortSignal }): Promise<AssistantMessage> => {
  if (context.systemPrompt?.includes(SUMMARY_MARKER)) return fauxAssistantMessage('Summarized old history.');
  requests += 1;
  const reply = replies.shift();
  assert.ok(reply, 'no unexpected extra request');
  const resolved = typeof reply === 'function' ? await reply(context, options?.signal) : reply;
  return { ...resolved, timestamp: Date.now() };
};
faux.setResponses(Array.from({ length: 200 }, () => nextReply));

/** A reply that is held until released or until the request is aborted (like a real stream). */
function heldReply(text: string): { reply: Reply; started: Promise<void>; release: () => void } {
  let release = (): void => {};
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const reply: Reply = async (_context, signal) => {
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return fauxAssistantMessage(text);
  };
  return { reply, started, release: () => release() };
}

// Stand-in buyer proxy for the engine's side requests (catalog, title,
// conversation route). Chat completions never reach it: they go to the faux
// provider. A 404 makes every side request fall back exactly as offline.
// Image generation succeeds only while `imageServiceUp` is set.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let imageServiceUp = false;
const proxyServer: Server = createServer((request, response) => {
  if (imageServiceUp && request.url === '/v1/images/generations') {
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxyServer.address() as { port: number }).port;
const configPath = path.join(home, 'config.json');
await writeFile(configPath, JSON.stringify({ buyer: { proxyPort } }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const rendererEvents: Array<{ channel: string; payload: Record<string, unknown> }> = [];
const engine = registerPiChatHandlers({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
  sendToRenderer: (channel, payload) => rendererEvents.push({ channel, payload: payload as Record<string, unknown> }),
  configPath,
  isBuyerRuntimeRunning: () => true,
  appendSystemLog: () => {},
});

test.after(async () => {
  engine.dispose();
  faux.unregister();
  await new Promise((resolve) => proxyServer.close(resolve));
  await rm(home, { recursive: true, force: true });
});

const invoke = async <T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> => {
  const handler = handlers.get(channel);
  assert.ok(handler, `missing handler ${channel}`);
  return await handler({}, ...args) as T;
};

/**
 * Sessions are observed through Pi's `dispose()`; the engine never exposes
 * them directly, so record every disposal by patching the prototype once.
 */
const { AgentSession: AgentSessionClass } = await import('@mariozechner/pi-coding-agent');
const disposed = new Set<AgentSession>();
const originalDispose = AgentSessionClass.prototype.dispose;
AgentSessionClass.prototype.dispose = function patchedDispose(this: AgentSession) {
  disposed.add(this);
  return originalDispose.call(this);
};
const created: AgentSession[] = [];
const originalPrompt = AgentSessionClass.prototype.prompt;
AgentSessionClass.prototype.prompt = function patchedPrompt(this: AgentSession, ...args: Parameters<AgentSession['prompt']>) {
  if (!created.includes(this)) created.push(this);
  return originalPrompt.apply(this, args);
};

async function newConversation(): Promise<string> {
  const result = await invoke<{ ok: boolean; data: { id: string } }>('chat:ai-create-conversation', 'opus');
  assert.equal(result.ok, true);
  return result.data.id;
}

function send(conversationId: string, text: string, permissionMode?: string) {
  return invoke<{ ok: boolean; error?: string }>(
    'chat:ai-send-stream', conversationId, text, 'opus', undefined, undefined, undefined, permissionMode,
  );
}

function eventsFor(conversationId: string, channel: string) {
  return rendererEvents.filter((event) => event.channel === channel && event.payload.conversationId === conversationId);
}

function doneText(conversationId: string): string[] {
  return eventsFor(conversationId, 'chat:ai-done').map((event) => {
    const message = event.payload.message as { content: unknown };
    return Array.isArray(message.content)
      ? (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text').map((block) => block.text).join('')
      : String(message.content);
  });
}

function sessionsUsedSince(start: number): AgentSession[] {
  return created.slice(start);
}

async function seedHistory(conversationId: string): Promise<void> {
  // Large prior history so Pi has something to compact on overflow.
  replies = [fauxAssistantMessage('old answer '.repeat(2000))];
  for (let index = 0; index < 4; index += 1) {
    replies.push(fauxAssistantMessage('old answer '.repeat(2000)));
  }
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await send(conversationId, `old history ${index} ${'x '.repeat(2000)}`)).ok, true);
  }
  assert.equal(replies.length, 0);
}

test('reuses one Pi session across sends and keeps the same turn signals', async () => {
  const id = await newConversation();
  const before = created.length;
  replies = [fauxAssistantMessage('first answer'), fauxAssistantMessage('second answer')];
  assert.deepEqual(await send(id, 'hello'), { ok: true });
  assert.deepEqual(await send(id, 'again'), { ok: true });
  const used = sessionsUsedSince(before);
  assert.equal(used.length, 1, 'both sends reused one AgentSession');
  assert.equal(disposed.has(used[0]!), false, 'session outlives the turn');
  assert.deepEqual(doneText(id), ['first answer', 'second answer']);
  assert.equal(eventsFor(id, 'chat:ai-stream-done').length, 2);
  assert.equal(eventsFor(id, 'chat:ai-user-persisted').length, 2);
  // Both turns persisted through the single live SessionManager.
  const reloaded = await invoke<{ data: { messages: Array<{ role: string }> } }>('chat:ai-get-conversation', id);
  assert.deepEqual(reloaded.data.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
});

test('a reused session picks up workspace context edits on the next send', async () => {
  const id = await newConversation();
  const before = created.length;
  let systemPrompt = '';
  replies = [fauxAssistantMessage('first'), (context) => {
    systemPrompt = context.systemPrompt ?? '';
    return fauxAssistantMessage('second');
  }];
  assert.equal((await send(id, 'one')).ok, true);
  const live = sessionsUsedSince(before)[0]!;
  await writeFile(path.join(live.sessionManager.getCwd(), 'AGENTS.md'), 'WORKSPACE-RULE-MARKER');
  assert.equal((await send(id, 'two')).ok, true);
  assert.equal(sessionsUsedSince(before).length, 1, 'session was reused');
  assert.match(systemPrompt, /WORKSPACE-RULE-MARKER/);
});

test('rebuilds the session when a baked-in input changes', async () => {
  const id = await newConversation();
  const before = created.length;
  replies = [fauxAssistantMessage('manual'), fauxAssistantMessage('full')];
  assert.equal((await send(id, 'one', 'manual')).ok, true);
  assert.equal((await send(id, 'two', 'full')).ok, true);
  const used = sessionsUsedSince(before);
  assert.equal(used.length, 2, 'permission mode change rebuilt the session');
  assert.equal(disposed.has(used[0]!), true, 'old session disposed on rebuild');
  assert.equal(disposed.has(used[1]!), false);
  // The rebuilt session reloaded the full history from disk.
  assert.equal(used[1]!.messages.filter((message) => message.role === 'user').length, 2);
});

test('store writes go through the live session manager without stale history', async () => {
  const id = await newConversation();
  const before = created.length;
  replies = [fauxAssistantMessage('a1'), fauxAssistantMessage('a2')];
  assert.equal((await send(id, 'q1')).ok, true);
  assert.deepEqual(await invoke('chat:ai-rename-conversation', id, 'Renamed chat'), { ok: true });
  assert.equal((await send(id, 'q2')).ok, true);
  assert.equal(sessionsUsedSince(before).length, 1, 'rename does not force a rebuild');
  const conversation = await invoke<{ data: { title: string; messages: Array<{ role: string }> } }>('chat:ai-get-conversation', id);
  assert.equal(conversation.data.title, 'Renamed chat');
  assert.deepEqual(conversation.data.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  // The on-disk file is a single linear history (no forked/overwritten tail).
  const file = sessionsUsedSince(before)[0]!.sessionManager.getSessionFile()!;
  const fromDisk = SessionManager.open(file, path.dirname(file));
  const entryIds = fromDisk.getEntries().map((entry) => entry.id);
  assert.equal(new Set(entryIds).size, entryIds.length, 'no duplicate entries');
  assert.equal(fromDisk.getBranch().length, entryIds.length, 'every entry is on the active branch');
});

test('only a successful image generation invalidates the cached session', async () => {
  const id = await newConversation();
  const before = created.length;
  replies = [fauxAssistantMessage('before image'), fauxAssistantMessage('after failed image')];
  assert.equal((await send(id, 'q1')).ok, true);
  const failed = await invoke<{ ok: boolean }>('chat:generate-image', { conversationId: id, prompt: 'dog picture', service: 'img' });
  assert.equal(failed.ok, false);
  assert.equal((await send(id, 'q2')).ok, true);
  assert.equal(sessionsUsedSince(before).length, 1, 'a failed image request keeps the session');

  imageServiceUp = true;
  try {
    const generated = await invoke<{ ok: boolean }>('chat:generate-image', { conversationId: id, prompt: 'cat picture', service: 'img' });
    assert.equal(generated.ok, true);
  } finally {
    imageServiceUp = false;
  }
  let sawImageTurn = false;
  replies = [(context) => {
    sawImageTurn = context.messages.some((message) => message.role === 'user'
      && JSON.stringify(message.content).includes('cat picture'));
    return fauxAssistantMessage('after image');
  }];
  assert.equal((await send(id, 'q3')).ok, true);
  assert.equal(sessionsUsedSince(before).length, 2, 'image turn forced a rebuild from the session file');
  assert.equal(sawImageTurn, true, 'rebuilt session includes the image turn');
});

test('abort keeps the session and the next send reuses it', async () => {
  const id = await newConversation();
  const before = created.length;
  const slow = heldReply('too late');
  replies = [slow.reply, fauxAssistantMessage('after abort')];
  const pending = send(id, 'slow');
  await slow.started;
  await invoke('chat:ai-abort', id);
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.match(String(eventsFor(id, 'chat:ai-stream-error').at(-1)?.payload.error), /aborted/i);
  assert.deepEqual(await send(id, 'next'), { ok: true });
  const used = sessionsUsedSince(before);
  assert.equal(used.length, 1, 'abort did not dispose the session');
  assert.equal(disposed.has(used[0]!), false);
  assert.equal(doneText(id).at(-1), 'after abort');
});

test('a second send while one is in flight cancels the first, as before', async () => {
  const id = await newConversation();
  const slow = heldReply('stale');
  replies = [slow.reply, fauxAssistantMessage('winner')];
  const first = send(id, 'first');
  await slow.started;
  const second = send(id, 'second');
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, false);
  assert.deepEqual(secondResult, { ok: true });
  assert.deepEqual(doneText(id), ['winner']);
});

test('overflow 413 -> compaction -> recovered answer is delivered in the same turn', { timeout: 20_000 }, async () => {
  const id = await newConversation();
  await seedHistory(id);
  const before = created.length;
  const doneBefore = doneText(id).length;
  replies = [
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE }),
    fauxAssistantMessage('Recovered answer'),
  ];
  assert.deepEqual(await send(id, 'Please answer.'), { ok: true });
  assert.equal(replies.length, 0, 'Pi issued the post-compaction retry');
  assert.deepEqual(doneText(id).slice(doneBefore), ['Recovered answer']);
  const session = sessionsUsedSince(before)[0] ?? created.at(-1)!;
  assert.equal(session.isCompacting || session.isRetrying || session.isStreaming, false);
  assert.equal(disposed.has(session), false);
  // And the session is still usable afterwards.
  replies = [fauxAssistantMessage('next turn')];
  assert.deepEqual(await send(id, 'and now?'), { ok: true });
  assert.equal(doneText(id).at(-1), 'next turn');
});

test('overflow then transient 502 retry still recovers before the turn ends', { timeout: 20_000 }, async () => {
  const id = await newConversation();
  await seedHistory(id);
  const doneBefore = doneText(id).length;
  replies = [
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE }),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: '502 Bad Gateway' }),
    fauxAssistantMessage('Recovered after 502'),
  ];
  assert.deepEqual(await send(id, 'Please answer.'), { ok: true });
  assert.deepEqual(doneText(id).slice(doneBefore), ['Recovered after 502']);
});

test('a second overflow is reported as a failure, not retried forever', { timeout: 20_000 }, async () => {
  const id = await newConversation();
  await seedHistory(id);
  const requestsBefore = requests;
  replies = [
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE }),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE }),
  ];
  const result = await send(id, 'Please answer.');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /after one compact-and-retry attempt/i);
  assert.equal(requests - requestsBefore, 2);
});

for (const phase of ['compaction_start', 'compaction_end'] as const) {
  test(`aborting during overflow ${phase} ends the turn and keeps the session usable`, { timeout: 20_000 }, async () => {
    const id = await newConversation();
    await seedHistory(id);
    const live = created.at(-1)!;
    const requestsBefore = requests;
    replies = [
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: REQUEST_TOO_LARGE }),
      fauxAssistantMessage('Must not reach this answer'),
    ];
    const unsubscribe = live.subscribe((event) => {
      if (event.type === phase) {
        unsubscribe();
        // Pi installs its abort controller right after emitting the start event.
        queueMicrotask(() => { void invoke('chat:ai-abort', id); });
      }
    });
    const result = await send(id, 'Please answer.');
    assert.equal(result.ok, false);
    assert.equal(requests - requestsBefore, 1, 'the scheduled continuation never reached the provider');
    assert.equal(doneText(id).includes('Must not reach this answer'), false);
    replies = [fauxAssistantMessage('fresh turn')];
    assert.deepEqual(await send(id, 'next'), { ok: true });
    assert.equal(doneText(id).at(-1), 'fresh turn');
    assert.equal(disposed.has(live), false, 'abort did not dispose the session');
  });
}

test('deleting a conversation disposes its session', async () => {
  const id = await newConversation();
  const before = created.length;
  replies = [fauxAssistantMessage('bye')];
  assert.equal((await send(id, 'hi')).ok, true);
  const session = sessionsUsedSince(before)[0]!;
  assert.equal(disposed.has(session), false);
  assert.deepEqual(await invoke('chat:ai-delete-conversation', id), { ok: true });
  assert.equal(disposed.has(session), true);
});

test('engine.dispose (app quit) disposes every cached session', async () => {
  const ids = [await newConversation(), await newConversation()];
  const before = created.length;
  replies = [fauxAssistantMessage('one'), fauxAssistantMessage('two')];
  for (const id of ids) assert.equal((await send(id, 'hi')).ok, true);
  const sessions = sessionsUsedSince(before);
  assert.equal(sessions.length, 2);
  engine.dispose();
  assert.deepEqual(sessions.map((session) => disposed.has(session)), [true, true]);
});
