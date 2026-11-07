import { describeChatError } from './chat-errors';
import { splitPinnedModel } from '../../../shared/pinned-model.js';
import { selectHasFunds } from '../../core/balance';
import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged, notifyUiStateChangedSync } from '../../core/store';
import type {
  ChatModel,
  ChatPermissionMode,
  DesktopBridge,
  PreparedChatAttachment,
  RawChatAttachment,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../../types/bridge';
import type { ChatMessage, ContentBlock } from '../../ui/components/chat/chat-shared';
import {
  cloneContentBlock,
  isImageRequestPhase,
  normalizeAssistantMeta,
  paymentLogToThinkingPhase,
} from '../../ui/components/chat/chat-shared';
import { recordFirstModelShown } from '../telemetry/actions';
import {
  buildCumulativeImagePrompt,
  chooseDefaultChatModel,
  chooseModelForPrivate,
  findChatModel,
  fundsNoticeFromStopReason,
  loadLastChatModel,
  saveLastChatModel,
} from './models';

type ChatConversationSummary = {
  id: string;
  title?: string;
  /** Gateway model id the conversation last used. */
  service?: string;
  workspacePath?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  totalTokens?: number;
  totalEstimatedCostUsd?: number;
  [key: string]: unknown;
};

type ChatConversation = ChatConversationSummary & {
  messages?: ChatMessage[];
};

type ChatModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  appendSystemLog: (message: string) => void;
  onResponseCompleted?: (conversationId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    service: string | null;
  }) => void;
};

export type ChatModuleApi = {
  /** Reload the gateway's model list (`force` skips main's one-minute cache). */
  refreshChatModels: (options?: { force?: boolean }) => Promise<void>;
  privacyModeChosen: (mode: 'anonymous' | 'private') => void;
  privacySwitchLanded: (mode: 'anonymous' | 'private') => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  startNewChat: () => void;
  startNewChatOnModel: (modelId: string) => void;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[]) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[]) => void;
  generateImage: (prompt: string) => void;
  /** Pick a model in the composer dropdown: a text model rebinds the chat, an image model switches Send to image generation. */
  selectChatModel: (modelId: string) => void;
  /** Resend the last user message if it stopped for lack of funds (e.g. after a deposit). */
  retryAfterPayment: () => void;
  dismissFundsNotice: () => void;
  abortChat: () => Promise<void>;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  decideToolApproval: (decision: ToolApprovalDecision, requestId?: string) => void;
  handleLogLineForThinkingPhase: (line: string) => void;
};

const MODEL_LIST_RETRY_MS = 15_000;
/** Automatic retries after a failed model list; the dropdown's Retry and gateway changes reset them. */
const MODEL_LIST_MAX_AUTO_RETRIES = 4;

type ImageRequest = { prompt: string; model: string; sourceImageAttachmentId?: string };

