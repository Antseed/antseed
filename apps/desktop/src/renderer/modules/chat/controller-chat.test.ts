import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initChatModule } from './controller';

type Handler = (data: never) => void;
type Conv = { id: string; title: string; service: string; messages: unknown[]; createdAt: number; updatedAt: number; usage: { inputTokens: number; outputTokens: number }; workspacePath?: string };

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 400): Promise<void> {
  for (let i = 0; i < ms / 2 && !predicate(); i++) await tick(2);
  expect(predicate()).toBe(true);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const model = (id: string) => ({ id, label: id, type: 'text', protocol: 'openai-chat-completions', supportsImages: false, sellers: 1, free: false, minImageUsd: null, freeSellerId: null, freeForStakers: false, tee: false, toolUse: true, reasoning: false, inputUsdPerMillion: null, outputUsdPerMillion: null });
const conv = (id: string, service: string, workspacePath?: string): Conv => ({ id, title: id, service, messages: [], createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0 }, ...(workspacePath ? { workspacePath } : {}) });

function setup(conversations: Conv[] = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')], overrides: Record<string, unknown> = {}) {
  const uiState = createInitialUiState();
  uiState.chatModels = [model('model-a'), model('model-b')] as never;
  uiState.chatSelectedModelId = 'model-a';
  // Funded unless a test says otherwise: an unfunded first message waits for a free model.
  uiState.creditsBalanceKnown = true;
  uiState.creditsTotalOwnedUsdc = '5';
  const sends: Array<{ convId: string; content: string; modelId: string }> = [];
  const handlers: Record<string, Handler[]> = {};
  const on = (name: string) => (handler: Handler) => { (handlers[name] ??= []).push(handler); return () => undefined; };
  const bridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id: string) => {
      const found = conversations.find((candidate) => candidate.id === id);
      return found ? { ok: true, data: { ...found, messages: [...found.messages] } } : { ok: false, error: 'not found' };
    },
    chatAiCreateConversation: async (service: string) => {
      const created = conv(`conv-${conversations.length + 1}`, service);
      conversations.push(created);
      return { ok: true, data: created };
    },
    chatAiSetModel: async () => ({ ok: true }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (convId: string, content: string, modelId: string) => {
      sends.push({ convId, content, modelId });
      return { ok: true };
    },
    onChatAiStreamStart: on('start'),
    onChatAiStreamBlockStart: on('blockStart'),
    onChatAiStreamDelta: on('delta'),
    onChatAiStreamDone: on('done'),
    onChatAiStreamError: on('error'),
    onChatAiDone: on('aiDone'),
    onChatAiUserPersisted: on('userPersisted'),
    ...overrides,
  };
  const api = initChatModule({ bridge: bridge as never, uiState, appendSystemLog: () => undefined });
  const emit = (name: string, data: unknown) => { for (const handler of handlers[name] ?? []) handler(data as never); };
  return { api, uiState, sends, emit };
}

