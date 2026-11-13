import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { privacyResource, requestPrivacyMode } from '../app/vpr-resources';
import { initChatModule } from './controller';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const model = (id: string, type = 'text', tee = true) => ({ id, label: id, type, protocol: type === 'text' ? 'openai-chat-completions' : null, supportsImages: false, sellers: 1, free: false, minImageUsd: null, freeSellerId: null, freeForStakers: false, tee, toolUse: true, reasoning: false, inputUsdPerMillion: null, outputUsdPerMillion: null });
const conv = (id: string, service: string) => ({ id, title: id, service, messages: [], createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0 } });
const lowFunds = { ok: false, error: 'Too low.', stopReason: { kind: 'payment_required', message: 'Too low.' } };
const privacy = (mode: 'anonymous' | 'private') => ({ mode, editable: true, requiredAbove: false });

function setup(options: { lastModel?: string; listModels?: () => Promise<unknown>; stored?: Record<string, string>; send?: () => Promise<unknown>; image?: () => Promise<unknown>; models?: unknown[]; conversations?: Array<ReturnType<typeof conv>> } = {}) {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => options.stored?.[key] ?? (key === 'antseed:chat:lastModel' ? options.lastModel ?? null : null),
      setItem: (key: string, value: string) => { if (options.stored) options.stored[key] = value; },
    },
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  const uiState = createInitialUiState();
  uiState.chatModels = (options.models ?? [model('model-a'), model('model-b'), model('image-model', 'image')]) as never;
  uiState.chatSelectedModelId = 'model-a';
  uiState.creditsBalanceKnown = true;
  uiState.creditsTotalOwnedUsdc = '5';
  const conversations = options.conversations ?? [conv('conv-1', 'model-b')];
  const chatAiSendStream = vi.fn(options.send ?? (async () => ({ ok: true })));
  const chatGenerateImage = vi.fn(options.image ?? (async () => ({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } })));
  const chatAiCreateConversation = vi.fn(async (service: string) => {
    const created = conv(`conv-${conversations.length + 1}`, service);
    conversations.push(created);
    return { ok: true, data: created };
  });
  const bridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id: string) => ({ ok: true, data: { ...conversations.find((candidate) => candidate.id === id)! } }),
    chatAiCreateConversation,
    chatAiSetModel: vi.fn(async () => ({ ok: true })),
    chatAiAbort: async () => undefined,
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream,
    chatGenerateImage,
    ...(options.listModels ? { chatListModels: options.listModels } : {}),
  };
  (globalThis as unknown as { __lastBridge?: unknown }).__lastBridge = bridge;
  const api = initChatModule({ bridge: bridge as never, uiState, appendSystemLog: () => undefined });
  return { api, uiState, chatAiSendStream, chatGenerateImage, chatAiCreateConversation, chatAiSetModel: bridge.chatAiSetModel };
}

