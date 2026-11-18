import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initChatModule } from './controller';

type Conv = { id: string; title: string; service: string; messages: unknown[]; createdAt: number; updatedAt: number; usage: { inputTokens: number; outputTokens: number }; workspacePath?: string; studioProjectId?: string };

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 400): Promise<void> {
  for (let i = 0; i < ms / 2 && !predicate(); i++) await tick(2);
  expect(predicate()).toBe(true);
}
const model = (id: string) => ({ id, label: id, type: 'text', protocol: 'openai-chat-completions', supportsImages: false, sellers: 1, free: false, minImageUsd: null, freeSellerId: null, freeForStakers: false, tee: false, toolUse: true, reasoning: false, inputUsdPerMillion: null, outputUsdPerMillion: null });
const conv = (id: string, extra: Partial<Conv> = {}): Conv => ({ id, title: id, service: 'model-a', messages: [], createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0 }, ...extra });

function setup(conversations: Conv[], projectChats: Record<string, string> = {}) {
  const uiState = createInitialUiState();
  uiState.chatModels = [model('model-a')] as never;
  uiState.chatSelectedModelId = 'model-a';
  uiState.creditsBalanceKnown = true;
  uiState.creditsTotalOwnedUsdc = '5';
  uiState.chatWorkspacePath = '/work';
  const sends: Array<{ convId: string; content: string }> = [];
  const setWorkspace: string[] = [];
  const plainChatsMade: string[] = [];
  const studioChatsMade: Array<{ projectId: string; model: string }> = [];
  const on = () => () => () => undefined;
  const bridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id: string) => {
      const found = conversations.find((candidate) => candidate.id === id);
      return found ? { ok: true, data: { ...found } } : { ok: false, error: 'not found' };
    },
    chatAiCreateConversation: async (service: string) => {
      const created = conv(`conv-${String(conversations.length + 1)}`, { service, workspacePath: '/work' });
      conversations.push(created);
      plainChatsMade.push(created.id);
      return { ok: true, data: created };
    },
    studioProjectChat: async (projectId: string, modelId?: string) => {
      const existing = projectChats[projectId];
      if (existing) return { ok: true, conversationId: existing };
      if (!modelId) return { ok: true, conversationId: null };
      const created = conv(`studio-${projectId}`, { service: modelId, workspacePath: `/studio/${projectId}`, studioProjectId: projectId });
      conversations.push(created);
      projectChats[projectId] = created.id;
      studioChatsMade.push({ projectId, model: modelId });
      return { ok: true, conversationId: created.id };
    },
    chatAiSetWorkspace: async (path: string) => { setWorkspace.push(path); return { ok: true, data: { current: path, default: '/default' } }; },
    chatAiSetModel: async () => ({ ok: true }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (convId: string, content: string) => { sends.push({ convId, content }); return { ok: true }; },
    onChatAiStreamStart: on(),
    onChatAiStreamBlockStart: on(),
    onChatAiStreamDelta: on(),
    onChatAiStreamDone: on(),
    onChatAiStreamError: on(),
    onChatAiDone: on(),
    onChatAiUserPersisted: on(),
  };
  const api = initChatModule({ bridge: bridge as never, uiState, appendSystemLog: () => undefined });
  return { api, uiState, sends, setWorkspace, plainChatsMade, studioChatsMade };
}

describe('chat controller: Studio projects', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined }, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  });

  it('opens a project on its own chat without moving the workspace new chats start in', async () => {
    const chat = conv('studio-chat', { workspacePath: '/studio/lighthouse', studioProjectId: 'lighthouse' });
    const { api, uiState, setWorkspace } = setup([conv('conv-a', { workspacePath: '/work' }), chat], { lighthouse: 'studio-chat' });
    await api.refreshChatConversations();
    await api.openStudioProject('lighthouse');
    expect(uiState.chatActiveConversation).toBe('studio-chat');
    await tick();
    expect(setWorkspace).toEqual([]);
    expect(uiState.chatWorkspacePath).toBe('/work');
  });

  it('makes the chat of a new project in its folder with the first message', async () => {
    const { api, uiState, sends, plainChatsMade, studioChatsMade } = setup([conv('conv-a')]);
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    await api.openStudioProject('surf-ants');
    expect(uiState.chatActiveConversation).toBeNull();
    expect(studioChatsMade).toEqual([]);

    api.sendMessage('a surf video with ants');
    await waitFor(() => sends.length === 1);
    expect(studioChatsMade).toEqual([{ projectId: 'surf-ants', model: 'model-a' }]);
    expect(plainChatsMade).toEqual([]);
    expect(sends[0]).toEqual({ convId: 'studio-surf-ants', content: 'a surf video with ants' });
    expect(uiState.chatActiveConversation).toBe('studio-surf-ants');
  });

  it('a new chat started after leaving the Studio is an ordinary chat', async () => {
    const { api, sends, plainChatsMade, studioChatsMade } = setup([]);
    await api.openStudioProject('surf-ants');
    api.leaveStudioProject();
    api.sendMessage('hello');
    await waitFor(() => sends.length === 1);
    expect(studioChatsMade).toEqual([]);
    expect(plainChatsMade).toHaveLength(1);

    await api.openStudioProject('surf-ants');
    api.startNewChat();
    api.sendMessage('hello again');
    await waitFor(() => sends.length === 2);
    expect(studioChatsMade).toEqual([]);
  });

  it('does not pull the user back to a project they left while its chat was looked up', async () => {
    const { api, uiState } = setup([conv('conv-a'), conv('studio-chat', { studioProjectId: 'lighthouse' })], { lighthouse: 'studio-chat' });
    await api.refreshChatConversations();
    const opening = api.openStudioProject('lighthouse');
    api.leaveStudioProject();
    await api.openConversation('conv-a');
    await opening;
    expect(uiState.chatActiveConversation).toBe('conv-a');
  });
});
