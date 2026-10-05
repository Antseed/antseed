import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { createInitialUiState } from '../../core/state.js';
import { initChatModule } from './controller.js';
import type { DesktopBridge } from '../../types/bridge.js';
import type { DiscoverRow } from '../../core/state.js';

const SEP = '\u0001';

function installDomTimers(): void {
  const g = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    requestAnimationFrame?: (cb: () => void) => unknown;
  };
  g.window = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  g.document = { querySelector: () => null };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type WorkspaceSetResult =
  | { ok: true; data: { current: string; default: string } }
  | { ok: false; error: string };

type ChatSendResult = Awaited<ReturnType<NonNullable<DesktopBridge['chatAiSendStream']>>>;

type Conversation = {
  id: string;
  title: string;
  service: string;
  provider: string;
  peerId: string;
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
  usage: { inputTokens: number; outputTokens: number };
};

test('discover rows are marked loaded only after a successful catalog response', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const catalog = createDeferred<{ ok: true; data: unknown[] }>();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => catalog.promise,
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => uiState.chatServiceSelectDisabled);
  assert.equal(uiState.chatDiscoverRowsLoaded, false);

  catalog.resolve({
    ok: true,
    data: [
      {
        peerId: 'peer-a',
        serviceId: 'model-a',
      },
    ],
  });

  await waitFor(() => uiState.chatDiscoverRowsLoaded && !uiState.chatServiceSelectDisabled);
  assert.equal(uiState.discoverRows[0]?.peerId, 'peer-a');
});

test('empty successful discover response still settles catalog loading', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => ({ ok: true, data: [] }),
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => uiState.chatDiscoverRowsLoaded && !uiState.chatServiceSelectDisabled);
  assert.equal(uiState.discoverRows.length, 0);
  assert.equal(uiState.runtimeActivity.message, 'Discovering services');
});

test('failed discover response does not mark catalog loaded', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => ({ ok: false, error: 'offline' }),
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => !uiState.chatServiceSelectDisabled && uiState.runtimeActivity.message === 'offline');
  assert.equal(uiState.chatDiscoverRowsLoaded, false);
});

test('completed text responses immediately record the actual routed peer', () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatConversations = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  let doneHandler: ((data: {
    conversationId: string;
    message: { role: string; content: unknown; meta?: Record<string, unknown> };
  }) => void) | null = null;
  const bridge: DesktopBridge = {
    onChatAiDone: (handler) => {
      doneHandler = handler;
      return () => undefined;
    },
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  assert.ok(doneHandler);
  (doneHandler as NonNullable<typeof doneHandler>)({
    conversationId: 'conv-a',
    message: { role: 'assistant', content: 'done', meta: { peerId: 'actual-peer' } },
  });

  assert.equal(
    (uiState.chatConversations[0] as { lastResponsePeerId?: string }).lastResponsePeerId,
    'actual-peer',
  );
});