describe('privacy at the moment a request leaves', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('holds a send made while switching to Private, then sends it requiring Private', async () => {
    const { api, uiState, chatAiSendStream } = setup();
    await api.openConversation('conv-1');
    privacyResource.setData(privacy('anonymous'));
    const write = deferred<unknown>();
    (window as unknown as { antseedDesktop: unknown }).antseedDesktop = { gatewaySetPrivacy: () => write.promise };
    void requestPrivacyMode('private');

    api.sendMessage('hello');
    await tick();
    expect(chatAiSendStream).not.toHaveBeenCalled();
    expect(uiState.chatThinkingPhase).toBe('Switching to Private');

    write.resolve({ ok: true, privacy: privacy('private') });
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
    expect(chatAiSendStream.mock.calls[0]?.[5]).toEqual({ requirePrivate: true, allowPrivateHistory: false, sendId: expect.any(Number) });
    expect(uiState.chatPrivateConversationIds).toContain('conv-1');
  });

  it('a held send that is stopped never goes out', async () => {
    const { api, chatAiSendStream } = setup();
    await api.openConversation('conv-1');
    privacyResource.setData(privacy('anonymous'));
    const write = deferred<unknown>();
    (window as unknown as { antseedDesktop: unknown }).antseedDesktop = { gatewaySetPrivacy: () => write.promise, chatAiAbort: async () => undefined };
    void requestPrivacyMode('private');
    api.sendMessage('hello');
    await tick();
    await api.abortChat();
    write.resolve({ ok: true, privacy: privacy('private') });
    await tick();
    expect(chatAiSendStream).not.toHaveBeenCalled();
  });

  it('a held send that is stopped stays stopped when a new one is sent before the switch lands', async () => {
    const { api, chatAiSendStream } = setup();
    await api.openConversation('conv-1');
    privacyResource.setData(privacy('anonymous'));
    const write = deferred<unknown>();
    (window as unknown as { antseedDesktop: unknown }).antseedDesktop = { gatewaySetPrivacy: () => write.promise };
    void requestPrivacyMode('private');
    api.sendMessage('first');
    await tick();
    await api.abortChat();
    api.sendMessage('second');
    await tick();
    write.resolve({ ok: true, privacy: privacy('private') });
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
    expect(chatAiSendStream.mock.calls[0]?.[1]).toBe('second');
  });

  it('remembers every chat sent in Private, not only the latest few hundred', async () => {
    const ids = ['conv-1', ...Array.from({ length: 600 }, (_, index) => `other-${index}`)];
    const stored: Record<string, string> = { 'antseed:privateChats': JSON.stringify(ids) };
    const { api, uiState, chatAiSendStream } = setup({ stored, conversations: [conv('conv-1', 'model-b'), conv('conv-2', 'model-b')] });
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-2');
    api.sendMessage('hello');
    await tick();
    expect(JSON.parse(stored['antseed:privateChats']!)).toContain('conv-1');

    privacyResource.setData(privacy('anonymous'));
    await api.openConversation('conv-1');
    api.sendMessage('hello');
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
    expect(uiState.chatError).toMatch(/sent in Private/);
  });

  it('a message sent while switching to Private, when the switch fails, is not sent Anonymous', async () => {
    const { api, uiState, chatAiSendStream } = setup();
    await api.openConversation('conv-1');
    privacyResource.setData(privacy('anonymous'));
    const write = deferred<unknown>();
    (window as unknown as { antseedDesktop: unknown }).antseedDesktop = {
      gatewaySetPrivacy: () => write.promise,
      gatewayGetPrivacy: async () => ({ ok: true, privacy: privacy('anonymous') }),
    };
    void requestPrivacyMode('private');
    api.sendMessage('hello');
    await tick();
    write.resolve({ ok: false, error: 'policy write failed' });
    await tick(20);
    expect(chatAiSendStream).not.toHaveBeenCalled();
    expect(uiState.chatError).toMatch(/Private couldn.t be turned on/);
  });

  it('stopping a new chat while its chat is being made sends nothing, and leaves other chats running', async () => {
    const created = deferred<unknown>();
    const abort = vi.fn(async () => undefined);
    const { api, chatAiSendStream } = setup({ conversations: [] });
    // Swap in a slow create and an abort spy on the same bridge.
    const bridge = (globalThis as unknown as { __lastBridge?: Record<string, unknown> }).__lastBridge;
    if (bridge) { bridge.chatAiCreateConversation = () => created.promise; bridge.chatAiAbort = abort; }
    privacyResource.setData(privacy('anonymous'));
    api.sendMessage('hello');
    await tick();
    await api.abortChat();
    expect(abort).not.toHaveBeenCalled();
    created.resolve({ ok: true, data: conv('conv-new', 'model-a') });
    await tick(20);
    expect(chatAiSendStream).not.toHaveBeenCalled();
  });

  it('Try again does not send a chat sent in Private once Private was turned off elsewhere', async () => {
    const { api, uiState, chatAiSendStream } = setup({ send: async () => lowFunds });
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-1');
    api.sendMessage('hello');
    await tick();
    expect(uiState.chatFundsNotice).not.toBeNull();

    // The console turned Private off; the screen learns it from the next read.
    privacyResource.setData(privacy('anonymous'));
    api.retryAfterPayment();
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
    expect(uiState.chatError).toMatch(/sent in Private/);
    // Still one to try again: back in Private, Try again sends the same prompt.
    expect(uiState.chatFundsNotice).not.toBeNull();
    privacyResource.setData(privacy('private'));
    api.retryAfterPayment();
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(2);
    expect(chatAiSendStream.mock.calls[1]?.[1]).toBe('hello');
    expect(chatAiSendStream.mock.calls[1]?.[5]).toMatchObject({ requirePrivate: true });
  });

  it('Try again on an image of a chat sent in Private stays put once Private is off', async () => {
    const { api, uiState, chatGenerateImage } = setup({ image: async () => lowFunds });
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-1');
    uiState.chatImageModelId = 'image-model';
    api.generateImage('a cat');
    await tick();
    expect(chatGenerateImage.mock.calls[0]?.[0]).toMatchObject({ requirePrivate: true });

    privacyResource.setData(privacy('anonymous'));
    api.retryAfterPayment();
    await tick();
    expect(chatGenerateImage).toHaveBeenCalledTimes(1);
    expect(uiState.chatError).toMatch(/sent in Private/);
    // Still one to try again: back in Private, Try again makes the same image.
    expect(uiState.chatFundsNotice).not.toBeNull();
    privacyResource.setData(privacy('private'));
    api.retryAfterPayment();
    await tick();
    expect(chatGenerateImage).toHaveBeenCalledTimes(2);
    expect(chatGenerateImage.mock.calls[1]?.[0]).toMatchObject({ prompt: 'a cat', requirePrivate: true });
  });

  it('a chat the user chose to keep goes on in Anonymous without requiring Private', async () => {
    const { api, chatAiSendStream } = setup();
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-1');
    api.sendMessage('hello');
    await tick();
    privacyResource.setData(privacy('anonymous'));
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true });
    api.sendMessage('again');
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(2);
    expect(chatAiSendStream.mock.calls[1]?.[5]).toEqual({ requirePrivate: false, allowPrivateHistory: true, sendId: expect.any(Number) });
  });

  it('keeping a chat covers its history so far: a later Private turn needs asking again', async () => {
    const { api, uiState, chatAiSendStream } = setup();
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-1');
    api.sendMessage('hello');
    await tick();
    privacyResource.setData(privacy('anonymous'));
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true, conversationId: 'conv-1' });
    // Back in Private for one more turn, then Anonymous again with no new consent.
    privacyResource.setData(privacy('private'));
    api.sendMessage('secret');
    await tick();
    privacyResource.setData(privacy('anonymous'));
    api.sendMessage('again');
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(2);
    expect(uiState.chatError).toMatch(/sent in Private/);
  });

  it('consent is for the chat the user was warned about, not another chat opened since', async () => {
    const { api, chatAiSendStream } = setup({ conversations: [conv('conv-1', 'model-a'), conv('conv-2', 'model-a')] });
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-1');
    api.sendMessage('hello');
    await tick();
    await api.openConversation('conv-2');
    privacyResource.setData(privacy('anonymous'));
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true, conversationId: 'conv-1' });
    await api.openConversation('conv-1');
    api.sendMessage('again');
    await tick();
    expect(chatAiSendStream).toHaveBeenCalledTimes(1);
  });
});

