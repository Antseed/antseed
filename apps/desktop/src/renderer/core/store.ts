import type { RendererUiState } from './state';
import type { ContentBlock } from '../ui/components/chat/chat-shared';
import { cloneContentBlock } from '../ui/components/chat/chat-shared';

type Listener = () => void;

let listeners: Listener[] = [];
let stateRef: RendererUiState | null = null;
let version = 0;
let cachedSnapshotVersion = -1;
let cachedSnapshot: RendererUiState | null = null;
let notifyPending = false;

function invalidateSnapshot(): void {
  version += 1;
  cachedSnapshotVersion = -1;
  cachedSnapshot = null;
}

function emitListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function initStore(state: RendererUiState): void {
  stateRef = state;
  version = 0;
  cachedSnapshotVersion = -1;
  cachedSnapshot = null;
}

export function notifyUiStateChanged(): void {
  invalidateSnapshot();
  if (!notifyPending) {
    notifyPending = true;
    setTimeout(() => {
      notifyPending = false;
      emitListeners();
    }, 0);
  }
}

export function notifyUiStateChangedSync(): void {
  invalidateSnapshot();
  if (notifyPending) {
    notifyPending = false;
  }
  emitListeners();
}

export function subscribe(listener: Listener): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getStateRef(): RendererUiState {
  if (!stateRef) {
    throw new Error('Store not initialized — call initStore() before rendering');
  }
  return stateRef;
}

export function getUiStateRef(): RendererUiState {
  return getStateRef();
}

export function getUiSnapshot(): RendererUiState {
  if (cachedSnapshot && cachedSnapshotVersion === version) {
    return cachedSnapshot;
  }

  const state = getStateRef();
  cachedSnapshot = {
    ...state,
    installedPlugins: new Set(state.installedPlugins),
    pluginHints: { ...state.pluginHints },
    peerSort: { ...state.peerSort },
    runtimeActivity: { ...state.runtimeActivity },
    configFormData: state.configFormData ? { ...state.configFormData } : null,
    configMessage: state.configMessage ? { ...state.configMessage } : null,
    logs: [...state.logs],
    overviewPeers: [...state.overviewPeers],
    lastPeers: [...state.lastPeers],
    chatConversations: [...state.chatConversations],
    chatMessages: [...state.chatMessages],
    chatStreamingMessage: state.chatStreamingMessage
      ? {
          ...state.chatStreamingMessage,
          meta: state.chatStreamingMessage.meta ? { ...state.chatStreamingMessage.meta } : undefined,
          content: Array.isArray(state.chatStreamingMessage.content)
            ? (state.chatStreamingMessage.content as ContentBlock[]).map(cloneContentBlock)
            : state.chatStreamingMessage.content,
        }
      : null,
    chatActiveChannels: new Map(state.chatActiveChannels),
    // chatModels is reassigned wholesale at every mutation site, so the
    // top-level spread passes its reference through safely.
  };
  cachedSnapshotVersion = version;
  return cachedSnapshot;
}