test('opening a conversation tracks the loading gap before peer binding is restored', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatConversations = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const conversation: Conversation = {
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const conversationLoad = createDeferred<{ ok: true; data: Conversation }>();
  const bridge: DesktopBridge = {
    chatAiGetConversation: async () => conversationLoad.promise,
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  const openPromise = api.openConversation('conv-a');

  await waitFor(() => uiState.chatOpeningConversationId === 'conv-a');
  assert.equal(uiState.chatActiveConversation, 'conv-a');
  assert.equal(uiState.chatSelectedPeerId, '');

  conversationLoad.resolve({ ok: true, data: conversation });
  await openPromise;

  assert.equal(uiState.chatOpeningConversationId, null);
  assert.equal(uiState.chatSelectedPeerId, 'peer-a');
});

test('deleting a conversation removes it from the list before IPC settles', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatConversations = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const deletion = createDeferred<{ ok: boolean }>();
  const bridge: DesktopBridge = {
    chatAiDeleteConversation: async () => deletion.promise,
    chatAiListConversations: async () => ({ ok: true, data: [uiState.chatConversations[0]] }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  const deletePromise = api.deleteConversation('conv-b');

  assert.deepEqual(
    uiState.chatConversations.map((conv) => (conv as Conversation).id),
    ['conv-a'],
  );

  deletion.resolve({ ok: true });
  await deletePromise;
});

test('aborting a chat clears sending state before IPC settles', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatSending = true;
  uiState.chatSendingConversationId = 'conv-a';
  uiState.chatSendingConversationIds = ['conv-a'];
  uiState.chatInputDisabled = true;
  uiState.chatSendDisabled = true;
  uiState.chatAbortVisible = true;

  const abort = createDeferred<void>();
  const bridge: DesktopBridge = {
    chatAiAbort: async () => abort.promise,
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  const abortPromise = api.abortChat();

  assert.equal(uiState.chatSending, false);
  assert.equal(uiState.chatSendingConversationId, null);
  assert.deepEqual(uiState.chatSendingConversationIds, []);
  assert.equal(uiState.chatInputDisabled, false);
  assert.equal(uiState.chatSendDisabled, false);
  assert.equal(uiState.chatAbortVisible, false);

  abort.resolve();
  await abortPromise;
});

test('new chat created while previous response is pending keeps its own model and pin state', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatServiceOptions = [
    {
      id: 'model-a',
      label: 'Model A',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`,
      peerId: 'peer-a',
      peerDisplayName: 'Peer A',
      peerLabel: 'Peer A',
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      cachedInputUsdPerMillion: null,
      categories: [],
      description: '',
    },
    {
      id: 'model-b',
      label: 'Model B',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`,
      peerId: 'peer-b',
      peerDisplayName: 'Peer B',
      peerLabel: 'Peer B',
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      cachedInputUsdPerMillion: null,
      categories: [],
      description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-a${SEP}peer-a`;
  uiState.chatSelectedPeerId = 'peer-a';

  const conversations: Conversation[] = [];
  const sends: Array<{
    conversationId: string;
    message: string;
    service?: string;
    provider?: string;
    peerId?: string;
  }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  let resolveFirstSend: ((value: { ok: true }) => void) | null = null;

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async (service, provider, peerId) => {
      const now = Date.now();
      const id = `conv-${conversations.length + 1}`;
      conversations.push({
        id,
        title: id,
        service,
        provider: provider ?? '',
        peerId: peerId ?? '',
        messages: [],
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      return { ok: true, data: conversations[conversations.length - 1] };
    },
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      // Keep the first request pending long enough to reproduce the race where
      // the user opens/sends a second conversation before the first responds.
      if (conversationId === 'conv-1') {
        return await new Promise<{ ok: true }>((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({
    bridge,
    uiState,
    appendSystemLog: () => undefined,
  });

  api.sendMessage('first message');
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-1',
    message: 'first message',
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });
  assert.deepEqual(uiState.chatSendingConversationIds, ['conv-1']);

  // Mirrors Discover's order: reset draft, then pin the chosen service/peer.
  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  api.sendMessage('second message');

  await waitFor(() => sends.length === 2);
  assert.deepEqual(sends[1], {
    conversationId: 'conv-2',
    message: 'second message',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
  assert.equal(conversations[0]!.peerId, '');
  assert.equal(conversations[1]!.peerId, 'peer-b');
  assert.equal(uiState.chatActiveConversation, 'conv-2');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeer, 'Peer B');

  await api.openConversation('conv-1');
  assert.equal(uiState.chatActiveConversation, 'conv-1');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');

  resolveFirstSend?.({ ok: true });
  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-1' });
    handler({ conversationId: 'conv-2' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});


test('mixed-capability auto image routes require moderation and appear immediately while generation is pending', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatConversations = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'text-model',
    provider: 'openai',
    peerId: 'text-peer',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [
    {
      rowKey: 'image-peer:image-model',
      peerId: 'image-peer',
      serviceId: 'image-model',
      protocol: 'openai-images',
      capabilities: { supportedParameters: ['moderation'] },
      effectiveReputationScore: 80,
    } as DiscoverRow,
    {
      rowKey: 'legacy-image-peer:image-model',
      peerId: 'legacy-image-peer',
      serviceId: 'image-model',
      protocol: 'openai-images',
      effectiveReputationScore: 70,
    } as DiscoverRow,
  ];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'auto',
    peerId: null,
  };

  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const bridge: DesktopBridge = {
    chatGenerateImage: async (payload) => {
      request = payload;
      return generation.promise;
    },
  };
  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.generateImage('A tiny ant astronaut');

  await waitFor(() => uiState.chatSending);
  assert.deepEqual(uiState.chatMessages, [{
    role: 'user',
    content: 'A tiny ant astronaut',
    createdAt: (uiState.chatMessages[0] as { createdAt: number }).createdAt,
  }]);
  assert.equal(uiState.chatThinkingPhase, 'Generating image');
  api.handleLogLineForThinkingPhase('[BuyerPayment] authorizeSpending');
  assert.equal(uiState.chatThinkingPhase, 'Generating image');
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: 'A tiny ant astronaut',
    moderation: 'low',
    service: 'image-model',
  });

  generation.resolve({
    ok: true,
    user: { role: 'user', content: 'A tiny ant astronaut', createdAt: 10 },
    assistant: {
      role: 'assistant',
      content: [{ type: 'file', fileName: 'generated.png', mimeType: 'image/png' }],
      createdAt: 11,
      meta: { peerId: 'image-peer', service: 'image-model' },
    },
  });

  await waitFor(() => !uiState.chatSending);
  assert.equal(uiState.chatMessages.length, 2);
  assert.equal((uiState.chatMessages[0] as { role: string }).role, 'user');
  assert.equal((uiState.chatMessages[1] as { role: string }).role, 'assistant');
  assert.equal((uiState.chatConversations[0] as { lastResponsePeerId?: string }).lastResponsePeerId, 'image-peer');
});

test('auto image routes send low moderation when every eligible seller supports it', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatConversations = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'text-model',
    provider: 'openai',
    peerId: 'text-peer',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [
    {
      rowKey: 'image-peer-a:image-model',
      peerId: 'image-peer-a',
      serviceId: 'image-model',
      protocol: 'openai-images',
      capabilities: { supportedParameters: ['moderation'] },
      effectiveReputationScore: 80,
    } as DiscoverRow,
    {
      rowKey: 'image-peer-b:image-model',
      peerId: 'image-peer-b',
      serviceId: 'image-model',
      protocol: 'openai-images',
      capabilities: { supportedParameters: ['MODERATION'] },
      effectiveReputationScore: 70,
    } as DiscoverRow,
  ];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'auto',
    peerId: null,
  };

  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const api = initChatModule({
    bridge: { chatGenerateImage: async (payload) => { request = payload; return generation.promise; } },
    uiState,
    appendSystemLog: () => undefined,
  });

  api.generateImage('A tiny ant astronaut');
  await waitFor(() => uiState.chatSending);
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: 'A tiny ant astronaut',
    moderation: 'low',
    service: 'image-model',
  });

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('pinned image prompts route to the explicitly selected seller', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatConversations = [{
    id: 'conv-a', title: 'Conversation A', service: 'text-model', provider: 'openai', peerId: 'text-peer',
    messages: [], createdAt: Date.now(), updatedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [{
    rowKey: 'venice-peer:image-model', peerId: 'venice-peer', serviceId: 'image-model',
    protocol: 'openai-images', effectiveReputationScore: 99,
    capabilities: { supportedParameters: ['moderation'] },
  } as DiscoverRow];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'pinned-peer',
    peerId: 'venice-peer',
  };

  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const api = initChatModule({
    bridge: { chatGenerateImage: async (payload) => { request = payload; return generation.promise; } },
    uiState,
    appendSystemLog: () => undefined,
  });

  api.generateImage('A flying ant');
  await waitFor(() => uiState.chatSending);
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: 'A flying ant',
    peerId: 'venice-peer',
    moderation: 'low',
    service: 'image-model',
  });

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('follow-up image prompts edit the latest generated image', async () => {
  installDomTimers();

  const existingMessages = [{
    role: 'assistant' as const,
    content: [{
      type: 'file',
      fileName: 'generated.png',
      mimeType: 'image/png',
      attachmentId: 'generated-attachment',
      generated: true,
    }],
    meta: { peerId: 'source-image-peer', service: 'image-model' },
  }];
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatMessages = existingMessages;
  uiState.chatConversations = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'text-model',
    provider: 'openai',
    peerId: 'text-peer',
    messages: existingMessages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [{
    rowKey: 'source-image-peer:image-model',
    peerId: 'source-image-peer',
    serviceId: 'image-model',
    protocol: 'openai-images',
    capabilities: { inputs: ['text', 'image'], outputs: ['image'], supportedParameters: ['moderation'] },
    effectiveReputationScore: 80,
  } as DiscoverRow];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'auto',
    peerId: null,
  };

  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const bridge: DesktopBridge = {
    chatGenerateImage: async (payload) => {
      request = payload;
      return generation.promise;
    },
  };
  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.generateImage('Now with a blue background');

  await waitFor(() => uiState.chatSending);
  assert.equal(uiState.chatThinkingPhase, 'Editing image');
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: 'Now with a blue background',
    peerId: 'source-image-peer',
    moderation: 'low',
    service: 'image-model',
    sourceImageAttachmentId: 'generated-attachment',
  });

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('switching image models edits through a seller serving the new model', async () => {
  installDomTimers();

  const existingMessages = [{
    role: 'assistant' as const,
    content: [{
      type: 'file',
      fileName: 'generated.png',
      mimeType: 'image/png',
      attachmentId: 'generated-attachment',
      generated: true,
    }],
    meta: { peerId: 'old-image-peer', service: 'old-image-model' },
  }];
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatMessages = existingMessages;
  uiState.chatConversations = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'text-model',
    provider: 'openai',
    peerId: 'text-peer',
    messages: existingMessages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [
    {
      rowKey: 'new-image-peer:new-image-model',
      peerId: 'new-image-peer',
      serviceId: 'new-image-model',
      protocol: 'openai-images',
      capabilities: { inputs: ['text', 'image'], outputs: ['image'] },
      effectiveReputationScore: 80,
    } as DiscoverRow,
    {
      rowKey: 'moderation-image-peer:new-image-model',
      peerId: 'moderation-image-peer',
      serviceId: 'new-image-model',
      protocol: 'openai-images',
      capabilities: {
        inputs: ['text', 'image'],
        outputs: ['image'],
        supportedParameters: ['moderation'],
      },
      effectiveReputationScore: 70,
    } as DiscoverRow,
  ];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'new-image-model', label: 'New Image Model', categories: [] },
    mode: 'auto',
    peerId: null,
  };

  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const bridge: DesktopBridge = {
    chatGenerateImage: async (payload) => {
      request = payload;
      return generation.promise;
    },
  };
  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.generateImage('Make it look like a watercolor');

  await waitFor(() => uiState.chatSending);
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: 'Make it look like a watercolor',
    peerId: 'moderation-image-peer',
    moderation: 'low',
    service: 'new-image-model',
    sourceImageAttachmentId: 'generated-attachment',
  });

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('generation-only image sellers generate from cumulative prompt history', async () => {
  installDomTimers();

  const existingMessages = [
    { role: 'user' as const, content: 'A red ant in a garden' },
    {
      role: 'assistant' as const,
      content: [{
        type: 'file', fileName: 'generated.png', mimeType: 'image/png',
        attachmentId: 'generated-attachment', generated: true,
      }],
      meta: { peerId: 'venice-peer', service: 'image-model' },
    },
  ];
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatMessages = existingMessages;
  uiState.chatConversations = [{
    id: 'conv-a', title: 'Conversation A', service: 'text-model', provider: 'openai', peerId: 'text-peer',
    messages: existingMessages, createdAt: Date.now(), updatedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [{
    rowKey: 'venice-peer:image-model', peerId: 'venice-peer', serviceId: 'image-model',
    protocol: 'openai-images', capabilities: { inputs: ['text'], outputs: ['image'] }, effectiveReputationScore: 99,
  } as DiscoverRow];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'pinned-peer',
    peerId: 'venice-peer',
  };
  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const api = initChatModule({
    bridge: { chatGenerateImage: async (payload) => { request = payload; return generation.promise; } },
    uiState,
    appendSystemLog: () => undefined,
  });

  api.generateImage('Now make it blue');
  await waitFor(() => uiState.chatSending);

  assert.equal(uiState.chatThinkingPhase, 'Generating image');
  assert.deepEqual(request, {
    conversationId: 'conv-a',
    prompt: [
      'Generate a new image using the full conversation history below as cumulative instructions.',
      '',
      'Initial request: A red ant in a garden',
      'Follow-up 1: Now make it blue',
      '',
      'Return only the newly generated image.',
    ].join('\n'),
    peerId: 'venice-peer',
    moderation: 'low',
    service: 'image-model',
  });
  assert.equal(uiState.chatMessages.at(-1)?.content, request?.prompt);

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('generation-only image prompt history grows without nesting prior cumulative prompts', async () => {
  installDomTimers();

  const cumulativePrompt = [
    'Generate a new image using the full conversation history below as cumulative instructions.',
    '',
    'Initial request: A red ant in a garden',
    'Follow-up 1: Now make it blue',
    '',
    'Return only the newly generated image.',
  ].join('\n');
  const existingMessages = [
    { role: 'user' as const, content: 'A red ant in a garden' },
    {
      role: 'assistant' as const,
      content: [{ type: 'file', attachmentId: 'first-image', generated: true }],
      meta: { peerId: 'venice-peer', service: 'image-model' },
    },
    { role: 'user' as const, content: cumulativePrompt },
    {
      role: 'assistant' as const,
      content: [{ type: 'file', attachmentId: 'second-image', generated: true }],
      meta: { peerId: 'venice-peer', service: 'image-model' },
    },
  ];
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatMessages = existingMessages;
  uiState.chatConversations = [{
    id: 'conv-a', title: 'Conversation A', service: 'text-model', provider: 'openai', peerId: 'text-peer',
    messages: existingMessages, createdAt: Date.now(), updatedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0 },
  }];
  uiState.vprRoutableRows = [{
    rowKey: 'venice-peer:image-model', peerId: 'venice-peer', serviceId: 'image-model',
    protocol: 'openai-images', capabilities: { inputs: ['text'], outputs: ['image'] }, effectiveReputationScore: 99,
  } as DiscoverRow];
  uiState.chatImageRouteSelection = {
    model: { provider: 'openai', serviceId: 'image-model', label: 'Image Model', categories: [] },
    mode: 'pinned-peer',
    peerId: 'venice-peer',
  };
  const generation = createDeferred<Awaited<ReturnType<NonNullable<DesktopBridge['chatGenerateImage']>>>>();
  let request: Parameters<NonNullable<DesktopBridge['chatGenerateImage']>>[0] | null = null;
  const api = initChatModule({
    bridge: { chatGenerateImage: async (payload) => { request = payload; return generation.promise; } },
    uiState,
    appendSystemLog: () => undefined,
  });

  api.generateImage('Make it a watercolor');
  await waitFor(() => uiState.chatSending);

  assert.equal(request?.prompt, [
    'Generate a new image using the full conversation history below as cumulative instructions.',
    '',
    'Initial request: A red ant in a garden',
    'Follow-up 1: Now make it blue',
    'Follow-up 2: Make it a watercolor',
    '',
    'Return only the newly generated image.',
  ].join('\n'));
  assert.equal(request?.prompt.match(/Generate a new image using/g)?.length, 1);
  assert.equal(request?.moderation, 'low');

  generation.resolve({ ok: false, error: 'Request aborted' });
  await waitFor(() => !uiState.chatSending);
});

test('stream errors clear when switching conversations', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const streamErrorHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamError']>>[0]>> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    onChatAiStreamError: (handler) => {
      streamErrorHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Upstream refused the request',
    stopReason: {
      kind: 'http_error',
      source: 'upstream',
      retryable: false,
      message: 'Upstream refused the request',
      statusCode: 500,
    },
  });

  assert.equal(uiState.chatError, 'Upstream refused the request');

  await api.openConversation('conv-b');
  assert.equal(uiState.chatError, null);

  await api.openConversation('conv-a');
  assert.equal(uiState.chatError, null);
});

test('payment-required card clears when switching conversations or models', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [{ role: 'user', content: 'paywalled prompt', createdAt: Date.now() - 1_000 }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  let creditsCalls = 0;
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamErrorHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamError']>>[0]>> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    creditsGetInfo: async () => {
      creditsCalls += 1;
      return {
        ok: true,
        data: {
          evmAddress: null,
          operatorAddress: null,
          balanceUsdc: '0',
          reservedUsdc: '0',
          availableUsdc: '0',
          pendingUsdc: '0',
          spendableUsdc: '0',
          walletUsdc: '0',
          totalOwnedUsdc: '0',
          creditLimitUsdc: '0',
        },
        error: null,
      };
    },
    onChatAiStreamError: (handler) => {
      streamErrorHandlers.push(handler);
      return () => undefined;
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    chatAiSelectPeer: async () => ({ ok: true }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  const emitPaymentRequired = () => streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'payment_required:1000000',
    stopReason: {
      kind: 'payment_required',
      source: 'billing',
      retryable: false,
      message: 'Payment required',
      statusCode: 402,
      errorCode: 'payment_required',
    },
  });

  emitPaymentRequired();
  await waitFor(() => creditsCalls === 1);
  await waitFor(() => uiState.chatPaymentApprovalVisible === true);
  assert.equal(uiState.chatPaymentApprovalPeerName, 'Peer A');

  api.retryAfterPayment();
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'paywalled prompt',
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });
  assert.equal(uiState.chatPaymentApprovalVisible, true);
  assert.equal(uiState.chatPaymentApprovalPeerName, 'Peer A');

  streamDoneHandlers[0]?.({ conversationId: 'conv-a' });
  assert.equal(uiState.chatPaymentApprovalVisible, true);
  assert.equal(uiState.chatPaymentApprovalPeerName, 'Peer A');

  await api.openConversation('conv-b');
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.equal(uiState.chatPaymentApprovalPeerName, null);

  await api.openConversation('conv-a');
  emitPaymentRequired();
  await waitFor(() => creditsCalls === 2);
  await waitFor(() => uiState.chatPaymentApprovalVisible === true);

  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.equal(uiState.chatPaymentApprovalPeerName, null);
});

test('discover-selected draft keeps its peer if another discover chat is opened before create finishes', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [];
  const sends: Array<{ conversationId: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  let resolveFirstCreate: ((value: { ok: true; data: Conversation }) => void) | null = null;

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async (service, provider, peerId) => {
      const now = Date.now();
      const conversation: Conversation = {
        id: `conv-${conversations.length + 1}`,
        title: `conv-${conversations.length + 1}`,
        service,
        provider: provider ?? '',
        peerId: peerId ?? '',
        messages: [],
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      conversations.push(conversation);
      if (conversation.id === 'conv-1') {
        return await new Promise<{ ok: true; data: Conversation }>((resolve) => {
          resolveFirstCreate = resolve;
        });
      }
      return { ok: true, data: conversation };
    },
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, _message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-a${SEP}peer-a`, 'peer-a');
  api.sendMessage('first');

  await waitFor(() => conversations.length === 1);

  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');

  api.sendMessage('second');
  await waitFor(() => sends.some((send) => send.conversationId === 'conv-2'));

  resolveFirstCreate?.({ ok: true, data: conversations[0]! });
  await waitFor(() => sends.length === 2);

  assert.deepEqual(sends.find((send) => send.conversationId === 'conv-1'), {
    conversationId: 'conv-1',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.deepEqual(sends.find((send) => send.conversationId === 'conv-2'), {
    conversationId: 'conv-2',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
  assert.equal(conversations[0]!.peerId, 'peer-a');
  assert.equal(conversations[1]!.peerId, 'peer-b');
  assert.equal(uiState.chatActiveConversation, 'conv-2');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeer, 'Peer B');

  await api.openConversation('conv-1');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-1' });
    handler({ conversationId: 'conv-2' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

test('queued send targets its original conversation after switching chats', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-b');

  // Mirrors ChatView's pending queue flush: the draft was authored in conv-a,
  // but the user has since opened conv-b. It must still route to conv-a's peer.
  api.sendMessageToConversation('conv-a', 'queued for a');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'queued for a',
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });
  assert.equal(uiState.chatActiveConversation, 'conv-b');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.deepEqual(uiState.chatSendingConversationIds, ['conv-a']);

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

function chatOption(id: string, peerId: string) {
  return {
    id,
    label: id,
    provider: 'openai',
    protocol: 'openai-chat-completions',
    count: 1,
    value: `openai${SEP}${id}${SEP}${peerId}`,
    peerId,
    peerDisplayName: peerId,
    peerLabel: peerId,
    peerIconUrl: null,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    categories: [],
    description: '',
  };
}

function makeChatBridge(
  sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }>,
  conversations: Conversation[] = [],
): DesktopBridge {
  return {
    chatAiCreateConversation: async (service, provider, peerId) => {
      const now = Date.now();
      const conversation: Conversation = {
        id: `conv-${conversations.length + 1}`,
        title: `conv-${conversations.length + 1}`,
        service,
        provider: provider ?? '',
        peerId: peerId ?? '',
        messages: [],
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      conversations.push(conversation);
      return { ok: true, data: conversation };
    },
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((candidate) => candidate.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
  };
}

test('new chat created with AI VPN selected model uses the matching service and peer', async () => {
  installDomTimers();
  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [chatOption('model-a', 'peer-a'), chatOption('model-b', 'peer-b')];
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-b', label: 'Model B', categories: [] },
    mode: 'pinned-peer',
    peerId: 'peer-b',
  };
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const api = initChatModule({ bridge: makeChatBridge(sends), uiState, appendSystemLog: () => undefined });

  api.sendMessage('hello from vpr');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-1',
    message: 'hello from vpr',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
});

test('explicit dropdown pick overrides the AI VPN auto-selected model for a new chat', async () => {
  installDomTimers();
  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [chatOption('model-a', 'peer-a'), chatOption('model-b', 'peer-b')];
  // Discover auto-populated the AI VPN selection with the top catalog entry.
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-a', label: 'model-a', categories: [] },
    mode: 'auto',
    peerId: null,
  };
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const api = initChatModule({ bridge: makeChatBridge(sends), uiState, appendSystemLog: () => undefined });

  // The user explicitly picks model-b in the ChatView dropdown; the pick must
  // win over the AI VPN default (previously it was silently overridden).
  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`);
  api.sendMessage('explicit pick wins');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-1',
    message: 'explicit pick wins',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
  // The write-through keeps the AI VPN selection in sync with the pick.
  assert.equal(uiState.vprRouteSelection.model?.serviceId, 'model-b');
  assert.equal(uiState.vprRouteSelection.peerId, 'peer-b');
  assert.equal(uiState.vprModelPins['modelb'], 'peer-b');
});

test('active legacy conversation keeps its model without treating its saved peer as a pin', async () => {
  installDomTimers();
  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [chatOption('model-a', 'peer-a'), chatOption('model-b', 'peer-b')];
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-b', label: 'Model B', categories: [] },
    mode: 'pinned-peer',
    peerId: 'peer-b',
  };
  const conversations: Conversation[] = [{
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }];
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const api = initChatModule({ bridge: makeChatBridge(sends, conversations), uiState, appendSystemLog: () => undefined });

  await api.refreshChatConversations();
  await api.openConversation('conv-a');
  api.sendMessage('still active conversation');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'still active conversation',
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });
});

test('pinned AI VPN peer with missing option falls back to existing chat selected value', async () => {
  installDomTimers();
  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [chatOption('model-a', 'peer-a'), chatOption('model-b', 'peer-b')];
  uiState.chatSelectedServiceValue = `openai${SEP}model-a${SEP}peer-a`;
  uiState.chatSelectedPeerId = 'peer-a';
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-b', label: 'Model B', categories: [] },
    mode: 'pinned-peer',
    peerId: 'missing-peer',
  };
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const api = initChatModule({ bridge: makeChatBridge(sends), uiState, appendSystemLog: () => undefined });

  api.sendMessage('fallback');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-1',
    message: 'fallback',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
});

test('sending from reopened conversation ignores unrelated global dropdown peer', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-b${SEP}peer-b`;
  uiState.chatSelectedPeerId = 'peer-b';

  const conversation: Conversation = {
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const sends: Array<{ service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({ ok: true, data: { ...conversation, messages: [] } }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (_conversationId, _message, service, provider, _attachments, peerId) => {
      sends.push({ service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.openConversation('conv-a');

  // Simulate the user/global selector moving after the thread is open. The
  // legacy saved peer remains display affinity, while dispatch stays model-only.
  uiState.chatSelectedServiceValue = `openai${SEP}model-b${SEP}peer-b`;
  uiState.chatSelectedPeerId = 'peer-b';

  api.sendMessage('still for peer a');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });
  assert.equal(uiState.chatActiveConversation, 'conv-a');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

test('opening a conversation restores its workspace path', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/default/workspace';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspace: async () => ({ ok: true, data: { current: '/default/workspace', default: '/default' } }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: '/default/workspace',
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      // Simulate that conv-a was created in /project-a and conv-b in /project-b
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      uiState.chatWorkspacePath = workspacePath;
      return { ok: true, data: { current: workspacePath, default: '/default' } };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  // Before opening any conversation, workspace is the default
  assert.equal(uiState.chatWorkspacePath, '/default/workspace');

  // Open conv-project-a — should restore workspace to /project-a
  await api.openConversation('conv-project-a');

  // Wait for the async restoreWorkspace call
  await waitFor(() => workspaceCallLog.length >= 1, 2_000);
  assert.equal(workspaceCallLog[0], '/project-a');
  assert.equal(uiState.chatWorkspacePath, '/project-a');

  // Open conv-project-b — should restore workspace to /project-b
  workspaceCallLog.length = 0;
  await api.openConversation('conv-project-b');

  await waitFor(() => workspaceCallLog.length >= 1, 2_000);
  assert.equal(workspaceCallLog[0], '/project-b');
  assert.equal(uiState.chatWorkspacePath, '/project-b');
});

test('rapid conversation switches keep the latest workspace selected', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/default/workspace';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];
  const pendingWorkspaceSets = new Map<
    string,
    ReturnType<typeof createDeferred<WorkspaceSetResult>>
  >();

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: uiState.chatWorkspacePath,
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      const deferred = createDeferred<WorkspaceSetResult>();
      pendingWorkspaceSets.set(`${workspacePath}:${workspaceCallLog.length}`, deferred);
      return deferred.promise;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  await api.openConversation('conv-project-a');
  await waitFor(() => workspaceCallLog.length === 1);
  assert.equal(workspaceCallLog[0], '/project-a');

  await api.openConversation('conv-project-b');
  await waitFor(() => workspaceCallLog.length === 2);
  assert.equal(workspaceCallLog[1], '/project-b');

  // Let the latest switch finish first.
  pendingWorkspaceSets.get('/project-b:2')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  await waitFor(() => uiState.chatWorkspacePath === '/project-b');

  // Now a stale earlier switch finishes. The module should re-apply /project-b
  // because the stale IPC call may have changed persisted main-process state.
  pendingWorkspaceSets.get('/project-a:1')?.resolve({
    ok: true,
    data: { current: '/project-a', default: '/default' },
  });
  await waitFor(() => workspaceCallLog.length === 3);
  assert.equal(workspaceCallLog[2], '/project-b');
  pendingWorkspaceSets.get('/project-b:3')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });

  await waitFor(() => uiState.chatWorkspacePath === '/project-b');
  assert.equal(uiState.chatActiveConversation, 'conv-project-b');
});

test('stale manual workspace failure does not overwrite the latest desired conversation workspace', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/current';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];
  const pendingWorkspaceSets = new Map<
    string,
    ReturnType<typeof createDeferred<WorkspaceSetResult>>
  >();

  const bridge: DesktopBridge = {
    pickDirectory: async () => ({ ok: true, path: '/manual' }),
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: uiState.chatWorkspacePath,
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      const deferred = createDeferred<WorkspaceSetResult>();
      pendingWorkspaceSets.set(`${workspacePath}:${workspaceCallLog.length}`, deferred);
      return deferred.promise;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  await api.openConversation('conv-project-a');
  await waitFor(() => workspaceCallLog.length === 1);
  assert.equal(workspaceCallLog[0], '/project-a');

  const chooseWorkspacePromise = api.chooseWorkspace();
  await waitFor(() => workspaceCallLog.length === 2);
  assert.equal(workspaceCallLog[1], '/manual');

  await api.openConversation('conv-project-b');
  await waitFor(() => workspaceCallLog.length === 3);
  assert.equal(workspaceCallLog[2], '/project-b');

  pendingWorkspaceSets.get('/manual:2')?.resolve({ ok: false, error: 'manual failed' });
  await chooseWorkspacePromise;

  // If the stale manual failure reset desiredWorkspacePath, this older stale
  // completion would not re-apply /project-b.
  pendingWorkspaceSets.get('/project-a:1')?.resolve({
    ok: true,
    data: { current: '/project-a', default: '/default' },
  });
  await waitFor(() => workspaceCallLog.length === 4);
  assert.equal(workspaceCallLog[3], '/project-b');

  pendingWorkspaceSets.get('/project-b:3')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  pendingWorkspaceSets.get('/project-b:4')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  await waitFor(() => uiState.chatWorkspacePath === '/project-b');
});

test('opening a conversation does not switch workspace if it matches the current one', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/project-a';

  const conversation: Conversation = {
    id: 'conv-project-a',
    title: 'Project A Chat',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  const workspaceCallLog: string[] = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({
      ok: true,
      data: { ...conversation, messages: [], workspacePath: '/project-a' },
    }),
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      return { ok: true, data: { current: workspacePath, default: '/default' } };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  // The conversation's workspacePath matches current workspace (/project-a)
  // so chatAiSetWorkspace should NOT be called
  await api.openConversation('conv-project-a');

  // Give a tick for any potential async calls
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(workspaceCallLog.length, 0, 'should not call chatAiSetWorkspace when workspace already matches');
});

test('switching service mid-conversation routes the next send to the new model', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const sends: Array<{
    conversationId: string;
    message: string;
    service?: string;
    provider?: string;
    peerId?: string;
  }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
    chatAiSelectPeer: async () => ({ ok: true }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  api.sendMessage('hello from model a');
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'hello from model a',
    service: 'model-a',
    provider: 'openai',
    peerId: undefined,
  });

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);

  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');

  api.sendMessage('hello from model b');
  await waitFor(() => sends.length === 2);
  assert.deepEqual(sends[1], {
    conversationId: 'conv-a',
    message: 'hello from model b',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });

  const summary = (uiState.chatConversations as { id: string; service?: string; peerId?: string }[])
    .find((c) => c.id === 'conv-a');
  assert.equal(summary?.service, 'model-b');
  assert.equal(summary?.peerId, 'peer-b');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

/**
 * Discover row shaped for failover tests. Only the fields routing reads
 * matter; the rest are filled with inert defaults.
 */
function failoverRow(
  peerId: string,
  overrides: Partial<DiscoverRow> = {},
  serviceId = 'model-a',
): DiscoverRow {
  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId === 'model-a' ? 'Model A' : 'Model B',
    categories: [],
    provider: 'openai',
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: `Peer ${peerId}`,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    cachedInputUsdPerMillion: null,
    lifetimeSessions: 0,
    lifetimeRequests: 0,
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null,
    lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1,
    poolStakeAnts: 0,
    onChainActiveChannelCount: 0,
    onChainGhostCount: 0,
    onChainTotalVolumeUsdc: '0',
    onChainLastSettledAt: 0,
    effectiveReputationScore: 75,
    onChainReputationScore: null,
    washFlagged: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    peerCooldownUntil: null,
    peerFailureStreak: 0,
    peerLastFailureReason: null,
    selectionValue: `openai${SEP}${serviceId}${SEP}${peerId}`,
    ...overrides,
  };
}

function failoverOption(peerId: string, serviceId = 'model-a') {
  return {
    id: serviceId,
    label: serviceId === 'model-a' ? 'Model A' : 'Model B',
    provider: 'openai',
    protocol: 'openai-chat-completions' as const,
    count: 1,
    value: `openai${SEP}${serviceId}${SEP}${peerId}`,
    peerId,
    peerDisplayName: `Peer ${peerId}`,
    peerLabel: `Peer ${peerId}`,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    categories: [],
    description: '',
  };
}

/**
 * Build a chat module with two interchangeable peers and one conversation
 * already bound to `peer-a`, ready for a stream failure.
 */
function setupFailoverHarness(
  routeMode: 'auto' | 'pinned' | undefined,
  sendResult: ChatSendResult = { ok: true },
) {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [failoverOption('peer-a'), failoverOption('peer-b')];
  uiState.discoverRows = [failoverRow('peer-a'), failoverRow('peer-b')];
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-a', label: 'Model A', categories: [] },
    mode: 'auto',
    peerId: null,
  };

  const conversations: Array<Conversation & { routeMode?: 'auto' | 'pinned' }> = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      ...(routeMode ? { routeMode } : {}),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const sends: Array<{ conversationId: string; peerId?: string }> = [];
  const persistedSelections: Array<Parameters<NonNullable<DesktopBridge['chatAiSelectPeer']>>[0]> = [];
  const streamErrorHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamError']>>[0]>> = [];
  const streamStartHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamStart']>>[0]>> = [];
  const streamBlockStartHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamBlockStart']>>[0]>> = [];
  const streamDeltaHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamDelta']>>[0]>> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, _message, _service, _provider, _attachments, peerId) => {
      sends.push({ conversationId, peerId });
      return sendResult;
    },
    chatAiSelectPeer: async (payload) => {
      persistedSelections.push(payload);
      return { ok: true };
    },
    onChatAiStreamError: (handler) => {
      streamErrorHandlers.push(handler);
      return () => undefined;
    },
    onChatAiStreamStart: (handler) => {
      streamStartHandlers.push(handler);
      return () => undefined;
    },
    onChatAiStreamBlockStart: (handler) => {
      streamBlockStartHandlers.push(handler);
      return () => undefined;
    },
    onChatAiStreamDelta: (handler) => {
      streamDeltaHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  return {
    api,
    uiState,
    sends,
    persistedSelections,
    streamErrorHandlers,
    streamStartHandlers,
    streamBlockStartHandlers,
    streamDeltaHandlers,
  };
}

const RETRYABLE_STREAM_FAILURE = {
  kind: 'network_error' as const,
  source: 'transport' as const,
  retryable: true,
  message: 'Connection lost',
};

test('a retryable failure returns an auto conversation to model-only routing', async () => {
  const { api, uiState, persistedSelections, streamErrorHandlers } = setupFailoverHarness('auto');
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Connection lost',
    stopReason: RETRYABLE_STREAM_FAILURE,
  });

  // Retrying the same dead peer is exactly what this feature exists to stop.
  await waitFor(() => uiState.chatRoutingNotice !== null);
  assert.match(uiState.chatRoutingNotice ?? '', /Peer peer-a isn't responding/);
  assert.match(uiState.chatRoutingNotice ?? '', /Retrying on Peer peer-b/);
  await waitFor(() => persistedSelections.length === 1);
  assert.deepEqual(persistedSelections[0], {
    conversationId: 'conv-a',
    peerId: null,
    service: 'model-a',
    provider: 'openai',
    routeMode: 'auto',
  });
});

test('a scheduled failover still retries after the user switches conversations', async () => {
  vi.useFakeTimers();
  try {
    const { api, uiState, sends, streamErrorHandlers } = setupFailoverHarness('auto');
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sends.length, 1);

    streamErrorHandlers[0]?.({
      conversationId: 'conv-a',
      error: 'Connection lost',
      stopReason: RETRYABLE_STREAM_FAILURE,
    });
    uiState.chatActiveConversation = 'conv-other';

    await vi.advanceTimersByTimeAsync(7_000);
    assert.deepEqual(sends[1], { conversationId: 'conv-a', peerId: undefined });
    assert.equal(uiState.chatRoutingNotice, null);
  } finally {
    vi.useRealTimers();
  }
});

test('a retryable failure still schedules failover after the user switches conversations', async () => {
  vi.useFakeTimers();
  try {
    const { api, uiState, sends, streamErrorHandlers } = setupFailoverHarness('auto');
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sends[0], { conversationId: 'conv-a', peerId: undefined });

    uiState.chatActiveConversation = 'conv-other';
    streamErrorHandlers[0]?.({
      conversationId: 'conv-a',
      error: 'Connection lost',
      stopReason: RETRYABLE_STREAM_FAILURE,
    });

    await vi.advanceTimersByTimeAsync(7_000);
    assert.deepEqual(sends[1], { conversationId: 'conv-a', peerId: undefined });
    assert.equal(uiState.chatRoutingNotice, null);
  } finally {
    vi.useRealTimers();
  }
});

test('successive auto retries remain model-only', async () => {
  vi.useFakeTimers();
  try {
    const { api, uiState, sends, streamErrorHandlers } = setupFailoverHarness('auto');
    uiState.chatServiceOptions.push(failoverOption('peer-c'));
    uiState.discoverRows.push(failoverRow('peer-c'));
    await api.refreshChatConversations();
    await api.openConversation('conv-a');
    api.sendMessage('hello');
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sends[0], { conversationId: 'conv-a', peerId: undefined });

    streamErrorHandlers[0]?.({
      conversationId: 'conv-a',
      error: 'Peer A failed',
      stopReason: RETRYABLE_STREAM_FAILURE,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    assert.deepEqual(sends[1], { conversationId: 'conv-a', peerId: undefined });

    streamErrorHandlers[0]?.({
      conversationId: 'conv-a',
      error: 'Peer B failed',
      stopReason: RETRYABLE_STREAM_FAILURE,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    assert.deepEqual(sends[2], { conversationId: 'conv-a', peerId: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test('failover keeps the conversation model when the global model pill differs', async () => {
  const { api, uiState, streamErrorHandlers } = setupFailoverHarness('auto');
  uiState.chatServiceOptions = [
    failoverOption('peer-a'),
    failoverOption('peer-b'),
    failoverOption('peer-c', 'model-b'),
  ];
  uiState.discoverRows = [
    failoverRow('peer-a'),
    failoverRow('peer-b'),
    failoverRow('peer-c', {}, 'model-b'),
  ];
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'model-b', label: 'Model B', categories: [] },
    mode: 'auto',
    peerId: null,
  };
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Connection lost',
    stopReason: RETRYABLE_STREAM_FAILURE,
  });

  await waitFor(() => uiState.chatRoutingNotice !== null);
  const conversation = (uiState.chatConversations as Conversation[]).find((item) => item.id === 'conv-a');
  assert.equal(conversation?.service, 'model-a');
  assert.equal(conversation?.peerId, undefined);
});

test('a model switch can persist an auto-resolved peer without pinning the chat', async () => {
  installDomTimers();
  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [failoverOption('peer-a'), failoverOption('peer-b')];
  const conversation: Conversation = {
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    routeMode: 'auto',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const selections: Array<Record<string, unknown>> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({ ok: true, data: { ...conversation, messages: [] } }),
    chatAiSelectPeer: async (payload) => {
      selections.push(payload);
      return { ok: true };
    },
  };
  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  api.handleServiceChange(`openai${SEP}model-a${SEP}peer-b`, 'peer-b', false, 'auto');

  await waitFor(() => selections.length === 1);
  assert.equal(selections[0]?.routeMode, 'auto');
  assert.equal((uiState.chatConversations[0] as Conversation).routeMode, 'auto');
});

test('a retryable mid-stream failure preserves partial output without resending', async () => {
  const {
    api,
    uiState,
    streamErrorHandlers,
    streamStartHandlers,
    streamBlockStartHandlers,
    streamDeltaHandlers,
  } = setupFailoverHarness('auto');
  await api.refreshChatConversations();
  await api.openConversation('conv-a');
  streamStartHandlers[0]?.({ conversationId: 'conv-a', turn: 0 });
  streamBlockStartHandlers[0]?.({ conversationId: 'conv-a', index: 0, blockType: 'text' });
  streamDeltaHandlers[0]?.({
    conversationId: 'conv-a',
    index: 0,
    blockType: 'text',
    text: 'Partial answer',
  });

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Connection lost',
    stopReason: RETRYABLE_STREAM_FAILURE,
  });

  assert.equal(uiState.chatRoutingNotice, null);
  assert.equal(uiState.chatError, 'Connection lost');
  assert.equal(uiState.chatMessages.length, 1);
});

test('a retryable failure on a pinned conversation is shown instead of retried', async () => {
  const { api, uiState, streamErrorHandlers } = setupFailoverHarness('pinned');
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  const message = [
    'Oops, pinned peer could not complete the request.',
    'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
    'Original Response: {"message":"Insufficient balance","status":429}',
  ].join('\n');
  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: message,
    stopReason: {
      kind: 'http_error',
      source: 'upstream',
      retryable: true,
      message,
      statusCode: 429,
    },
  });

  assert.equal(uiState.chatRoutingNotice, null);
  assert.equal(uiState.chatError, message);
});

test('a pinned send failure without a stop reason is shown instead of retried', async () => {
  const { api, uiState, sends } = setupFailoverHarness('pinned', {
    ok: false,
    error: 'Conversation not found',
  });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  api.sendMessage('hello');

  await waitFor(() => uiState.chatError !== null);
  assert.equal(uiState.chatError, 'Conversation not found');
  assert.equal(uiState.chatRoutingNotice, null);
  assert.equal(sends.length, 1);
});

test('a non-retryable failure reports an error instead of failing over', async () => {
  const { api, uiState, streamErrorHandlers } = setupFailoverHarness('auto');
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Your deposit balance is too low',
    stopReason: {
      kind: 'http_error',
      source: 'transport',
      retryable: false,
      message: 'Your deposit balance is too low',
      statusCode: 503,
    },
  });

  // A buyer-side fault must surface the real fix, not walk the peer list.
  assert.equal(uiState.chatError, 'Your deposit balance is too low');
  assert.equal(uiState.chatRoutingNotice, null);
});

test('an aborted request never triggers failover', async () => {
  const { api, uiState, streamErrorHandlers } = setupFailoverHarness('auto');
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({ conversationId: 'conv-a', error: 'Request aborted' });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uiState.chatRoutingNotice, null);
  assert.equal(uiState.chatError, null);
});

test('no failover happens when the failed peer is the only candidate', async () => {
  const { api, uiState, streamErrorHandlers } = setupFailoverHarness('auto');
  uiState.chatServiceOptions = [failoverOption('peer-a')];
  uiState.discoverRows = [failoverRow('peer-a')];
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Connection lost',
    stopReason: RETRYABLE_STREAM_FAILURE,
  });

  // Retrying the same peer still beats refusing to send.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uiState.chatRoutingNotice, null);
});