describe('a new chat from Home', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('keeps the model Home showed, not the last one used', async () => {
    const { api, chatAiCreateConversation } = setup({ lastModel: 'model-a' });
    privacyResource.setData(privacy('anonymous'));
    await api.openConversation('conv-1');
    api.startNewChatOnModel('model-b');
    api.sendMessage('hello');
    await tick();
    expect(chatAiCreateConversation).toHaveBeenCalledWith('model-b');
  });
});

describe('a model Private chose', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('moves only once the switch lands, and goes back in each chat it moved, open or not', async () => {
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [conv('conv-a', 'model-x'), conv('conv-b', 'model-y')],
    });
    privacyResource.setData(privacy('anonymous'));
    await api.openConversation('conv-a');
    // The toggle alone changes nothing: a switch that fails must leave the chat as it was.
    api.privacyModeChosen('private');
    expect(uiState.chatSelectedModelId).toBe('model-x');
    expect(chatAiSetModel).not.toHaveBeenCalled();

    privacyResource.setData(privacy('private'));
    uiState.chatModels = [model('model-y')] as never;
    await api.privacySwitchLanded('private');
    expect(uiState.chatSelectedModelId).toBe('model-y');
    expect(chatAiSetModel).toHaveBeenLastCalledWith('conv-a', 'model-y');

    // Private ends while another chat is open: that one keeps its model, the moved one goes back.
    await api.openConversation('conv-b');
    chatAiSetModel.mockClear();
    uiState.chatModels = [model('model-x', 'text', false), model('model-y')] as never;
    privacyResource.setData(privacy('anonymous'));
    await api.privacySwitchLanded('anonymous');
    expect(uiState.chatSelectedModelId).toBe('model-y');
    expect(chatAiSetModel.mock.calls).toEqual([['conv-a', 'model-x']]);
  });

  it('goes back in a chat started on it while Private was on', async () => {
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [],
    });
    privacyResource.setData(privacy('private'));
    uiState.chatSelectedModelId = 'model-x';
    uiState.chatModels = [model('model-y')] as never;
    await api.privacySwitchLanded('private');
    expect(uiState.chatSelectedModelId).toBe('model-y');
    api.sendMessage('hello');
    await tick(20);
    expect(uiState.chatActiveConversation).toBe('conv-1');
    uiState.chatModels = [model('model-x', 'text', false), model('model-y')] as never;
    privacyResource.setData(privacy('anonymous'));
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true });
    await api.privacySwitchLanded('anonymous');
    expect(uiState.chatSelectedModelId).toBe('model-x');
    expect(chatAiSetModel).toHaveBeenCalledWith('conv-1', 'model-x');
  });

  it('goes back when Private\'s shorter list replaced it on its own', async () => {
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [],
    });
    privacyResource.setData(privacy('private'));
    uiState.chatSelectedModelId = 'model-x';
    uiState.chatModels = [model('model-y')] as never;
    api.startNewChat();
    expect(uiState.chatSelectedModelId).toBe('model-y');
    api.sendMessage('hello');
    await tick(20);
    uiState.chatModels = [model('model-x', 'text', false), model('model-y')] as never;
    privacyResource.setData(privacy('anonymous'));
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true });
    await api.privacySwitchLanded('anonymous');
    expect(uiState.chatSelectedModelId).toBe('model-x');
    expect(chatAiSetModel).toHaveBeenCalledWith('conv-1', 'model-x');
  });

  it('a list read that lands after the user opened another chat leaves that chat\'s model alone', async () => {
    const listed = deferred<{ ok: boolean; data: unknown[] }>();
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [conv('conv-a', 'model-x'), conv('conv-b', 'model-x')],
      listModels: () => listed.promise,
    });
    privacyResource.setData(privacy('private'));
    await api.openConversation('conv-a');
    const landing = api.privacySwitchLanded('private');
    await api.openConversation('conv-b');
    listed.resolve({ ok: true, data: [model('model-y')] });
    await landing;
    expect(uiState.chatActiveConversation).toBe('conv-b');
    expect(chatAiSetModel).not.toHaveBeenCalled();
  });

  it('a model picked for a new chat while Private\'s list loads survives the list and the switch back', async () => {
    const listed = deferred<{ ok: boolean; data: unknown[] }>();
    const { api, uiState } = setup({
      models: [model('model-x', 'text', false), model('model-a'), model('model-b')],
      conversations: [],
      listModels: () => listed.promise,
      // The pick is saved as the last model, as the app's storage keeps it.
      stored: {},
    });
    privacyResource.setData(privacy('private'));
    api.startNewChat();
    uiState.chatSelectedModelId = 'model-x';
    const landing = api.privacySwitchLanded('private');
    // The dropdown stays usable while the list loads.
    api.selectChatModel('model-b');
    listed.resolve({ ok: true, data: [model('model-a'), model('model-b')] });
    await landing;
    expect(uiState.chatActiveConversation).toBeNull();
    expect(uiState.chatSelectedModelId).toBe('model-b');

    privacyResource.setData(privacy('anonymous'));
    await api.privacySwitchLanded('anonymous');
    expect(uiState.chatSelectedModelId).toBe('model-b');
  });

  it('a fallback for a saved model that is no longer listed moves to a free model once one appears', async () => {
    const free = { ...model('model-free'), free: true };
    const { api, uiState } = setup({ lastModel: 'model-gone', models: [model('model-paid')], conversations: [] });
    privacyResource.setData(privacy('anonymous'));
    uiState.creditsBalanceKnown = true;
    uiState.creditsTotalOwnedUsdc = '0';
    api.startNewChat();
    expect(uiState.chatSelectedModelId).toBe('model-paid');
    uiState.chatModels = [model('model-paid'), free] as never;
    api.startNewChat();
    expect(uiState.chatSelectedModelId).toBe('model-free');
  });
});

describe('opening a chat while its model is being saved', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
    privacyResource.setData(privacy('anonymous'));
  });

  it('keeps the newest pick when a read started during an older save comes back last', async () => {
    const { api, uiState } = setup({ conversations: [conv('conv-1', 'model-x')], models: [model('model-x'), model('model-a'), model('model-b')] });
    await api.openConversation('conv-1');
    const bridge = (globalThis as unknown as { __lastBridge: Record<string, unknown> }).__lastBridge;
    const olderSave = deferred<{ ok: boolean }>();
    bridge.chatAiSetModel = vi.fn(() => olderSave.promise);
    api.selectChatModel('model-a');
    const read = deferred<{ ok: boolean; data: unknown }>();
    bridge.chatAiGetConversation = vi.fn(() => read.promise);
    const opening = api.openConversation('conv-1');
    bridge.chatAiSetModel = vi.fn(async () => ({ ok: true }));
    api.selectChatModel('model-b');
    await tick();
    olderSave.resolve({ ok: true });
    await tick();
    read.resolve({ ok: true, data: conv('conv-1', 'model-x') });
    await opening;
    expect(uiState.chatSelectedModelId).toBe('model-b');
  });
});
