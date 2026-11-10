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

function setup(options: { lastModel?: string; stored?: Record<string, string>; send?: () => Promise<unknown>; image?: () => Promise<unknown>; models?: unknown[]; conversations?: Array<ReturnType<typeof conv>> } = {}) {
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
  };
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
    expect(chatAiSendStream.mock.calls[0]?.[5]).toEqual({ requirePrivate: true });
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
    expect(chatAiSendStream.mock.calls[1]?.[5]).toEqual({ requirePrivate: false });
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

  it('goes back only in the chat it was chosen for', async () => {
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [conv('conv-a', 'model-x'), conv('conv-b', 'model-y')],
    });
    privacyResource.setData(privacy('anonymous'));
    await api.openConversation('conv-a');
    api.privacyModeChosen('private');
    expect(uiState.chatSelectedModelId).toBe('model-y');
    await tick();

    await api.openConversation('conv-b');
    chatAiSetModel.mockClear();
    api.privacyModeChosen('anonymous');
    await tick();
    expect(uiState.chatSelectedModelId).toBe('model-y');
    expect(chatAiSetModel).not.toHaveBeenCalled();
  });

  it('goes back in a chat started on it while Private was on', async () => {
    const { api, uiState, chatAiSetModel } = setup({
      models: [model('model-x', 'text', false), model('model-y')],
      conversations: [],
    });
    privacyResource.setData(privacy('anonymous'));
    uiState.chatSelectedModelId = 'model-x';
    api.privacyModeChosen('private');
    privacyResource.setData(privacy('private'));
    api.sendMessage('hello');
    await tick(20);
    expect(uiState.chatActiveConversation).toBe('conv-1');
    api.privacyModeChosen('anonymous', { keepPrivateHistory: true });
    await tick();
    expect(uiState.chatSelectedModelId).toBe('model-x');
    expect(chatAiSetModel).toHaveBeenCalledWith('conv-1', 'model-x');
  });
});
