import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initChatModule } from './controller';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const model = (id: string, type: string) => ({ id, label: id, type, protocol: null, supportsImages: false, sellers: 1, free: false, minImageUsd: null, freeSellerId: null, freeForStakers: false, tee: false, toolUse: false, reasoning: false, inputUsdPerMillion: null, outputUsdPerMillion: null });
const spendLimit = { ok: false, error: 'Daily limit.', stopReason: { kind: 'payment_required', message: 'Daily limit.', errorCode: 'spend_limit_reached' } };
const lowFunds = { ok: false, error: 'Too low.', stopReason: { kind: 'payment_required', message: 'Too low.' } };

function setup(firstAnswer: Record<string, unknown>) {
  const uiState = createInitialUiState();
  uiState.chatModels = [model('text-model', 'text'), model('image-model', 'image')] as never;
  uiState.chatSelectedModelId = 'text-model';
  uiState.chatImageModelId = 'image-model';
  const chatGenerateImage = vi.fn()
    .mockResolvedValueOnce(firstAnswer)
    .mockResolvedValue({ ok: true, user: { role: 'user', content: 'a cat' }, assistant: { role: 'assistant', content: 'done' } });
  const bridge = {
    chatGenerateImage,
    chatAiCreateConversation: async () => ({ ok: true, data: { id: 'conv-1' } }),
    chatAiListConversations: async () => ({ ok: true, data: [{ id: 'conv-1', service: 'text-model' }] }),
    // The session doesn't have the prompt: it failed before anything was persisted.
    chatAiGetConversation: async () => ({ ok: true, data: { id: 'conv-1', service: 'text-model', messages: [] } }),
  };
  const api = initChatModule({ bridge: bridge as never, uiState, appendSystemLog: () => undefined });
  return { api, uiState, chatGenerateImage };
}

describe('a request stopped for funds', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('keeps its notice and prompt when the conversation is reopened, and Try again replays it', async () => {
    const { api, uiState, chatGenerateImage } = setup(lowFunds);
    api.generateImage('a cat');
    await tick();
    expect(uiState.chatFundsNotice).toEqual({ message: 'Too low.', canAddFunds: true });

    api.startNewChat();
    expect(uiState.chatFundsNotice).toBeNull();
    await api.openConversation('conv-1');
    expect(uiState.chatFundsNotice).toEqual({ message: 'Too low.', canAddFunds: true });
    expect(uiState.chatMessages.map((message) => (message as { content: unknown }).content)).toEqual(['a cat']);

    api.retryAfterPayment();
    await tick();
    expect(chatGenerateImage).toHaveBeenCalledTimes(2);
    expect(chatGenerateImage.mock.calls[1][0]).toMatchObject({ prompt: 'a cat', model: 'image-model' });
    expect(uiState.chatFundsNotice).toBeNull();
    await api.openConversation('conv-1');
    expect(uiState.chatFundsNotice).toBeNull();
  });

  it('does not offer Add funds for a spend limit on an image', async () => {
    const { api, uiState } = setup(spendLimit);
    api.generateImage('a cat');
    await tick();
    expect(uiState.chatFundsNotice).toEqual({ message: 'Daily limit.', canAddFunds: false });
  });

  it('stays gone once dismissed', async () => {
    const { api, uiState } = setup(lowFunds);
    api.generateImage('a cat');
    await tick();
    api.dismissFundsNotice();
    await api.openConversation('conv-1');
    expect(uiState.chatFundsNotice).toBeNull();
  });
});