export function initChatModule({
  bridge,
  uiState,
  appendSystemLog,
  onResponseCompleted,
}: ChatModuleOptions): ChatModuleApi {
  // ---------------------------------------------------------------------------
  // Module-local state
  // ---------------------------------------------------------------------------

  let activeConversation: ChatConversation | null = null;
  let workspaceSwitchToken = 0;
  let permissionRefreshToken = 0;
  let desiredWorkspacePath: string | null = uiState.chatWorkspacePath || null;
  let newChatDraftVersion = 0;
  let firstModelShownRecorded = false;
  const sendingConversationIds = new Set<string>();
  const streamStartedAtByConversation = new Map<string, number>();
  const streamCompletedAtByConversation = new Map<string, number>();
  const streamFailedAtByConversation = new Map<string, number>();
  const localConversationMessages = new Map<string, ChatMessage[]>();
  const streamingMessagesByConversation = new Map<string, ChatMessage>();
  const pendingStreamingUiFlushes = new Set<string>();
  /** In-flight model rebinds, awaited before the conversation's next send. */
  const pendingModelUpdates = new Map<string, Promise<{ ok: boolean; error?: string }>>();
  /** Conversations whose last send stopped for lack of funds. */
  const fundsBlockedConversationIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function toErrorMessage(err: unknown, fallback = 'Unexpected error'): string {
    if (typeof err === 'string' && err.trim().length > 0) return err;
    if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.trim().length > 0) {
      return err.message;
    }
    return fallback;
  }

  function showChatError(message: unknown): void {
    uiState.chatError = describeChatError(
      toErrorMessage(message, 'Unexpected chat error'),
      (id) => uiState.chatModels.find((model) => model.id === id)?.label,
    );
    notifyUiStateChanged();
  }

  function clearChatNotices(): void {
    uiState.chatError = null;
    uiState.chatFundsNotice = null;
  }

  function reportChatError(err: unknown, fallback: string): string {
    const message = toErrorMessage(err, fallback);
    showChatError(message);
    appendSystemLog(`Chat error: ${message}`);
    return message;
  }

  function showFundsNotice(convId: string, notice: { message: string; canAddFunds: boolean }): void {
    fundsBlockedConversationIds.add(convId);
    if (convId === uiState.chatActiveConversation) {
      uiState.chatError = null;
      uiState.chatFundsNotice = notice;
      notifyUiStateChanged();
    }
  }

  function getConversationSummaries(): ChatConversationSummary[] {
    return Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[])
      : [];
  }

  function findConversationSummary(convId: string): ChatConversationSummary | null {
    if (activeConversation?.id === convId) return activeConversation;
    return getConversationSummaries().find((c) => c.id === convId) ?? null;
  }

  function getConversationId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const id = (payload as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  let modelRefreshInFlight: Promise<void> | null = null;
  let modelRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let modelRetryCount = 0;

  /** The new-chat default: the last model used (if the gateway still lists it), else the first text model. */
  /** The model Private moved away from, for going back. Survives leaving Home. */
  let modelMovedForPrivate: { from: string; to: string } | null = null;

  function applyDefaultModel(): void {
    if (activeConversation) return;
    const current = uiState.chatSelectedModelId;
    const listed = current ? findChatModel(uiState.chatModels, current) : null;
    const lastModel = loadLastChatModel();
    if (!listed && current && uiState.chatModels.length === 0) return;
    // Sellers appear over the first seconds, so a default picked early may be
    // paid only because no free seller had been found yet. Nobody chose it, so
    // it moves to a free one as soon as there is one.
    // A list that dropped the chosen model (Private lists fewer) moved us off it;
    // once it is listed again, go back to what the user chose.
    // Private moved it for a reason; going back waits until Private ends.
    if (modelMovedForPrivate && current === modelMovedForPrivate.to && listed) return;
    if (lastModel && current !== lastModel && findChatModel(uiState.chatModels, lastModel)?.type === 'text') {
      uiState.chatSelectedModelId = lastModel;
      void refreshPermissionModeForModel(lastModel);
      return;
    }
    const keep = listed?.type === 'text' && (lastModel !== null || listed.free || splitPinnedModel(current).peerId);
    if (keep) return;
    const next = chooseDefaultChatModel(uiState.chatModels, lastModel);
    if (next && next !== current) {
      uiState.chatSelectedModelId = next;
      void refreshPermissionModeForModel(next);
    }
  }

  async function refreshChatModels(options: { force?: boolean } = {}): Promise<void> {
    if (!bridge?.chatListModels) return;
    if (modelRefreshInFlight) {
      // A forced read wants the list as it is now, not one that began earlier.
      if (!options.force) return modelRefreshInFlight;
      await modelRefreshInFlight;
    }
    if (modelRetryTimer) {
      clearTimeout(modelRetryTimer);
      modelRetryTimer = null;
    }
    uiState.chatModelsLoading = true;
    notifyUiStateChanged();
    modelRefreshInFlight = (async () => {
      try {
        const result = await bridge.chatListModels!(options.force ? { force: true } : undefined);
        if (result.ok) {
          modelRetryCount = 0;
          uiState.chatModels = Array.isArray(result.data) ? result.data : [];
          uiState.chatModelsError = null;
          applyDefaultModel();
          if (uiState.chatImageModelId && !findChatModel(uiState.chatModels, uiState.chatImageModelId)) {
            uiState.chatImageModelId = null;
          }
          if (!firstModelShownRecorded && uiState.chatSelectedModelId) {
            firstModelShownRecorded = true;
            recordFirstModelShown({ service: uiState.chatSelectedModelId });
          }
        } else {
          uiState.chatModelsError = result.error || 'The gateway did not return a model list.';
          scheduleModelRetry();
        }
      } catch (error) {
        uiState.chatModelsError = toErrorMessage(error, 'The gateway did not return a model list.');
        scheduleModelRetry();
      } finally {
        uiState.chatModelsLoading = false;
        modelRefreshInFlight = null;
        notifyUiStateChanged();
      }
    })();
    return modelRefreshInFlight;
  }

  /** Not saved as the last model: nobody chose it, and it shouldn't outlive Private. */
  function moveModelForPrivate(next: string): void {
    const current = uiState.chatSelectedModelId;
    modelMovedForPrivate = { from: modelMovedForPrivate?.from ?? current, to: next };
    if (activeConversation) startNewChat();
    uiState.chatImageModelId = null;
    uiState.chatSelectedModelId = next;
    clearChatNotices();
    void refreshPermissionModeForModel(next);
    notifyUiStateChanged();
  }

  /** On the toggle, before the gateway has switched, so the model changes at once when it plainly must. */
  function privacyModeChosen(mode: 'anonymous' | 'private'): void {
    if (mode === 'private') {
      const next = chooseModelForPrivate(uiState.chatModels.filter((model) => model.tee), uiState.chatSelectedModelId, selectHasFunds(uiState));
      if (next) moveModelForPrivate(next);
      return;
    }
    const previous = modelMovedForPrivate;
    modelMovedForPrivate = null;
    if (!previous || uiState.chatSelectedModelId !== previous.to) return;
    if (activeConversation) startNewChat();
    uiState.chatSelectedModelId = previous.from;
    void refreshPermissionModeForModel(previous.from);
    notifyUiStateChanged();
  }

  /** Once the gateway has switched: its list now says what each model costs under this mode. */
  async function privacySwitchLanded(mode: 'anonymous' | 'private'): Promise<void> {
    const before = uiState.chatSelectedModelId;
    await refreshChatModels({ force: true });
    if (mode !== 'private' || activeConversation) return;
    // Judged from `before`: the refresh's own default for a model no longer listed prefers free.
    const next = chooseModelForPrivate(uiState.chatModels, before, selectHasFunds(uiState));
    if (next && next !== uiState.chatSelectedModelId) {
      uiState.chatSelectedModelId = before;
      moveModelForPrivate(next);
    }
  }

  function scheduleModelRetry(): void {
    if (modelRetryTimer || modelRetryCount >= MODEL_LIST_MAX_AUTO_RETRIES) return;
    modelRetryCount += 1;
    modelRetryTimer = setTimeout(() => {
      modelRetryTimer = null;
      void refreshChatModels();
    }, MODEL_LIST_RETRY_MS);
  }

  function selectChatModel(modelId: string): void {
    const id = modelId.trim();
    if (!id) return;
    const model = findChatModel(uiState.chatModels, id);
    if (model && model.type !== 'text') {
      // Image models drive the image tool; the conversation keeps its text model.
      uiState.chatImageModelId = model.type === 'image' ? id : null;
      if (model.type !== 'image') showChatError(`${model.label} cannot be used in the chat.`);
      notifyUiStateChanged();
      return;
    }
    uiState.chatImageModelId = null;
    uiState.chatSelectedModelId = id;
    // The user's own pick replaces whatever Private chose.
    modelMovedForPrivate = null;
    clearChatNotices();
    saveLastChatModel(id);
    const convId = activeConversation?.id ?? null;
    if (activeConversation && convId) {
      activeConversation.service = id;
      const summary = getConversationSummaries().find((c) => c.id === convId);
      if (summary) summary.service = id;
    }
    if (bridge?.chatAiSetModel) {
      const update = bridge.chatAiSetModel(convId, id)
        .catch((error: unknown) => ({ ok: false, error: toErrorMessage(error) }));
      if (convId) pendingModelUpdates.set(convId, update);
    }
    void refreshPermissionModeForModel(id);
    notifyUiStateChanged();
  }

  // ---------------------------------------------------------------------------
  // Agent access / tool approval (remembered per model)
  // ---------------------------------------------------------------------------

  const normalizePermissionMode = (value: unknown): ChatPermissionMode => (value === 'full' ? 'full' : 'manual');

  async function refreshPermissionModeForModel(modelId = uiState.chatSelectedModelId): Promise<void> {
    const token = ++permissionRefreshToken;
    const id = modelId.trim();
    uiState.chatPermissionMode = 'manual';
    notifyUiStateChanged();
    if (!id || !bridge?.chatPermissionModeGet) return;
    try {
      const result = await bridge.chatPermissionModeGet(id);
      if (token !== permissionRefreshToken || id !== uiState.chatSelectedModelId) return;
      if (result?.ok && result.mode) {
        uiState.chatPermissionMode = normalizePermissionMode(result.mode);
        notifyUiStateChanged();
      }
    } catch {
      // Keep the current in-memory value.
    }
  }

  function setChatPermissionMode(mode: ChatPermissionMode): void {
    const nextMode = normalizePermissionMode(mode);
    uiState.chatPermissionMode = nextMode;
    const modelId = uiState.chatSelectedModelId;
    if (modelId) void bridge?.chatPermissionModeSet?.(modelId, nextMode).catch(() => undefined);
    notifyUiStateChanged();
  }

  function setToolApprovalRequests(requests: ToolApprovalRequest[]): void {
    uiState.chatToolApprovalRequests = requests;
    uiState.chatToolApprovalRequest = requests[0] ?? null;
  }

  function decideToolApproval(decision: ToolApprovalDecision, requestId?: string): void {
    const request = requestId
      ? uiState.chatToolApprovalRequests.find((entry) => entry.id === requestId) ?? null
      : uiState.chatToolApprovalRequest;
    if (!request) return;
    setToolApprovalRequests(uiState.chatToolApprovalRequests.filter((entry) => entry.id !== request.id));
    notifyUiStateChanged();
    void bridge?.chatToolApprovalDecision?.(request.id, decision);
  }

  // ---------------------------------------------------------------------------
  // Sending state + streaming indicator
  // ---------------------------------------------------------------------------

  function isConversationSending(convId: string | null | undefined): boolean {
    return Boolean(convId && sendingConversationIds.has(convId));
  }

  function syncActiveConversationSendingState(): void {
    const activeConvId = uiState.chatActiveConversation;
    const sending = isConversationSending(activeConvId);
    uiState.chatSendingConversationIds = sendingConversationIds.size === 0 ? [] : Array.from(sendingConversationIds);
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = sending ? activeConvId : null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    uiState.chatThinkingPhase = null;
    clearThinkingPhaseExpiry();
    notifyUiStateChanged();
  }

  function setConversationSending(convId: string, sending: boolean): void {
    if (sending) {
      sendingConversationIds.add(convId);
      if (!streamStartedAtByConversation.has(convId)) {
        streamStartedAtByConversation.set(convId, Date.now());
      }
    } else {
      sendingConversationIds.delete(convId);
      streamStartedAtByConversation.delete(convId);
    }
    syncActiveConversationSendingState();
    notifyUiStateChangedSync();
  }

  /** Sending flag for the new-chat screen, before a conversation exists. */
  function setDraftSending(sending: boolean): void {
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    if (!sending) {
      uiState.chatThinkingPhase = null;
      clearThinkingPhaseExpiry();
    }
    notifyUiStateChanged();
  }

  // ---------------------------------------------------------------------------
  // Streaming message bookkeeping
  // ---------------------------------------------------------------------------

  function queueScrollChatToBottom(): void {
    requestAnimationFrame(() => {
      const container = document.querySelector<HTMLElement>('[data-chat-scroll]');
      if (!container) return;
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 40) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  function queueAnimationFrame(callback: () => void): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
      return;
    }
    setTimeout(callback, 16);
  }

  function cloneStreamingMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      meta: message.meta ? { ...message.meta } : undefined,
      content: Array.isArray(message.content)
        ? (message.content as ContentBlock[]).map(cloneContentBlock)
        : message.content,
    };
  }

  function setLocalConversationMessages(convId: string, messages: ChatMessage[]): void {
    localConversationMessages.set(convId, messages.map(cloneStreamingMessage));
  }

  function getLocalConversationMessages(convId: string): ChatMessage[] | null {
    const cached = localConversationMessages.get(convId);
    return cached ? cached.map(cloneStreamingMessage) : null;
  }

  function setStreamingMessage(message: ChatMessage | null): void {
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
    notifyUiStateChangedSync();
    if (message) queueScrollChatToBottom();
  }

  function flushStreamingMessage(): void {
    const activeConvId = uiState.chatActiveConversation;
    const message = activeConvId ? streamingMessagesByConversation.get(activeConvId) ?? null : null;
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
    notifyUiStateChanged();
    if (uiState.chatStreamingMessage) queueScrollChatToBottom();
  }

  function scheduleStreamingMessageFlush(convId: string): void {
    if (uiState.chatActiveConversation !== convId) return;
    if (pendingStreamingUiFlushes.has(convId)) return;
    pendingStreamingUiFlushes.add(convId);
    queueAnimationFrame(() => {
      pendingStreamingUiFlushes.delete(convId);
      if (uiState.chatActiveConversation === convId) flushStreamingMessage();
    });
  }

  function getConversationStreamingMessage(convId: string): ChatMessage | null {
    const message = streamingMessagesByConversation.get(convId);
    return message ? cloneStreamingMessage(message) : null;
  }

  function hasConversationStreamingMessage(convId: string): boolean {
    return streamingMessagesByConversation.has(convId);
  }

  function setConversationStreamingMessage(convId: string, message: ChatMessage | null): void {
    if (message) streamingMessagesByConversation.set(convId, cloneStreamingMessage(message));
    else streamingMessagesByConversation.delete(convId);
    pendingStreamingUiFlushes.delete(convId);
    if (uiState.chatActiveConversation === convId) setStreamingMessage(message);
  }

  function updateStreamingMessage(convId: string, mutator: (message: ChatMessage) => void): void {
    const current = streamingMessagesByConversation.get(convId);
    if (!current) return;
    mutator(current);
    scheduleStreamingMessageFlush(convId);
  }

  // Move any leading <think>...[</think>] segment out of a text block and into
  // an adjacent thinking block, for models (DeepSeek, Qwen) that emit their
  // reasoning as inline XML. Handles both the streaming case (no closing tag
  // yet) and the committed case.
  function syncInlineThink(blocks: ContentBlock[], textBlock: ContentBlock): void {
    const CLOSE_TAG = '</think>';
    const OPEN_TAG = '<think>';
    const openThink = findOpenInlineThink(blocks, textBlock);
    if (openThink) {
      const pending = String(textBlock.text || '');
      if (pending.length === 0) return;
      const combined = `${String(openThink.thinking || '')}${pending}`;
      textBlock.text = '';
      const closeIdx = combined.indexOf(CLOSE_TAG);
      if (closeIdx === -1) {
        openThink.thinking = combined;
      } else {
        openThink.thinking = combined.slice(0, closeIdx).trim();
        openThink.streaming = false;
        textBlock.text = combined.slice(closeIdx + CLOSE_TAG.length).replace(/^\s*/, '');
      }
      return;
    }
    const raw = String(textBlock.text || '');
    if (!raw.startsWith(OPEN_TAG)) return;
    const body = raw.slice(OPEN_TAG.length);
    const closeIdx = body.indexOf(CLOSE_TAG);
    const textIdx = blocks.indexOf(textBlock);
    const thinkingBlock: ContentBlock = {
      type: 'thinking',
      thinking: '',
      streaming: true,
      details: { inlineThinkFor: textBlock.renderKey },
    };
    blocks.splice(textIdx >= 0 ? textIdx : blocks.length, 0, thinkingBlock);
    if (closeIdx === -1) {
      thinkingBlock.thinking = body;
      textBlock.text = '';
    } else {
      thinkingBlock.thinking = body.slice(0, closeIdx).trim();
      thinkingBlock.streaming = false;
      textBlock.text = body.slice(closeIdx + CLOSE_TAG.length).replace(/^\s*/, '');
    }
  }

  function findOpenInlineThink(blocks: ContentBlock[], textBlock: ContentBlock): ContentBlock | undefined {
    const textIdx = blocks.indexOf(textBlock);
    const prev = textIdx > 0 ? blocks[textIdx - 1] : undefined;
    if (
      prev
      && prev.type === 'thinking'
      && prev.streaming
      && prev.details
      && (prev.details as Record<string, unknown>).inlineThinkFor === textBlock.renderKey
    ) {
      return prev;
    }
    return undefined;
  }

  function extractInlineThinkBlocks(blocks: ContentBlock[]): void {
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block?.type === 'text') syncInlineThink(blocks, block);
    }
    for (const block of blocks) {
      if (block?.type === 'thinking' && block.details && (block.details as Record<string, unknown>).inlineThinkFor !== undefined) {
        block.streaming = false;
      }
    }
  }

  function normalizeInlineThinkInMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
      const content = (message.content as ContentBlock[]).map((b) => ({ ...b }));
      extractInlineThinkBlocks(content);
      return { ...message, content };
    });
  }

  function materializeStreamingMessage(message: ChatMessage | null): ChatMessage | null {
    if (!message) return null;
    const cloned = cloneStreamingMessage(message);
    // Strip synthetic renderKeys/IDs so merged turns fall back to positional
    // keys, and drop streaming-only inline-think bookkeeping.
    if (Array.isArray(cloned.content)) {
      for (const block of cloned.content as ContentBlock[]) {
        delete block.renderKey;
        // A stopped or cut-off reply never got its block-stop; it's over either way.
        delete block.streaming;
        if (typeof block.id === 'string' && /^(text|thinking)-[\d-]+$/.test(block.id)) delete block.id;
        if (block.details && typeof block.details === 'object') {
          const details = block.details as Record<string, unknown>;
          delete details.inlineThinkFor;
          if (Object.keys(details).length === 0) delete block.details;
        }
      }
    }
    return cloned;
  }

  function commitAssistantMessage(message: ChatMessage): void {
    if (Array.isArray(message?.content)) extractInlineThinkBlocks(message.content as ContentBlock[]);
    const assistantMessage = { ...message, createdAt: message?.createdAt || Date.now() };
    uiState.chatMessages = [...uiState.chatMessages, assistantMessage];
    if (uiState.chatActiveConversation) {
      setLocalConversationMessages(uiState.chatActiveConversation, uiState.chatMessages as ChatMessage[]);
    }
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Number(assistantMessage.createdAt) || Date.now();
    }
  }

  function appendAssistantMessageToConversation(convId: string, message: ChatMessage): void {
    if (Array.isArray(message?.content)) extractInlineThinkBlocks(message.content as ContentBlock[]);
    const assistantMessage = { ...message, createdAt: message?.createdAt || Date.now() };
    setLocalConversationMessages(convId, [...(getLocalConversationMessages(convId) ?? []), assistantMessage]);
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async function refreshChatConversations(): Promise<void> {
    if (!bridge?.chatAiListConversations) return;
    try {
      const result = await bridge.chatAiListConversations();
      if (result.ok) {
        const conversations = Array.isArray(result.data) ? (result.data as ChatConversationSummary[]) : [];
        uiState.chatConversations = conversations;
        const activeId = uiState.chatActiveConversation;
        const activeSummary = activeId ? conversations.find((c) => c.id === activeId) : undefined;
        if (activeSummary) {
          activeConversation = { ...(activeConversation || {}), ...activeSummary, messages: activeConversation?.messages || [] };
        }
        notifyUiStateChanged();
      }
    } catch {
      // Chat unavailable
    } finally {
      uiState.chatConversationsLoaded = true;
      notifyUiStateChanged();
    }
  }

  let chatConversationsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesce bursts of stream events into one conversation-list refresh. */
  function scheduleChatConversationsRefresh(): void {
    if (chatConversationsRefreshTimer !== null) return;
    chatConversationsRefreshTimer = setTimeout(() => {
      chatConversationsRefreshTimer = null;
      void refreshChatConversations();
    }, 500);
  }

  async function refreshWorkspace(): Promise<void> {
    if (!bridge?.chatAiGetWorkspace) return;
    try {
      const result = await bridge.chatAiGetWorkspace();
      if (result.ok && result.data) {
        uiState.chatWorkspacePath = result.data.current;
        uiState.chatWorkspaceDefaultPath = result.data.default;
        desiredWorkspacePath = result.data.current;
        notifyUiStateChanged();
      }
    } catch {
      // Workspace selection unavailable
    }
  }

  async function restoreWorkspace(workspacePath: string): Promise<void> {
    if (!bridge?.chatAiSetWorkspace) return;
    const token = ++workspaceSwitchToken;
    desiredWorkspacePath = workspacePath;
    try {
      const result = await bridge.chatAiSetWorkspace(workspacePath);
      if (token !== workspaceSwitchToken) {
        // A newer selection won the race; re-apply it so main and the UI agree.
        const latestWorkspacePath = desiredWorkspacePath;
        if (latestWorkspacePath && latestWorkspacePath !== workspacePath) void restoreWorkspace(latestWorkspacePath);
        return;
      }
      if (result.ok && result.data) {
        uiState.chatWorkspacePath = result.data.current;
        uiState.chatWorkspaceDefaultPath = result.data.default;
        desiredWorkspacePath = result.data.current;
        notifyUiStateChanged();
      } else {
        desiredWorkspacePath = uiState.chatWorkspacePath || null;
      }
    } catch {
      if (token === workspaceSwitchToken) desiredWorkspacePath = uiState.chatWorkspacePath || null;
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (!bridge?.pickDirectory || !bridge.chatAiSetWorkspace) return;
    try {
      const picked = await bridge.pickDirectory();
      if (!picked.ok || !picked.path) return;
      const token = ++workspaceSwitchToken;
      desiredWorkspacePath = picked.path;
      const result = await bridge.chatAiSetWorkspace(picked.path);
      if (!result.ok || !result.data) {
        if (token === workspaceSwitchToken) desiredWorkspacePath = uiState.chatWorkspacePath || null;
        showChatError(result.error || 'Failed to set workspace');
        return;
      }
      if (token !== workspaceSwitchToken) return;
      uiState.chatWorkspacePath = result.data.current;
      uiState.chatWorkspaceDefaultPath = result.data.default;
      desiredWorkspacePath = result.data.current;
      uiState.chatError = null;
      startNewChat();
      await refreshChatConversations();
      notifyUiStateChanged();
    } catch (err) {
      reportChatError(err, 'Failed to set workspace');
    }
  }

  async function openConversation(convId: string, options: { keepImageModel?: boolean } = {}): Promise<void> {
    if (!bridge?.chatAiGetConversation) return;
    const workspacePathAtOpen = uiState.chatWorkspacePath;
    uiState.chatActiveConversation = convId;
    uiState.chatOpeningConversationId = convId;
    clearChatNotices();
    notifyUiStateChanged();

    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (!result.ok || !result.data) {
        uiState.chatOpeningConversationId = null;
        reportChatError(result.error, 'Failed to open conversation');
        return;
      }
      const conv = result.data as ChatConversation;
      const serverMessages = normalizeInlineThinkInMessages(Array.isArray(conv.messages) ? conv.messages : []);
      const preferLocal = hasConversationStreamingMessage(convId) || isConversationSending(convId);
      const nextMessages = preferLocal ? (getLocalConversationMessages(convId) ?? serverMessages) : serverMessages;
      activeConversation = { ...conv, messages: nextMessages };
      uiState.chatMessages = nextMessages;
      uiState.chatStreamingMessage = getConversationStreamingMessage(convId);
      syncActiveConversationSendingState();

      const modelId = typeof conv.service === 'string' ? conv.service.trim() : '';
      if (modelId) uiState.chatSelectedModelId = modelId;
      if (!options.keepImageModel) uiState.chatImageModelId = null;
      setLocalConversationMessages(convId, nextMessages);
      uiState.chatOpeningConversationId = null;
      void refreshPermissionModeForModel(uiState.chatSelectedModelId);
      notifyUiStateChanged();

      const convWorkspacePath = conv.workspacePath;
      if (typeof convWorkspacePath === 'string' && convWorkspacePath.length > 0 && convWorkspacePath !== workspacePathAtOpen) {
        void restoreWorkspace(convWorkspacePath);
      }
    } catch (err) {
      uiState.chatOpeningConversationId = null;
      reportChatError(err, 'Failed to open conversation');
    }
  }

  /** Home shows one model while a chat is open; the new chat must use what's on screen. */
  function startNewChatOnModel(modelId: string): void {
    startNewChat();
    if (!modelId || uiState.chatSelectedModelId === modelId) return;
    uiState.chatSelectedModelId = modelId;
    void refreshPermissionModeForModel(modelId);
    notifyUiStateChanged();
  }

  function startNewChat(): void {
    newChatDraftVersion += 1;
    uiState.chatActiveConversation = null;
    uiState.chatOpeningConversationId = null;
    uiState.chatMessages = [];
    setStreamingMessage(null);
    activeConversation = null;
    clearChatNotices();
    // Re-derive sending flags from the (now null) active conversation so the
    // thinking indicator doesn't leak in from a chat still streaming elsewhere.
    syncActiveConversationSendingState();
    const lastModel = loadLastChatModel();
    if (lastModel && (uiState.chatModels.length === 0 || findChatModel(uiState.chatModels, lastModel)?.type === 'text')) {
      uiState.chatSelectedModelId = lastModel;
    }
    // A model Private chose stays for new chats while Private is on.
    if (modelMovedForPrivate && findChatModel(uiState.chatModels, modelMovedForPrivate.to)) {
      uiState.chatSelectedModelId = modelMovedForPrivate.to;
    }
    applyDefaultModel();
    void refreshPermissionModeForModel(uiState.chatSelectedModelId);
    notifyUiStateChanged();
  }

  async function createConversationForModel(
    modelId: string,
    options: { activate: boolean; keepImageModel?: boolean } = { activate: true },
  ): Promise<string | null> {
    if (!bridge?.chatAiCreateConversation) return null;
    if (!modelId) {
      showChatError(uiState.chatModelsError
        ? `No model is available: ${uiState.chatModelsError}`
        : 'Choose a model before starting a chat.');
      return null;
    }
    try {
      const result = await bridge.chatAiCreateConversation(modelId);
      if (result.ok && result.data) {
        const conversationId = getConversationId(result.data);
        if (!conversationId) throw new Error('Conversation created but ID is missing');
        await refreshChatConversations();
        if (options.activate) await openConversation(conversationId, { keepImageModel: options.keepImageModel ?? false });
        uiState.chatError = null;
        notifyUiStateChanged();
        return conversationId;
      }
      reportChatError(result.error, 'Failed to create conversation');
    } catch (err) {
      reportChatError(err, 'Failed to create conversation');
    }
    return null;
  }

  async function deleteConversation(targetId?: string): Promise<void> {
    const convId = targetId || uiState.chatActiveConversation;
    if (!convId || !bridge?.chatAiDeleteConversation) return;
    const previousConversations = [...getConversationSummaries()];
    uiState.chatConversations = previousConversations.filter((conv) => conv.id !== convId);
    localConversationMessages.delete(convId);
    streamingMessagesByConversation.delete(convId);
    sendingConversationIds.delete(convId);
    streamStartedAtByConversation.delete(convId);
    fundsBlockedConversationIds.delete(convId);
    syncActiveConversationSendingState();
    if (convId === uiState.chatActiveConversation) startNewChat();
    else notifyUiStateChanged();

    try {
      await bridge.chatAiDeleteConversation(convId);
      await refreshChatConversations();
    } catch (err) {
      uiState.chatConversations = previousConversations;
      notifyUiStateChanged();
      void refreshChatConversations();
      reportChatError(err, 'Failed to delete conversation');
    }
  }

  function renameConversation(convId: string, newTitle: string): void {
    const conversations = getConversationSummaries();
    const conv = conversations.find((c) => c.id === convId);
    if (conv) {
      conv.title = newTitle;
      uiState.chatConversations = [...conversations];
    }
    notifyUiStateChanged();
    void bridge?.chatAiRenameConversation?.(convId, newTitle).catch((err: unknown) => {
      appendSystemLog(`Failed to persist conversation rename: ${String(err)}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  function buildUserMessageContent(text: string, attachments: PreparedChatAttachment[]): unknown {
    const blocks: ContentBlock[] = [];
    if (text.length > 0) blocks.push({ type: 'text', text });
    for (const attachment of attachments) {
      blocks.push({
        type: 'file',
        fileName: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        status: attachment.status,
        error: attachment.error,
        truncated: attachment.truncated,
        ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
        attachment,
      });
      if (attachment.kind === 'image' && attachment.image?.data && attachment.image.mimeType) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.image.mimeType, data: attachment.image.data } });
      }
    }
    return blocks.length > 0 ? blocks : text;
  }

  async function prepareAttachmentsForSend(conversationId: string, rawAttachments: RawChatAttachment[] | undefined): Promise<PreparedChatAttachment[]> {
    if (!rawAttachments?.length) return [];
    if (!bridge?.chatPrepareAttachments) throw new Error('Attachment preparation is not available in this desktop build.');
    const result = await bridge.chatPrepareAttachments(conversationId, rawAttachments);
    if (!result.ok) throw new Error(result.error || 'Attachment preparation failed');
    return result.data ?? [];
  }

  function sendMessage(text: string, rawAttachments?: RawChatAttachment[]): void {
    if (!bridge) return;
    if (text.trim().length === 0 && !rawAttachments?.length) return;

    if (!uiState.chatActiveConversation) {
      // Capture the draft's model now: the user may switch before the
      // conversation finishes creating.
      const draftVersion = newChatDraftVersion;
      const modelId = uiState.chatSelectedModelId;
      setDraftSending(true);
      void (async () => {
        const convId = await createConversationForModel(modelId, { activate: false });
        setDraftSending(false);
        if (!convId) return;
        if (draftVersion === newChatDraftVersion) await openConversation(convId);
        sendMessageToConversation(convId, text, rawAttachments);
      })();
      return;
    }
    sendMessageToConversation(uiState.chatActiveConversation, text, rawAttachments);
  }

  function sendMessageToConversation(convId: string, text: string, rawAttachments?: RawChatAttachment[]): void {
    if (isConversationSending(convId)) {
      showChatError('This conversation already has a request in progress.');
      return;
    }
    const content = text.trim();
    clearChatNotices();
    fundsBlockedConversationIds.delete(convId);
    setConversationSending(convId, true);
    void (async () => {
      let preparedAttachments: PreparedChatAttachment[];
      try {
        preparedAttachments = await prepareAttachmentsForSend(convId, rawAttachments);
      } catch (err) {
        reportChatError(err, 'Attachment preparation failed');
        setConversationSending(convId, false);
        return;
      }

      const readyAttachmentCount = preparedAttachments.filter((attachment) => attachment.status === 'ready').length;
      if (content.length === 0 && readyAttachmentCount === 0) {
        const firstError = preparedAttachments.find((attachment) => attachment.status === 'error')?.error;
        showChatError(firstError || 'No supported attachment content to send.');
        setConversationSending(convId, false);
        return;
      }

      const modelId = findConversationSummary(convId)?.service || uiState.chatSelectedModelId;
      const hasReadyImage = preparedAttachments.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready');
      const model = findChatModel(uiState.chatModels, modelId);
      if (hasReadyImage && model && !model.supportsImages) {
        showChatError(`${model.label} doesn't accept images. Sending without image input for this turn.`);
      }

      const localMessages = getLocalConversationMessages(convId)
        ?? (convId === uiState.chatActiveConversation ? (uiState.chatMessages as ChatMessage[]) : []);
      const nextMessages = [...localMessages, { role: 'user' as const, content: buildUserMessageContent(content, preparedAttachments), createdAt: Date.now() }];
      setLocalConversationMessages(convId, nextMessages);
      if (convId === uiState.chatActiveConversation) uiState.chatMessages = nextMessages;
      if (activeConversation?.id === convId) {
        activeConversation.messages = nextMessages;
        activeConversation.updatedAt = Date.now();
      }
      notifyUiStateChanged();
      void dispatchChatRequest(convId, content, preparedAttachments);
    })();
  }

  function handleSendFailure(convId: string, result: { error?: string; stopReason?: { kind: string; message: string; errorCode?: string } }): void {
    const funds = fundsNoticeFromStopReason(result.stopReason);
    if (funds) {
      showFundsNotice(convId, funds);
      return;
    }
    if (result.error === 'Request aborted' || result.error === 'Aborted' || result.stopReason?.kind === 'aborted') return;
    if (convId === uiState.chatActiveConversation) {
      reportChatError(result.stopReason?.message || result.error, 'Request failed');
    } else {
      appendSystemLog(`Chat error: ${result.stopReason?.message || result.error || 'Request failed'}`);
    }
  }

  async function dispatchChatRequest(convId: string, content: string, attachments?: PreparedChatAttachment[]): Promise<void> {
    if (!bridge?.chatAiSendStream) {
      setConversationSending(convId, false);
      return;
    }
    const modelUpdate = pendingModelUpdates.get(convId);
    if (modelUpdate) {
      const update = await modelUpdate;
      if (pendingModelUpdates.get(convId) === modelUpdate) pendingModelUpdates.delete(convId);
      if (!update.ok) appendSystemLog(`Could not save the chat's model: ${update.error ?? 'unknown error'}`);
    }
    const modelId = findConversationSummary(convId)?.service || uiState.chatSelectedModelId;
    if (!modelId) {
      reportChatError('Choose a model for this chat.', 'Request failed');
      setConversationSending(convId, false);
      return;
    }

    const requestStartedAt = Date.now();
    streamCompletedAtByConversation.delete(convId);
    streamFailedAtByConversation.delete(convId);
    // A newer text message supersedes an image request waiting on funds.
    imageRetryByConversation.delete(convId);
    const send = () => bridge.chatAiSendStream!(convId, content || ' ', modelId, attachments, uiState.chatPermissionMode);
    try {
      let result = await send();
      if (!result.ok && String(result.error ?? '').toLowerCase().includes('already in progress') && bridge.chatAiAbort) {
        appendSystemLog('Detected stuck in-flight chat request. Aborting and retrying once...');
        await bridge.chatAiAbort(convId).catch(() => undefined);
        result = await send();
      }
      // The stream-error event already reported failures that reached the stream.
      const streamEnded = (streamCompletedAtByConversation.get(convId) ?? 0) >= requestStartedAt
        || (streamFailedAtByConversation.get(convId) ?? 0) >= requestStartedAt;
      if (!result.ok && !streamEnded) handleSendFailure(convId, result);
    } catch (err) {
      reportChatError(err, 'Request failed');
    } finally {
      if (isConversationSending(convId) && !hasConversationStreamingMessage(convId)) {
        setConversationSending(convId, false);
      }
    }
  }

  function lastUserMessage(convId: string): { content: string; attachments: PreparedChatAttachment[] } | null {
    const messages = getLocalConversationMessages(convId)
      ?? (convId === uiState.chatActiveConversation ? (uiState.chatMessages as ChatMessage[]) : []);
    const last = [...messages].reverse().find((message) => message.role === 'user');
    if (!last) return null;
    const content = typeof last.content === 'string'
      ? last.content
      : Array.isArray(last.content)
        ? (last.content as ContentBlock[]).filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).filter(Boolean).join('\n\n')
        : '';
    const attachments: PreparedChatAttachment[] = [];
    if (Array.isArray(last.content)) {
      for (const block of last.content as ContentBlock[]) {
        if (block.type === 'file' && block.attachment && typeof block.attachment === 'object') {
          attachments.push(block.attachment as PreparedChatAttachment);
        }
      }
    }
    return { content, attachments };
  }

  function retryAfterPayment(): void {
    const convId = uiState.chatActiveConversation;
    if (!convId || !fundsBlockedConversationIds.has(convId) || isConversationSending(convId)) return;
    const imageRequest = imageRetryByConversation.get(convId);
    if (imageRequest) {
      imageRetryByConversation.delete(convId);
      fundsBlockedConversationIds.delete(convId);
      clearChatNotices();
      void runImageRequest(convId, imageRequest);
      return;
    }
    const last = lastUserMessage(convId);
    if (!last) return;
    fundsBlockedConversationIds.delete(convId);
    clearChatNotices();
    setConversationSending(convId, true);
    void dispatchChatRequest(convId, last.content, last.attachments.length > 0 ? last.attachments : undefined);
  }

  function dismissFundsNotice(): void {
    uiState.chatFundsNotice = null;
    notifyUiStateChanged();
  }

  async function abortChat(): Promise<void> {
    const convId = uiState.chatActiveConversation;
    if (convId) setConversationSending(convId, false);
    else setDraftSending(false);
    if (bridge?.chatAiAbort) await bridge.chatAiAbort(convId ?? undefined);
  }

  // ---------------------------------------------------------------------------
  // Image generation (gateway /v1/images, the selected image model)
  // ---------------------------------------------------------------------------

  /** An image request stopped for lack of funds; Try again replays it, not the text model. */
  const imageRetryByConversation = new Map<string, ImageRequest>();

  /** The prompt is already in the conversation, from the first attempt. */
  async function runImageRequest(convId: string, request: ImageRequest): Promise<void> {
    if (!bridge?.chatGenerateImage) return;
    setConversationSending(convId, true);
    uiState.chatThinkingPhase = request.sourceImageAttachmentId ? 'Editing image' : 'Generating image';
    notifyUiStateChanged();
    queueScrollChatToBottom();
    try {
      const result = await bridge.chatGenerateImage({ conversationId: convId, ...request });
      if (!result.ok || !result.user || !result.assistant) {
        throw new Error(result.error || 'Image generation failed.');
      }
      // The prompt was projected optimistically; append only the reply.
      const current = getLocalConversationMessages(convId) ?? (convId === uiState.chatActiveConversation ? uiState.chatMessages as ChatMessage[] : []);
      const messages = [...current, result.assistant as ChatMessage];
      setLocalConversationMessages(convId, messages);
      if (convId === uiState.chatActiveConversation) uiState.chatMessages = messages;
      if (activeConversation?.id === convId) {
        activeConversation.messages = messages;
        activeConversation.updatedAt = Date.now();
      }
      scheduleChatConversationsRefresh();
      notifyUiStateChanged();
      queueScrollChatToBottom();
    } catch (error) {
      const message = toErrorMessage(error, 'Image generation failed');
      if (message.startsWith('payment_required:')) {
        imageRetryByConversation.set(convId, request);
        showFundsNotice(convId, { message: message.slice('payment_required:'.length).trim(), canAddFunds: true });
      } else if (message !== 'Request aborted') {
        reportChatError(message, 'Image generation failed');
      }
    } finally {
      setConversationSending(convId, false);
    }
  }

  function generateImage(prompt: string): void {
    const content = prompt.trim();
    if (!content || !bridge?.chatGenerateImage) return;
    const imageModelId = uiState.chatImageModelId;
    if (!imageModelId) {
      showChatError('Choose an image model first.');
      return;
    }
    const imageModel = findChatModel(uiState.chatModels, imageModelId);

    void (async () => {
      let convId = uiState.chatActiveConversation;
      if (!convId) {
        const textModelId = uiState.chatSelectedModelId;
        if (!textModelId) {
          showChatError('Choose a text model before starting an image conversation.');
          return;
        }
        // Follow-ups in this chat are image requests too.
        convId = await createConversationForModel(textModelId, { activate: true, keepImageModel: true });
      }
      if (!convId) return;
      if (isConversationSending(convId)) {
        showChatError('This conversation already has a request in progress.');
        return;
      }

      clearChatNotices();
      const existingBeforeRequest = getLocalConversationMessages(convId)
        ?? (convId === uiState.chatActiveConversation ? uiState.chatMessages as ChatMessage[] : []);
      // Edit the last generated image when the model takes image input;
      // otherwise regenerate from the accumulated prompts.
      let sourceImageAttachmentId = '';
      for (let messageIndex = existingBeforeRequest.length - 1; messageIndex >= 0 && !sourceImageAttachmentId; messageIndex -= 1) {
        const message = existingBeforeRequest[messageIndex];
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
        for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
          const block = message.content[blockIndex];
          if (block?.type === 'file' && block.generated === true && typeof block.attachmentId === 'string') {
            sourceImageAttachmentId = block.attachmentId.trim();
            break;
          }
        }
      }
      const editing = Boolean(sourceImageAttachmentId) && imageModel?.supportsImages === true;
      const priorImagePrompts = existingBeforeRequest.flatMap((message, messageIndex) => {
        const nextMessage = existingBeforeRequest[messageIndex + 1];
        const generatedImageFollows = nextMessage?.role === 'assistant'
          && Array.isArray(nextMessage.content)
          && nextMessage.content.some((block) => block?.type === 'file' && block.generated === true);
        return message.role === 'user' && generatedImageFollows && typeof message.content === 'string' && message.content.trim()
          ? [message.content.trim()]
          : [];
      });
      const requestPrompt = sourceImageAttachmentId && !editing && priorImagePrompts.length > 0
        ? buildCumulativeImagePrompt(priorImagePrompts, content)
        : content;
      const optimisticUserMessage: ChatMessage = { role: 'user', content: requestPrompt, createdAt: Date.now() };
      const pendingMessages = [...existingBeforeRequest, optimisticUserMessage];
      setLocalConversationMessages(convId, pendingMessages);
      if (convId === uiState.chatActiveConversation) uiState.chatMessages = pendingMessages;
      if (activeConversation?.id === convId) {
        activeConversation.messages = pendingMessages;
        activeConversation.updatedAt = optimisticUserMessage.createdAt;
      }

      await runImageRequest(convId, {
        prompt: requestPrompt,
        model: imageModelId,
        ...(editing ? { sourceImageAttachmentId } : {}),
      });
    })();
  }

  // ---------------------------------------------------------------------------
  // Bridge callbacks
  // ---------------------------------------------------------------------------

  if (bridge) {
    void refreshWorkspace();

    bridge.onGatewayChanged?.(() => {
      modelRetryCount = 0;
      void refreshChatModels({ force: true });
    });

    bridge.onChatAiDone?.((data) => {
      const incomingMessage = data.message as ChatMessage;
      if (hasConversationStreamingMessage(data.conversationId)) {
        updateStreamingMessage(data.conversationId, (message) => {
          message.meta = { ...(message.meta ?? {}), ...(incomingMessage.meta ?? {}) };
          if (!message.createdAt && incomingMessage.createdAt) message.createdAt = incomingMessage.createdAt;
        });
      } else if (data.conversationId === uiState.chatActiveConversation) {
        commitAssistantMessage(incomingMessage);
        uiState.chatError = null;
        setConversationSending(data.conversationId, false);
        notifyUiStateChanged();
      }
      scheduleChatConversationsRefresh();
    });

    bridge.onChatAiUserPersisted?.((data) => {
      if (data.conversationId !== uiState.chatActiveConversation) return;
      const last = (uiState.chatMessages[uiState.chatMessages.length - 1] || null) as ChatMessage | null;
      if (last && last.role === 'user' && !last.createdAt) {
        last.createdAt = data.message?.createdAt || Date.now();
        setLocalConversationMessages(data.conversationId, uiState.chatMessages as ChatMessage[]);
        notifyUiStateChanged();
      }
    });

    bridge.onChatConversationTitleUpdated?.((data) => {
      const title = String(data.title || '').trim();
      if (!title) return;
      const conversations = getConversationSummaries();
      const conv = conversations.find((c) => c.id === data.conversationId);
      if (conv) {
        conv.title = title;
        uiState.chatConversations = [...conversations];
      }
      notifyUiStateChanged();
      scheduleChatConversationsRefresh();
    });

    const getStreamingBlocks = (message: ChatMessage): ContentBlock[] => (
      Array.isArray(message.content) ? (message.content as ContentBlock[]) : []
    );
    const getStreamingBlockId = (blockType: string, index: number | string): string => `${blockType}-${String(index)}`;
    const createStreamingRenderKey = (blockType: string, index: number | string): string => `stream-${blockType}-${String(index)}`;

    function findLastStreamingThinkingBlock(blocks: ContentBlock[], index: number | string): ContentBlock | undefined {
      const contentIndex = String(index);
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.type === 'thinking' && String(block.details?.streamContentIndex ?? '') === contentIndex && block.streaming) return block;
      }
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.type === 'thinking' && String(block.details?.streamContentIndex ?? '') === contentIndex) return block;
      }
      return undefined;
    }

    function findLastStreamingBlockByType(blocks: ContentBlock[], type: string): ContentBlock | undefined {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i]?.type === type) return blocks[i];
      }
      return undefined;
    }

    /** The tool block for an id, adopting a placeholder block ("tool-0") created before the real id was known. */
    function findToolBlock(blocks: ContentBlock[], toolUseId: string, name?: string, index?: number): ContentBlock | undefined {
      let toolBlock = blocks.find((block) => block.type === 'tool_use' && block.id === toolUseId);
      if (!toolBlock && toolUseId) {
        const fallbackId = index !== undefined ? getStreamingBlockId('tool', index) : null;
        toolBlock = blocks.find((block) => (
          block.type === 'tool_use'
          && typeof block.id === 'string'
          && (fallbackId ? block.id === fallbackId : /^tool-\d+$/.test(block.id) && (!name || block.name === name || block.name === 'tool'))
        ));
        if (toolBlock) {
          toolBlock.id = toolUseId;
          toolBlock.renderKey = createStreamingRenderKey('tool', toolUseId);
        }
      }
      return toolBlock;
    }

    // What a reply came from, known before it finishes, so one that gets stopped or cut off still says.
    bridge.onChatAiReplyMeta?.((data) => {
      const streaming = getConversationStreamingMessage(data.conversationId);
      if (!streaming) return;
      setConversationStreamingMessage(data.conversationId, { ...streaming, meta: { ...(streaming.meta ?? {}), ...data.meta } });
    });

    bridge.onChatAiStreamStart?.((data) => {
      if (data.conversationId === uiState.chatActiveConversation) {
        clearChatNotices();
        notifyUiStateChanged();
      }
      if (isConversationSending(data.conversationId)) {
        streamStartedAtByConversation.set(data.conversationId, Date.now());
        notifyUiStateChanged();
      }
      if (!hasConversationStreamingMessage(data.conversationId)) {
        setConversationStreamingMessage(data.conversationId, { role: 'assistant', content: [], createdAt: Date.now(), meta: {} });
      }
    });

    bridge.onChatAiStreamBlockStart?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      if (data.conversationId === uiState.chatActiveConversation && uiState.chatWaitingForStream) {
        uiState.chatWaitingForStream = false;
        uiState.chatThinkingPhase = null;
        clearThinkingPhaseExpiry();
        notifyUiStateChanged();
      }
      if (data.blockType === 'text') {
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = getStreamingBlocks(message);
          blocks.push({ type: 'text', renderKey: createStreamingRenderKey('text', blocks.length), text: '', streaming: true });
          message.content = blocks;
        });
      } else if (data.blockType === 'thinking') {
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = getStreamingBlocks(message);
          const thinkingInstance = blocks.filter((block) => block?.type === 'thinking').length;
          blocks.push({
            type: 'thinking',
            renderKey: createStreamingRenderKey('thinking', `${data.index}-${thinkingInstance}`),
            id: getStreamingBlockId('thinking', `${data.index}-${thinkingInstance}`),
            thinking: '',
            details: { streamContentIndex: String(data.index) },
            streaming: true,
          });
          message.content = blocks;
        });
      } else if (data.blockType === 'tool_use') {
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = getStreamingBlocks(message);
          blocks.push({
            type: 'tool_use',
            renderKey: createStreamingRenderKey('tool', data.toolId || blocks.length),
            id: String(data.toolId || getStreamingBlockId('tool', data.index)),
            name: String(data.toolName || 'tool'),
            status: 'running',
          });
          message.content = blocks;
        });
      }
    });

    bridge.onChatAiStreamDelta?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      if (data.blockType === 'text') {
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          const textBlock = findLastStreamingBlockByType(blocks, 'text');
          if (!textBlock) return;
          textBlock.text = `${String(textBlock.text || '')}${String(data.text ?? '')}`;
          textBlock.streaming = true;
          syncInlineThink(blocks, textBlock);
        });
      } else if (data.blockType === 'thinking') {
        updateStreamingMessage(data.conversationId, (message) => {
          const thinkingBlock = findLastStreamingThinkingBlock(message.content as ContentBlock[], data.index);
          if (thinkingBlock) {
            thinkingBlock.thinking = `${String(thinkingBlock.thinking || '')}${data.text}`;
            thinkingBlock.streaming = true;
          }
        });
      }
    });

    bridge.onChatAiStreamBlockStop?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      if (data.blockType === 'text') {
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          const textBlock = findLastStreamingBlockByType(blocks, 'text');
          if (!textBlock) return;
          textBlock.streaming = false;
          // '<think>' opened but never closed: finalize the inline thinking block.
          const openThink = findOpenInlineThink(blocks, textBlock);
          if (openThink) {
            openThink.thinking = String(openThink.thinking || '').trim();
            openThink.streaming = false;
          }
        });
      } else if (data.blockType === 'thinking') {
        updateStreamingMessage(data.conversationId, (message) => {
          const thinkingBlock = findLastStreamingThinkingBlock(message.content as ContentBlock[], data.index);
          if (thinkingBlock) thinkingBlock.streaming = false;
        });
      } else if (data.blockType === 'tool_use' && data.input) {
        updateStreamingMessage(data.conversationId, (message) => {
          const toolBlock = findToolBlock(message.content as ContentBlock[], String(data.toolId ?? ''), undefined, data.index);
          if (toolBlock) {
            toolBlock.input = data.input;
            if (data.toolName) toolBlock.name = String(data.toolName);
          }
        });
      }
    });

    bridge.onChatAiToolExecuting?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      updateStreamingMessage(data.conversationId, (message) => {
        const toolBlock = findToolBlock(message.content as ContentBlock[], data.toolUseId, data.name);
        if (toolBlock) {
          toolBlock.name = String(data.name || toolBlock.name || 'tool');
          toolBlock.input = data.input;
          toolBlock.status = 'running';
        }
      });
    });

    bridge.onChatAiToolUpdate?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      updateStreamingMessage(data.conversationId, (message) => {
        const toolBlock = findToolBlock(message.content as ContentBlock[], data.toolUseId, data.name);
        if (!toolBlock) {
          appendSystemLog(`[chat] tool-update: block not found for toolUseId=${data.toolUseId}`);
          return;
        }
        toolBlock.name = String(data.name || toolBlock.name || 'tool');
        toolBlock.input = data.input;
        toolBlock.content = data.output;
        if (data.details) toolBlock.details = data.details;
        toolBlock.status = 'running';
      });
    });

    bridge.onChatAiToolResult?.((data) => {
      if (!hasConversationStreamingMessage(data.conversationId)) return;
      updateStreamingMessage(data.conversationId, (message) => {
        const toolBlock = findToolBlock(message.content as ContentBlock[], data.toolUseId);
        if (toolBlock) {
          toolBlock.status = data.isError ? 'error' : 'success';
          toolBlock.content = data.output;
          toolBlock.is_error = data.isError;
          if (data.details) toolBlock.details = data.details;
        }
      });
    });

    bridge.onChatToolApprovalRequested?.((request) => {
      const existingIndex = uiState.chatToolApprovalRequests.findIndex((entry) => entry.id === request.id);
      const next = existingIndex >= 0
        ? uiState.chatToolApprovalRequests.map((entry) => (entry.id === request.id ? request : entry))
        : [...uiState.chatToolApprovalRequests, request];
      setToolApprovalRequests(next);
      notifyUiStateChanged();
    });

    bridge.onChatToolApprovalCleared?.((data) => {
      const next = uiState.chatToolApprovalRequests.filter((entry) => entry.id !== data.id);
      if (next.length !== uiState.chatToolApprovalRequests.length) {
        setToolApprovalRequests(next);
        notifyUiStateChanged();
      }
    });

    bridge.onBrowserPreviewOpen?.((data) => {
      uiState.browserPreviewUrl = data.url;
      uiState.browserPreviewRequestId += 1;
      notifyUiStateChanged();
    });

    // Expose API for triggering browser preview programmatically (dev/testing only)
    if (import.meta.env?.DEV) {
      (window as unknown as Record<string, unknown>).__antseedOpenPreview = (url: string) => {
        uiState.browserPreviewUrl = url;
        uiState.browserPreviewRequestId += 1;
        notifyUiStateChanged();
      };
    }

    bridge.onChatAiStreamDone?.((data) => {
      const shouldClearSending = isConversationSending(data.conversationId);
      const startedAt = streamStartedAtByConversation.get(data.conversationId) ?? 0;
      const elapsedMs = startedAt > 0 && shouldClearSending ? Date.now() - startedAt : 0;
      const finalized = materializeStreamingMessage(getConversationStreamingMessage(data.conversationId));
      const completionMeta = finalized ? normalizeAssistantMeta(finalized) : null;
      streamCompletedAtByConversation.set(data.conversationId, Date.now());

      if (data.conversationId === uiState.chatActiveConversation) {
        if (finalized) commitAssistantMessage(finalized);
        setConversationStreamingMessage(data.conversationId, null);
        if (shouldClearSending) setConversationSending(data.conversationId, false);
        clearChatNotices();
        notifyUiStateChanged();
      } else {
        if (finalized) appendAssistantMessageToConversation(data.conversationId, finalized);
        setConversationStreamingMessage(data.conversationId, null);
        if (shouldClearSending) {
          setConversationSending(data.conversationId, false);
          notifyUiStateChanged();
        }
      }
      if (elapsedMs > 0) appendSystemLog(`AI stream completed in ${(elapsedMs / 1000).toFixed(1)}s.`);
      scheduleChatConversationsRefresh();
      // Only count completions that finalized an assistant message.
      if (completionMeta) {
        onResponseCompleted?.(data.conversationId, {
          inputTokens: completionMeta.inputTokens ?? 0,
          outputTokens: completionMeta.outputTokens ?? 0,
          service: completionMeta.service ?? null,
        });
      }
    });

    bridge.onChatAiStreamError?.((data) => {
      const shouldClearSending = isConversationSending(data.conversationId);
      const stopReason = data.stopReason;
      const isAbort = data.error === 'Request aborted' || stopReason?.kind === 'aborted';
      // Keep whatever already streamed in — users never lose visible content
      // because the stream didn't finish; the error shows below it.
      const finalized = materializeStreamingMessage(getConversationStreamingMessage(data.conversationId));
      const outputAlreadyStarted = Boolean(
        finalized && (Array.isArray(finalized.content) ? finalized.content.length > 0 : Boolean(finalized.content)),
      );
      if (finalized && outputAlreadyStarted) {
        if (data.conversationId === uiState.chatActiveConversation) commitAssistantMessage(finalized);
        else appendAssistantMessageToConversation(data.conversationId, finalized);
      }
      setConversationStreamingMessage(data.conversationId, null);
      streamFailedAtByConversation.set(data.conversationId, Date.now());

      if (data.conversationId === uiState.chatActiveConversation) {
        // Clear the waiting flag even if the error beat chat:ai-stream-start.
        uiState.chatWaitingForStream = false;
        notifyUiStateChanged();
      }
      if (shouldClearSending) {
        setConversationSending(data.conversationId, false);
        if (data.conversationId !== uiState.chatActiveConversation) notifyUiStateChanged();
      }
      if (isAbort) return;
      handleSendFailure(data.conversationId, { error: data.error, ...(stopReason ? { stopReason } : {}) });
      appendSystemLog(`AI Chat error (${stopReason?.kind ?? 'unknown'}): ${data.error}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Thinking phase from runtime logs
  // ---------------------------------------------------------------------------

  let thinkingPhaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearThinkingPhaseExpiry(): void {
    if (thinkingPhaseExpiryTimer !== null) {
      clearTimeout(thinkingPhaseExpiryTimer);
      thinkingPhaseExpiryTimer = null;
    }
  }

  function handleLogLineForThinkingPhase(line: string): void {
    if (!uiState.chatSending) return;
    if (isImageRequestPhase(uiState.chatThinkingPhase)) return;
    const phase = paymentLogToThinkingPhase(line);
    if (!phase) return;
    clearThinkingPhaseExpiry();
    thinkingPhaseExpiryTimer = setTimeout(() => {
      thinkingPhaseExpiryTimer = null;
      if (uiState.chatThinkingPhase !== null) {
        uiState.chatThinkingPhase = null;
        notifyUiStateChanged();
      }
    }, 3500);
    if (uiState.chatThinkingPhase === phase) return;
    uiState.chatThinkingPhase = phase;
    notifyUiStateChanged();
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  uiState.chatSelectedModelId = uiState.chatSelectedModelId || loadLastChatModel() || '';
  notifyUiStateChanged();
  void refreshChatModels();
  void refreshPermissionModeForModel();

  return {
    refreshChatModels,
    privacyModeChosen,
    privacySwitchLanded,
    refreshChatConversations,
    chooseWorkspace,
    startNewChat,
    startNewChatOnModel,
    deleteConversation,
    renameConversation,
    openConversation,
    sendMessage,
    sendMessageToConversation,
    generateImage,
    selectChatModel,
    retryAfterPayment,
    dismissFundsNotice,
    abortChat,
    setChatPermissionMode,
    decideToolApproval,
    handleLogLineForThinkingPhase,
  };
}

export type { ChatModel };