describe('chat controller', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined }, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('removes a deleted conversation from the list before the deletion settles', async () => {
    const deletion = deferred<{ ok: boolean }>();
    const { api, uiState } = setup(undefined, { chatAiDeleteConversation: () => deletion.promise });
    await api.refreshChatConversations();
    const deleting = api.deleteConversation('conv-b');
    expect((uiState.chatConversations as Conv[]).map((c) => c.id)).toEqual(['conv-a']);
    deletion.resolve({ ok: true });
    await deleting;
  });

  it('hands back why an archive or delete failed, so the sidebar can say it outside Chat', async () => {
    const { api, uiState } = setup(undefined, {
      chatAiSetConversationFlags: async () => ({ ok: false, error: 'disk full' }),
      chatAiDeleteConversation: async () => ({ ok: false, error: 'locked' }),
    });
    await api.refreshChatConversations();
    expect(await api.setConversationFlags('conv-b', { archived: true })).toBe('disk full');
    expect((uiState.chatConversations as Array<Conv & { archivedAt?: number }>).find((c) => c.id === 'conv-b')?.archivedAt).toBeUndefined();
    expect(await api.deleteConversation('conv-b')).toBe('locked');
    expect((uiState.chatConversations as Conv[]).map((c) => c.id)).toContain('conv-b');
  });

  it('a chat whose delete fails keeps its image prompt and Try again', async () => {
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: false, stopReason: { kind: 'payment_required', message: 'Add funds' } });
    const { api, uiState } = setup(undefined, { chatGenerateImage, chatAiDeleteConversation: async () => ({ ok: false, error: 'locked' }) });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    await api.refreshChatConversations();
    await api.openConversation('conv-b');
    uiState.chatImageModelId = 'image-model';
    api.generateImage('a cat');
    await waitFor(() => uiState.chatFundsNotice !== null);
    expect(await api.deleteConversation('conv-b')).toBe('locked');
    await api.openConversation('conv-b');
    expect(uiState.chatFundsNotice).not.toBeNull();
    expect(JSON.stringify(uiState.chatMessages)).toContain('a cat');
    api.retryAfterPayment();
    await waitFor(() => chatGenerateImage.mock.calls.length === 2);
    expect(chatGenerateImage.mock.calls[1]![0]).toMatchObject({ conversationId: 'conv-b', prompt: 'a cat' });
  });

  it.each([
    ['a reply', { ok: true, user: { role: 'user', content: 'first', createdAt: 1 }, assistant: { role: 'assistant', content: 'old image reply', createdAt: 2 } }],
    ['a funds retry', { ok: false, stopReason: { kind: 'payment_required', message: 'Add funds' } }],
  ])('a stopped image request whose result lands after a follow-up started adds no %s', async (_label, oldResult) => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const chatGenerateImage = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { api, uiState } = setup(undefined, { chatGenerateImage, chatAiAbort: async () => ({ ok: true }) });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    await api.refreshChatConversations();
    await api.openConversation('conv-b');
    uiState.chatImageModelId = 'image-model';
    api.generateImage('first');
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    await api.abortChat();
    api.generateImage('second');
    await waitFor(() => chatGenerateImage.mock.calls.length === 2);
    first.resolve(oldResult);
    await tick(20);
    expect(JSON.stringify(uiState.chatMessages)).not.toContain('old image reply');
    expect(uiState.chatFundsNotice).toBeNull();
    // The follow-up still owns the chat and finishes normally.
    expect(uiState.chatSending).toBe(true);
    second.resolve({ ok: true, user: { role: 'user', content: 'second', createdAt: 3 }, assistant: { role: 'assistant', content: 'new image reply', createdAt: 4 } });
    await waitFor(() => JSON.stringify(uiState.chatMessages).includes('new image reply'));
    expect(uiState.chatSending).toBe(false);
  });

  it('a stopped text message that comes back "already in progress" is never sent again', async () => {
    const answer = deferred<{ ok: boolean; error?: string }>();
    const chatAiSendStream = vi.fn().mockImplementationOnce(() => answer.promise).mockResolvedValue({ ok: true });
    const chatAiAbort = vi.fn().mockResolvedValue({ ok: true });
    const { api } = setup(undefined, { chatAiSendStream, chatAiAbort });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await waitFor(() => chatAiSendStream.mock.calls.length === 1);
    await api.abortChat();
    answer.resolve({ ok: false, error: 'A request is already in progress' });
    await tick(20);
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
  });

  it('an image prompt sent while a chat opens edits that chat\'s image, never the previous chat\'s', async () => {
    const generated = (attachmentId: string) => ({ role: 'assistant', content: [{ type: 'file', generated: true, attachmentId, mimeType: 'image/png', name: `${attachmentId}.png` }], createdAt: 2 });
    const convA = { ...conv('conv-a', 'model-a'), messages: [generated('img-a')] };
    const convB = { ...conv('conv-b', 'model-b'), messages: [generated('img-b')] };
    const bOpened = deferred<void>();
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: false, stopReason: { kind: 'payment_required', message: 'Add funds' } });
    const { api, uiState } = setup([convA, convB], {
      chatGenerateImage,
      chatAiGetConversation: async (id: string) => {
        if (id === 'conv-b') await bOpened.promise;
        const found = id === 'conv-a' ? convA : id === 'conv-b' ? convB : null;
        return found ? { ok: true, data: { ...found, messages: [...found.messages] } } : { ok: false, error: 'not found' };
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image', supportsImages: true }] as never;
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    uiState.chatImageModelId = 'image-model';
    // Chat B is opening for the first time; A's image is still on screen.
    const opening = api.openConversation('conv-b', { keepImageModel: true });
    expect(uiState.chatActiveConversation).toBe('conv-b');
    api.generateImage('make it blue');
    await tick(10);
    bOpened.resolve();
    await opening;
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    const request = chatGenerateImage.mock.calls[0]![0] as { conversationId: string; sourceImageAttachmentId?: string };
    expect(request.conversationId).toBe('conv-b');
    expect(request.sourceImageAttachmentId).toBe('img-b');
  });

  it('the workspace holds still until a first message\'s chat exists, then follows a chat opened meanwhile', async () => {
    const created = deferred<void>();
    const setWorkspace: string[] = [];
    const pickDirectory = vi.fn().mockResolvedValue({ ok: true, path: '/picked' });
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b', '/project-b')];
    const createdOn: string[] = [];
    let current = '/project-a';
    const { api, uiState, sends } = setup(conversations, {
      pickDirectory,
      chatAiSetWorkspace: async (path: string) => { setWorkspace.push(path); current = path; return { ok: true, data: { current: path, default: '/default' } }; },
      chatAiCreateConversation: async (service: string) => {
        await created.promise;
        // The main process makes the chat in whatever workspace is current.
        createdOn.push(current);
        const made = conv(`conv-${conversations.length + 1}`, service, current);
        conversations.push(made);
        return { ok: true, data: made };
      },
    });
    uiState.chatWorkspacePath = '/project-a';
    await api.refreshChatConversations();
    api.sendMessage('first');
    await tick(5);
    expect(uiState.chatWorkspaceLocked).toBe(true);
    await api.chooseWorkspace();
    expect(pickDirectory).not.toHaveBeenCalled();
    await api.openConversation('conv-b');
    expect(setWorkspace).toEqual([]);
    created.resolve();
    await waitFor(() => setWorkspace.length === 1);
    expect(createdOn).toEqual(['/project-a']);
    expect(setWorkspace).toEqual(['/project-b']);
    expect(uiState.chatWorkspaceLocked).toBe(false);
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toMatchObject({ content: 'first' });
  });

  it('a chat opened back in the held workspace replaces a switch deferred for another chat', async () => {
    const created = deferred<void>();
    const setWorkspace: string[] = [];
    const conversations = [conv('conv-a', 'model-a', '/project-a'), conv('conv-b', 'model-b', '/project-b')];
    const { api, uiState, sends } = setup(conversations, {
      chatAiSetWorkspace: async (path: string) => { setWorkspace.push(path); return { ok: true, data: { current: path, default: '/default' } }; },
      chatAiCreateConversation: async (service: string) => {
        await created.promise;
        const made = conv(`conv-${conversations.length + 1}`, service, '/project-a');
        conversations.push(made);
        return { ok: true, data: made };
      },
    });
    uiState.chatWorkspacePath = '/project-a';
    await api.refreshChatConversations();
    api.sendMessage('first');
    await tick(5);
    await api.openConversation('conv-b');
    await api.openConversation('conv-a');
    created.resolve();
    await waitFor(() => !uiState.chatWorkspaceLocked);
    await tick(5);
    expect(setWorkspace.filter((path) => path !== '/project-a')).toEqual([]);
    await waitFor(() => sends.length === 1);
  });

  it('a text prompt sent while a chat opens carries that chat\'s history, never the previous chat\'s', async () => {
    const said = (role: 'user' | 'assistant', content: string) => ({ role, content, createdAt: 1 });
    const convA = { ...conv('conv-a', 'model-a'), messages: [said('user', 'from a')] };
    const convB = { ...conv('conv-b', 'model-b'), messages: [said('user', 'from b')] };
    const bOpened = deferred<void>();
    const { api, uiState, sends } = setup([convA, convB], {
      chatAiGetConversation: async (id: string) => {
        if (id === 'conv-b') await bOpened.promise;
        const found = id === 'conv-a' ? convA : id === 'conv-b' ? convB : null;
        return found ? { ok: true, data: { ...found, messages: [...found.messages] } } : { ok: false, error: 'not found' };
      },
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    // Chat B is opening for the first time; A's messages are still on screen.
    const opening = api.openConversation('conv-b');
    api.sendMessage('hello b');
    await tick(10);
    bOpened.resolve();
    await opening;
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toMatchObject({ convId: 'conv-b', content: 'hello b' });
    const shown = JSON.stringify(uiState.chatMessages);
    expect(shown).toContain('from b');
    expect(shown).toContain('hello b');
    expect(shown).not.toContain('from a');
  });

  it('a second image prompt while the first one\'s history loads is refused, and the first keeps its chat', async () => {
    const convB = { ...conv('conv-b', 'model-b'), messages: [] as unknown[] };
    const historyRead = deferred<void>();
    let reads = 0;
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: false, stopReason: { kind: 'payment_required', message: 'Add funds' } });
    const { api, uiState } = setup([conv('conv-a', 'model-a'), convB], {
      chatGenerateImage,
      chatAiGetConversation: async (id: string) => {
        // The first opening reads freely; the image's own history read waits.
        if (id === 'conv-b' && ++reads > 1) await historyRead.promise;
        return id === 'conv-b' ? { ok: true, data: { ...convB, messages: [] } } : { ok: false, error: 'not found' };
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image', supportsImages: true }] as never;
    await api.refreshChatConversations();
    // Chat B is open, but still opening as far as the image history goes.
    const opening = api.openConversation('conv-b', { keepImageModel: true });
    uiState.chatImageModelId = 'image-model';
    api.generateImage('first');
    await tick(5);
    api.generateImage('second');
    await tick(5);
    expect(uiState.chatError).toBe('This conversation already has a request in progress.');
    historyRead.resolve();
    await opening;
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    await tick(20);
    expect(chatGenerateImage).toHaveBeenCalledTimes(1);
    expect(chatGenerateImage.mock.calls[0]![0]).toMatchObject({ conversationId: 'conv-b', prompt: 'first' });
  });

  it('clears the sending state of an aborted chat before the abort settles', async () => {
    const abort = deferred<void>();
    const { api, uiState } = setup(undefined, { chatAiAbort: () => abort.promise });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await waitFor(() => uiState.chatSending);
    const aborting = api.abortChat();
    expect(uiState.chatSending).toBe(false);
    expect(uiState.chatSendingConversationIds).toEqual([]);
    expect(uiState.chatAbortVisible).toBe(false);
    abort.resolve();
    await aborting;
  });

  it('a stopped send\'s late abort event leaves a follow-up in the same chat sending', async () => {
    const sendIds: Array<number | undefined> = [];
    const answers: Array<(value: { ok: boolean }) => void> = [];
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: (_convId: string, _content: string, _modelId: string, _attachments: unknown, _mode: unknown, options?: { sendId?: number }) => {
        sendIds.push(options?.sendId);
        return new Promise<{ ok: boolean }>((resolve) => { answers.push(resolve); });
      },
      chatAiAbort: async () => undefined,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('first');
    await waitFor(() => sendIds.length === 1);
    await api.abortChat();
    api.sendMessage('second');
    await waitFor(() => sendIds.length === 2);
    expect(uiState.chatSending).toBe(true);
    // The first send, stopped while still in preflight, reports its abort only now.
    emit('error', { conversationId: 'conv-a', error: 'Request aborted', stopReason: { kind: 'aborted', message: 'Request aborted' }, sendId: sendIds[0] });
    answers[0]!({ ok: false });
    await tick(20);
    expect(uiState.chatSending).toBe(true);
    expect(uiState.chatSendingConversationIds).toContain('conv-a');
    expect(uiState.chatAbortVisible).toBe(true);
    // The follow-up's own end still clears it.
    emit('error', { conversationId: 'conv-a', error: 'Request aborted', stopReason: { kind: 'aborted', message: 'Request aborted' }, sendId: sendIds[1] });
    answers[1]!({ ok: false });
    await waitFor(() => !uiState.chatSending);
  });

  it('a reply stopped mid-stream stays its own message when a follow-up starts before its abort arrives', async () => {
    const sendIds: Array<number | undefined> = [];
    const answers: Array<(value: { ok: boolean }) => void> = [];
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: (_convId: string, _content: string, _modelId: string, _attachments: unknown, _mode: unknown, options?: { sendId?: number }) => {
        sendIds.push(options?.sendId);
        return new Promise<{ ok: boolean }>((resolve) => { answers.push(resolve); });
      },
      chatAiAbort: async () => undefined,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('first');
    await waitFor(() => sendIds.length === 1);
    emit('start', { conversationId: 'conv-a', turn: 0 });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text' });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'First partial' });
    await api.abortChat();
    api.sendMessage('second');
    await waitFor(() => sendIds.length === 2);
    // The stopped run's abort arrives only now, after the follow-up took the chat.
    emit('error', { conversationId: 'conv-a', error: 'Request aborted', stopReason: { kind: 'aborted', message: 'Request aborted' }, sendId: sendIds[0] });
    answers[0]!({ ok: false });
    emit('start', { conversationId: 'conv-a', turn: 0 });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text' });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'Second answer' });
    emit('done', { conversationId: 'conv-a', sendId: sendIds[1] });
    answers[1]!({ ok: true });
    await waitFor(() => !uiState.chatSending);
    const texts = (uiState.chatMessages as Array<{ role: string; content: unknown }>).map((message) => `${message.role}:${JSON.stringify(message.content)}`);
    const first = texts.findIndex((text) => text.startsWith('assistant:') && text.includes('First partial'));
    const second = texts.findIndex((text) => text.startsWith('assistant:') && text.includes('Second answer'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(texts[second]).not.toContain('First partial');
    // The follow-up's prompt sits between the two replies.
    expect(texts.slice(first + 1, second).some((text) => text.startsWith('user:') && text.includes('second'))).toBe(true);
  });

  it('a stopped run\'s late output never reaches the follow-up\'s reply', async () => {
    const sendIds: Array<number | undefined> = [];
    const answers: Array<(value: { ok: boolean }) => void> = [];
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: (_convId: string, _content: string, _modelId: string, _attachments: unknown, _mode: unknown, options?: { sendId?: number }) => {
        sendIds.push(options?.sendId);
        return new Promise<{ ok: boolean }>((resolve) => { answers.push(resolve); });
      },
      chatAiAbort: async () => undefined,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('first');
    await waitFor(() => sendIds.length === 1);
    const first = sendIds[0];
    emit('start', { conversationId: 'conv-a', turn: 0, sendId: first });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text', sendId: first });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'First partial', sendId: first });
    await api.abortChat();
    api.sendMessage('second');
    await waitFor(() => sendIds.length === 2);
    const second = sendIds[1];
    emit('start', { conversationId: 'conv-a', turn: 0, sendId: second });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text', sendId: second });
    // The stopped run is still winding down: its late output arrives mid-follow-up.
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: ' LATE', sendId: first });
    emit('blockStart', { conversationId: 'conv-a', index: 1, blockType: 'text', sendId: first });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'Second answer', sendId: second });
    emit('error', { conversationId: 'conv-a', error: 'Request aborted', stopReason: { kind: 'aborted', message: 'Request aborted' }, sendId: first });
    answers[0]!({ ok: false });
    emit('done', { conversationId: 'conv-a', sendId: second });
    answers[1]!({ ok: true });
    await waitFor(() => !uiState.chatSending);
    const replies = (uiState.chatMessages as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === 'assistant')
      .map((message) => JSON.stringify(message.content));
    const followUp = replies.find((text) => text.includes('Second answer'));
    expect(followUp).toBeDefined();
    expect(followUp).not.toContain('LATE');
    expect(replies.some((text) => text.includes('LATE'))).toBe(false);
  });

  it('a stopped run\'s final message neither replaces its kept reply nor ends a follow-up', async () => {
    const sendIds: Array<number | undefined> = [];
    const answers: Array<(value: { ok: boolean }) => void> = [];
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: (_convId: string, _content: string, _modelId: string, _attachments: unknown, _mode: unknown, options?: { sendId?: number }) => {
        sendIds.push(options?.sendId);
        return new Promise<{ ok: boolean }>((resolve) => { answers.push(resolve); });
      },
      chatAiAbort: async () => undefined,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('first');
    await waitFor(() => sendIds.length === 1);
    const first = sendIds[0];
    emit('start', { conversationId: 'conv-a', turn: 0, sendId: first });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text', sendId: first });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'First partial', sendId: first });
    await api.abortChat();
    const finalOfFirst = { role: 'assistant', content: [{ type: 'text', text: 'First FULL reply' }], createdAt: 5, meta: { service: 'stale-model' } };
    // Its completion was already on the way when Stop was pressed.
    emit('aiDone', { conversationId: 'conv-a', message: finalOfFirst, sendId: first });
    emit('userPersisted', { conversationId: 'conv-a', message: { role: 'user', content: 'first', createdAt: 4 }, sendId: first });

    api.sendMessage('second');
    await waitFor(() => sendIds.length === 2);
    const second = sendIds[1];
    // The same late final message arrives while the follow-up waits for its stream.
    emit('aiDone', { conversationId: 'conv-a', message: finalOfFirst, sendId: first });
    expect(uiState.chatSending).toBe(true);
    emit('start', { conversationId: 'conv-a', turn: 0, sendId: second });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text', sendId: second });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'Second answer', sendId: second });
    emit('aiDone', { conversationId: 'conv-a', message: finalOfFirst, sendId: first });
    expect(uiState.chatSending).toBe(true);
    emit('done', { conversationId: 'conv-a', sendId: second });
    answers[0]!({ ok: false });
    answers[1]!({ ok: true });
    await waitFor(() => !uiState.chatSending);
    const replies = (uiState.chatMessages as Array<{ role: string; content: unknown; meta?: { service?: string } }>)
      .filter((message) => message.role === 'assistant');
    const texts = replies.map((message) => JSON.stringify(message.content));
    expect(texts.some((text) => text.includes('First partial'))).toBe(true);
    expect(texts.some((text) => text.includes('First FULL reply'))).toBe(false);
    const followUp = replies.find((message) => JSON.stringify(message.content).includes('Second answer'));
    expect(followUp?.meta?.service).not.toBe('stale-model');
  });

  it('sends a queued message to the chat it was written in, on that chat\'s model', async () => {
    // The send only answers once its stream has ended.
    const streamEnded = deferred<{ ok: boolean }>();
    const sends: Array<{ convId: string; content: string; modelId: string }> = [];
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: (convId: string, content: string, modelId: string) => {
        sends.push({ convId, content, modelId });
        return streamEnded.promise;
      },
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-b');
    api.sendMessageToConversation('conv-a', 'queued for a');
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toEqual({ convId: 'conv-a', content: 'queued for a', modelId: 'model-a' });
    expect(uiState.chatActiveConversation).toBe('conv-b');
    expect(uiState.chatSendingConversationIds).toEqual(['conv-a']);
    emit('done', { conversationId: 'conv-a' });
    streamEnded.resolve({ ok: true });
    await waitFor(() => uiState.chatSendingConversationIds.length === 0);
  });

  it('creates a draft on the model it was written with, and stays on a new chat started meanwhile', async () => {
    const created = conv('conv-new', 'model-a');
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')];
    const creation = deferred<{ ok: boolean; data: Conv }>();
    const { api, uiState, sends } = setup(conversations, {
      chatAiCreateConversation: async () => {
        const answer = await creation.promise;
        conversations.push(created);
        return answer;
      },
    });
    await api.refreshChatConversations();
    api.sendMessage('first message');
    await tick();
    api.startNewChat();
    uiState.chatSelectedModelId = 'model-b';
    creation.resolve({ ok: true, data: created });
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toEqual({ convId: 'conv-new', content: 'first message', modelId: 'model-a' });
    expect(uiState.chatActiveConversation).toBeNull();
  });

  it('sends both first messages when a second new chat is sent while the first is still being made', async () => {
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')];
    const creations: Array<{ resolve: () => void }> = [];
    const { api, uiState, sends } = setup(conversations, {
      chatAiCreateConversation: (service: string) => new Promise((resolve) => {
        creations.push({
          resolve: () => {
            const created = conv(`conv-new-${creations.length}-${conversations.length}`, service);
            conversations.push(created);
            resolve({ ok: true, data: created });
          },
        });
      }),
    });
    await api.refreshChatConversations();
    api.sendMessage('draft A');
    await waitFor(() => creations.length === 1);
    api.startNewChat();
    api.sendMessage('draft B');
    await waitFor(() => creations.length === 2);
    creations[0]!.resolve();
    creations[1]!.resolve();
    await waitFor(() => sends.length === 2);
    expect(sends.map((send) => send.content).sort()).toEqual(['draft A', 'draft B']);
    expect(new Set(sends.map((send) => send.convId)).size).toBe(2);
    // The chat on screen is the second one's.
    expect(uiState.chatActiveConversation).toBe(sends.find((send) => send.content === 'draft B')?.convId);
  });

  it('Stop cancels only the draft on screen, not one a new chat left running', async () => {
    const conversations = [conv('conv-a', 'model-a')];
    const creations: Array<{ resolve: () => void }> = [];
    const { api, sends } = setup(conversations, {
      chatAiCreateConversation: (service: string) => new Promise((resolve) => {
        const index = creations.length;
        creations.push({
          resolve: () => {
            const created = conv(`conv-new-${index}`, service);
            conversations.push(created);
            resolve({ ok: true, data: created });
          },
        });
      }),
    });
    await api.refreshChatConversations();
    api.sendMessage('draft A');
    await waitFor(() => creations.length === 1);
    api.startNewChat();
    api.sendMessage('draft B');
    await waitFor(() => creations.length === 2);
    await api.abortChat();
    creations[0]!.resolve();
    creations[1]!.resolve();
    await waitFor(() => sends.length === 1);
    await tick(20);
    expect(sends.map((send) => send.content)).toEqual(['draft A']);
  });

  it('holds an unfunded first message until a free model is listed, then sends on it', async () => {
    let listed = [model('model-a')];
    const { api, uiState, sends } = setup(undefined, {
      chatListModels: async () => ({ ok: true, data: listed }),
    });
    uiState.creditsTotalOwnedUsdc = '0';
    await api.refreshChatConversations();
    api.sendMessage('hello');
    await waitFor(() => uiState.chatThinkingPhase === 'Finding a free model');
    expect(sends).toEqual([]);
    listed = [model('model-a'), { ...model('model-free'), free: true }];
    // The list is read again every 2 seconds.
    await waitFor(() => sends.length === 1, 3_000);
    expect(sends[0]).toMatchObject({ content: 'hello', modelId: 'model-free' });
  });

  it('a first message waiting for a free model keeps its own model when another chat picks a paid one', async () => {
    // A real saved last model, so the other chat's pick is remembered the way the app does.
    const saved = new Map<string, string>();
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      ...(previousWindow as object | undefined),
      localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } },
    };
    try {
      let listed = [model('model-a'), model('model-b')];
      const { api, uiState, sends } = setup(undefined, {
        chatListModels: async () => ({ ok: true, data: listed }),
      });
      uiState.creditsTotalOwnedUsdc = '0';
      await api.refreshChatConversations();
      api.sendMessage('draft A');
      await waitFor(() => uiState.chatThinkingPhase === 'Finding a free model');
      api.startNewChat();
      api.selectChatModel('model-b');
      await tick(300);
      // Still waiting: the other chat's pick doesn't end draft A's wait.
      expect(sends).toEqual([]);
      listed = [model('model-a'), model('model-b'), { ...model('model-free'), free: true }];
      await waitFor(() => sends.length === 1, 3_000);
      expect(sends[0]).toMatchObject({ content: 'draft A', modelId: 'model-free' });
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });

  it('a stopped wait for a free model sends nothing', async () => {
    const { api, uiState, sends } = setup(undefined, {
      chatListModels: async () => ({ ok: true, data: [model('model-a')] }),
      chatAiAbort: async () => undefined,
    });
    uiState.creditsTotalOwnedUsdc = '0';
    await api.refreshChatConversations();
    api.sendMessage('hello');
    await waitFor(() => uiState.chatThinkingPhase === 'Finding a free model');
    await api.abortChat();
    await tick(2_100);
    expect(sends).toEqual([]);
    expect(uiState.chatSending).toBe(false);
  });

  it('waits for a model change to be saved, then sends on the new model', async () => {
    const saved = deferred<{ ok: boolean }>();
    const { api, sends } = setup(undefined, { chatAiSetModel: () => saved.promise });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.selectChatModel('model-b');
    api.sendMessage('on the new model');
    await tick(20);
    expect(sends).toEqual([]);
    saved.resolve({ ok: true });
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toEqual({ convId: 'conv-a', content: 'on the new model', modelId: 'model-b' });
  });

  it('an old conversation list landing while a model change is saved does not send on the old model', async () => {
    const saved = deferred<{ ok: boolean }>();
    const staleList = deferred<{ ok: boolean; data: Conv[] }>();
    let listCalls = 0;
    const { api, uiState, sends } = setup(undefined, {
      chatAiSetModel: () => saved.promise,
      chatAiListConversations: async () => (++listCalls === 1
        ? { ok: true, data: [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')] }
        : staleList.promise),
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    const refreshing = api.refreshChatConversations();
    api.selectChatModel('model-b');
    api.sendMessage('on the new model');
    staleList.resolve({ ok: true, data: [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')] });
    await refreshing;
    expect((uiState.chatConversations as Conv[]).find((c) => c.id === 'conv-a')?.service).toBe('model-b');
    saved.resolve({ ok: true });
    await waitFor(() => sends.length === 1);
    expect(sends[0]!.modelId).toBe('model-b');
  });

  it('keeps what already streamed when the stream fails, shows the error and does not resend', async () => {
    const { api, uiState, sends, emit } = setup();
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    emit('start', { conversationId: 'conv-a', turn: 0 });
    emit('blockStart', { conversationId: 'conv-a', index: 0, blockType: 'text' });
    emit('delta', { conversationId: 'conv-a', index: 0, blockType: 'text', text: 'Partial answer' });
    emit('error', { conversationId: 'conv-a', error: 'Connection lost', stopReason: { kind: 'network_error', message: 'Connection lost' } });
    await tick();
    expect(uiState.chatError).toBe('Connection lost');
    expect(JSON.stringify(uiState.chatMessages[uiState.chatMessages.length - 1])).toContain('Partial answer');
    expect(uiState.chatSending).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it('shows no error for an aborted stream', async () => {
    const { api, uiState, sends, emit } = setup();
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    emit('error', { conversationId: 'conv-a', error: 'Request aborted', stopReason: { kind: 'aborted', message: 'Request aborted' } });
    expect(uiState.chatError).toBeNull();
    expect(uiState.chatSending).toBe(false);
  });

  it('clears a stream error when switching chats, and it does not come back', async () => {
    const { api, uiState, emit } = setup();
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    emit('error', { conversationId: 'conv-a', error: 'Upstream refused', stopReason: { kind: 'http_error', message: 'Upstream refused', statusCode: 500 } });
    expect(uiState.chatError).toBe('Upstream refused');
    await api.openConversation('conv-b');
    expect(uiState.chatError).toBeNull();
    await api.openConversation('conv-a');
    expect(uiState.chatError).toBeNull();
  });

  it('restores each chat\'s workspace, and leaves it alone when it already matches', async () => {
    const setWorkspace: string[] = [];
    const { api, uiState } = setup([conv('conv-a', 'model-a', '/project-a'), conv('conv-b', 'model-b', '/project-b')], {
      chatAiSetWorkspace: async (path: string) => { setWorkspace.push(path); return { ok: true, data: { current: path, default: '/default' } }; },
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    await waitFor(() => uiState.chatWorkspacePath === '/project-a');
    await api.openConversation('conv-b');
    await waitFor(() => uiState.chatWorkspacePath === '/project-b');
    setWorkspace.length = 0;
    await api.openConversation('conv-b');
    await tick(20);
    expect(setWorkspace).toEqual([]);
  });

  it('ends on the latest chat\'s workspace after rapid switches', async () => {
    const answers: Array<() => void> = [];
    const { api, uiState } = setup([conv('conv-a', 'model-a', '/project-a'), conv('conv-b', 'model-b', '/project-b')], {
      chatAiSetWorkspace: (path: string) => new Promise((resolve) => {
        answers.push(() => resolve({ ok: true, data: { current: path, default: '/default' } }));
      }),
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    await waitFor(() => answers.length === 1);
    await api.openConversation('conv-b');
    await waitFor(() => answers.length === 2);
    answers[1]!();
    await tick();
    answers[0]!();
    await tick(20);
    expect(uiState.chatWorkspacePath).toBe('/project-b');
  });

  it('edits the last generated image when only some sellers of the image model can', async () => {
    const generated = { role: 'assistant', content: [{ type: 'file', generated: true, attachmentId: 'img-1' }], createdAt: 2 };
    const conversations = [{ ...conv('conv-a', 'model-a'), messages: [{ role: 'user', content: 'a cat', createdAt: 1 }, generated] }];
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: true, user: { role: 'user', content: 'make it blue' }, assistant: { role: 'assistant', content: 'done' } });
    const { api, uiState } = setup(conversations, { chatGenerateImage });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image', imageInputSellerIds: ['a'.repeat(40)] }] as never;
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    uiState.chatImageModelId = 'image-model';
    api.generateImage('make it blue');
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    expect(JSON.stringify(chatGenerateImage.mock.calls[0])).toContain('img-1');
  });

  it('a second image submit while the first image chat is being made sends one image, in one chat', async () => {
    const conversations = [conv('conv-a', 'model-a')];
    const creation = deferred<void>();
    const created: string[] = [];
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } });
    const { api, uiState } = setup(conversations, {
      chatGenerateImage,
      chatAiCreateConversation: async (service: string) => {
        await creation.promise;
        const next = conv(`conv-img-${created.length + 1}`, service);
        created.push(next.id);
        conversations.push(next);
        return { ok: true, data: next };
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    uiState.chatImageModelId = 'image-model';
    await api.refreshChatConversations();
    api.generateImage('a cat');
    api.generateImage('a cat');
    creation.resolve();
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    await tick(20);
    expect(created).toHaveLength(1);
    expect(chatGenerateImage).toHaveBeenCalledTimes(1);
    expect(uiState.chatActiveConversation).toBe(created[0]);
  });

  it('an image chat finishing after the user started another chat does not pull them back', async () => {
    const conversations = [conv('conv-a', 'model-a')];
    const creation = deferred<void>();
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } });
    const { api, uiState } = setup(conversations, {
      chatGenerateImage,
      chatAiCreateConversation: async (service: string) => {
        await creation.promise;
        const next = conv('conv-img', service);
        conversations.push(next);
        return { ok: true, data: next };
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    uiState.chatImageModelId = 'image-model';
    await api.refreshChatConversations();
    api.generateImage('a cat');
    await tick();
    api.startNewChat();
    creation.resolve();
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    expect(uiState.chatActiveConversation).toBeNull();
  });

  it('an image chat finishing after the user opened another chat does not pull them back', async () => {
    const conversations = [conv('conv-a', 'model-a')];
    const creation = deferred<void>();
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } });
    const { api, uiState } = setup(conversations, {
      chatGenerateImage,
      chatAiCreateConversation: async (service: string) => {
        await creation.promise;
        const next = conv('conv-img', service);
        conversations.push(next);
        return { ok: true, data: next };
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    uiState.chatImageModelId = 'image-model';
    await api.refreshChatConversations();
    api.generateImage('a cat');
    await tick();
    await api.openConversation('conv-a');
    creation.resolve();
    await waitFor(() => chatGenerateImage.mock.calls.length === 1);
    await tick(20);
    expect(uiState.chatActiveConversation).toBe('conv-a');
  });

  it('a first message keeps its new chat busy while the chat opens, so a second submit cannot displace it', async () => {
    const opening = deferred<void>();
    const conversations = [conv('conv-a', 'model-a')];
    const base = (id: string) => {
      const found = conversations.find((candidate) => candidate.id === id);
      return found ? { ok: true, data: { ...found, messages: [...found.messages] } } : { ok: false, error: 'not found' };
    };
    const { api, uiState, sends } = setup(conversations, {
      chatAiGetConversation: async (id: string) => {
        if (id !== 'conv-a') await opening.promise;
        return base(id);
      },
    });
    await api.refreshChatConversations();
    api.sendMessage('first');
    await waitFor(() => uiState.chatActiveConversation !== null && uiState.chatActiveConversation !== 'conv-a');
    // The chat is still loading: the composer stays busy and a second submit is refused.
    expect(uiState.chatSending).toBe(true);
    api.sendMessage('second');
    opening.resolve();
    await waitFor(() => sends.length >= 1);
    await tick(20);
    expect(sends.map((send) => send.content)).toEqual(['first']);
  });

  it('a first image keeps its new chat busy while the chat opens, so a second submit cannot displace it', async () => {
    const opening = deferred<void>();
    const conversations = [conv('conv-a', 'model-a')];
    const base = (id: string) => {
      const found = conversations.find((candidate) => candidate.id === id);
      return found ? { ok: true, data: { ...found, messages: [...found.messages] } } : { ok: false, error: 'not found' };
    };
    const chatGenerateImage = vi.fn().mockResolvedValue({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } });
    const { api, uiState } = setup(conversations, {
      chatGenerateImage,
      chatAiGetConversation: async (id: string) => {
        if (id !== 'conv-a') await opening.promise;
        return base(id);
      },
    });
    uiState.chatModels = [...uiState.chatModels, { ...model('image-model'), type: 'image' }] as never;
    uiState.chatImageModelId = 'image-model';
    await api.refreshChatConversations();
    api.generateImage('a cat');
    await waitFor(() => uiState.chatActiveConversation !== null && uiState.chatActiveConversation !== 'conv-a');
    expect(uiState.chatSending).toBe(true);
    api.generateImage('a dog');
    opening.resolve();
    await waitFor(() => chatGenerateImage.mock.calls.length >= 1);
    await tick(20);
    expect(chatGenerateImage.mock.calls.map(([request]) => request.prompt)).toEqual(['a cat']);
  });

  it('a background chat finishing keeps Sending and Stop on a new chat\'s first message still being prepared', async () => {
    const streamEnded = deferred<{ ok: boolean }>();
    const creation = deferred<void>();
    const conversations = [conv('conv-a', 'model-a')];
    const { api, uiState, emit } = setup(conversations, {
      chatAiSendStream: () => streamEnded.promise,
      chatAiCreateConversation: async (service: string) => {
        await creation.promise;
        const next = conv('conv-new', service);
        conversations.push(next);
        return { ok: true, data: next };
      },
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('in a');
    await waitFor(() => uiState.chatSendingConversationIds.includes('conv-a'));
    api.startNewChat();
    api.sendMessage('draft B');
    await waitFor(() => uiState.chatSending);
    emit('done', { conversationId: 'conv-a' });
    streamEnded.resolve({ ok: true });
    await waitFor(() => uiState.chatSendingConversationIds.length === 0);
    expect(uiState.chatActiveConversation).toBeNull();
    expect(uiState.chatSending).toBe(true);
    expect(uiState.chatAbortVisible).toBe(true);
    expect(uiState.chatSendingConversationId).toBeNull();
    creation.resolve();
  });

  it('ignores a slow answer for a chat the user has already left', async () => {
    const answers: Record<string, (value: unknown) => void> = {};
    const conversations = [{ ...conv('conv-a', 'model-a', '/project-a'), messages: [{ role: 'user', content: 'from a', createdAt: 1 }] }, { ...conv('conv-b', 'model-b'), messages: [{ role: 'user', content: 'from b', createdAt: 1 }] }];
    const setWorkspace: string[] = [];
    const { api, uiState } = setup(conversations, {
      chatAiGetConversation: (id: string) => new Promise((resolve) => { answers[id] = resolve; }),
      chatAiSetWorkspace: async (path: string) => { setWorkspace.push(path); return { ok: true, data: { current: path, default: '/default' } }; },
    });
    await api.refreshChatConversations();
    const first = api.openConversation('conv-a');
    const second = api.openConversation('conv-b');
    answers['conv-b']!({ ok: true, data: conversations[1] });
    await second;
    answers['conv-a']!({ ok: true, data: conversations[0] });
    await first;
    await tick();
    expect(uiState.chatActiveConversation).toBe('conv-b');
    expect(uiState.chatSelectedModelId).toBe('model-b');
    expect(JSON.stringify(uiState.chatMessages)).toContain('from b');
    expect(setWorkspace).toEqual([]);
  });

  it('shows no error for a chat the user has already left', async () => {
    const answers: Record<string, (value: unknown) => void> = {};
    const { api, uiState } = setup(undefined, { chatAiGetConversation: (id: string) => new Promise((resolve) => { answers[id] = resolve; }) });
    await api.refreshChatConversations();
    const first = api.openConversation('conv-a');
    const second = api.openConversation('conv-b');
    answers['conv-a']!({ ok: false, error: 'not found' });
    await first;
    expect(uiState.chatError).toBeNull();
    expect(uiState.chatOpeningConversationId).toBe('conv-b');
    answers['conv-b']!({ ok: true, data: conv('conv-b', 'model-b') });
    await second;
  });

  it('reads an empty model list again, past the cache, until peers have been found', async () => {
    vi.useFakeTimers();
    try {
      const chatListModels = vi.fn()
        .mockResolvedValueOnce({ ok: true, data: [] })
        .mockResolvedValue({ ok: true, data: [model('model-a')] });
      const { api, uiState } = setup(undefined, { chatListModels });
      uiState.chatModels = [] as never;
      uiState.chatSelectedModelId = '';
      await api.refreshChatModels();
      expect(uiState.chatModels).toEqual([]);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(chatListModels).toHaveBeenLastCalledWith({ force: true });
      expect(uiState.chatSelectedModelId).toBe('model-a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopening a chat while its new model is saving keeps the new model for the next send', async () => {
    const saved = deferred<{ ok: boolean }>();
    const { api, uiState, sends } = setup(undefined, { chatAiSetModel: () => saved.promise });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.selectChatModel('model-b');
    await api.openConversation('conv-b');
    const reopening = api.openConversation('conv-a');
    saved.resolve({ ok: true });
    await reopening;
    expect(uiState.chatSelectedModelId).toBe('model-b');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    expect(sends[0]!.modelId).toBe('model-b');
  });

  it('a chat list read before a model change, answering after it saved, keeps the new model', async () => {
    const listed = deferred<{ ok: boolean; data: Conv[] }>();
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')];
    let holdList = false;
    const { api, uiState, sends } = setup(conversations, {
      chatAiListConversations: () => (holdList ? listed.promise : Promise.resolve({ ok: true, data: [...conversations] })),
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    holdList = true;
    const refreshing = api.refreshChatConversations();
    api.selectChatModel('model-b');
    await tick();
    listed.resolve({ ok: true, data: [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')] });
    await refreshing;
    expect(uiState.chatSelectedModelId).toBe('model-b');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    expect(sends[0]!.modelId).toBe('model-b');
  });

  it('a chat list read started while a model change was saving keeps the new model', async () => {
    const listed = deferred<{ ok: boolean; data: Conv[] }>();
    const saved = deferred<{ ok: boolean }>();
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')];
    let holdList = false;
    const { api, uiState, sends } = setup(conversations, {
      chatAiListConversations: () => (holdList ? listed.promise : Promise.resolve({ ok: true, data: [...conversations] })),
      chatAiSetModel: () => saved.promise,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.selectChatModel('model-b');
    holdList = true;
    const refreshing = api.refreshChatConversations();
    saved.resolve({ ok: true });
    await tick();
    listed.resolve({ ok: true, data: [conv('conv-a', 'model-a'), conv('conv-b', 'model-b')] });
    await refreshing;
    expect(uiState.chatSelectedModelId).toBe('model-b');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    expect(sends[0]!.modelId).toBe('model-b');
  });

  it('an earlier request finishing late does not end a follow-up that is still preparing', async () => {
    const firstSent = deferred<{ ok: boolean }>();
    const attachments = deferred<{ ok: boolean; data: unknown[] }>();
    let calls = 0;
    const { api, uiState, emit } = setup(undefined, {
      chatAiSendStream: () => (++calls === 1 ? firstSent.promise : Promise.resolve({ ok: true })),
      chatPrepareAttachments: () => attachments.promise,
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('first');
    await waitFor(() => calls === 1);
    emit('done', { conversationId: 'conv-a' });
    expect(uiState.chatSendingConversationIds).toEqual([]);
    // The follow-up waits on its attachment while the first IPC call returns.
    api.sendMessage('second', [{ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' }] as never);
    expect(uiState.chatSendingConversationIds).toEqual(['conv-a']);
    firstSent.resolve({ ok: true });
    await tick();
    expect(uiState.chatSendingConversationIds).toEqual(['conv-a']);
    attachments.resolve({ ok: true, data: [] });
    await waitFor(() => calls === 2);
  });

  it('a model chosen while another chat is still opening goes to that chat, not the one before', async () => {
    const opening = deferred<{ ok: boolean; data: Conv }>();
    const saved: Array<[string | null, string]> = [];
    const conversations = [conv('conv-a', 'model-a'), conv('conv-b', 'model-a')];
    let holdB = false;
    const { api, uiState, sends } = setup(conversations, {
      chatAiGetConversation: async (id: string) => (id === 'conv-b' && holdB ? opening.promise : { ok: true, data: { ...conversations.find((c) => c.id === id)! } }),
      chatAiSetModel: async (id: string | null, model: string) => { saved.push([id, model]); return { ok: true }; },
    });
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    holdB = true;
    const openingB = api.openConversation('conv-b');
    api.selectChatModel('model-b');
    opening.resolve({ ok: true, data: { ...conversations[1]! } });
    await openingB;
    expect(saved).toEqual([['conv-b', 'model-b']]);
    expect(uiState.chatSelectedModelId).toBe('model-b');
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toMatchObject({ convId: 'conv-b', modelId: 'model-b' });
  });
});
