import { asErrorMessage } from '../../../shared/error-message.js';
import { getPrivacySwitchState, privacyResource, whenPrivacySwitchSettled } from '../app/vpr-resources';
import { defaultStorage } from '../app/local-storage-flag';
import { describeChatError } from './chat-errors';
import { hasPrivateHistory } from './private-history';
import { imageModelCanEdit, modelAcceptsImages, splitPinnedModel } from '../../../shared/pinned-model.js';
import { selectHasFunds } from '../../core/balance';
import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged, notifyUiStateChangedSync } from '../../core/store';
import type {
  ChatModel,
  ChatPermissionMode,
  ConversationFlags,
  DesktopBridge,
  PreparedChatAttachment,
  RawChatAttachment,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../../types/bridge';
import type { ChatMessage, ContentBlock } from '../../ui/components/chat/chat-shared';
import { extractInlineThinkBlocks, findOpenInlineThink, normalizeInlineThinkInMessages, syncInlineThink } from './inline-thinking';
import {
  cloneChatMessage,
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
  shouldWaitForFreeModel,
} from './models';
import { staleReplyEvent, staleStreamEvent } from './send-events';

type ChatConversationSummary = {
  id: string;
  title?: string;
  /** Gateway model id the conversation last used. */
  service?: string;
  workspacePath?: string;
  pinnedAt?: number;
  archivedAt?: number;
  gitBranch?: string;
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

const PRIVATE_CHATS_KEY = 'antseed:privateChats';

function loadPrivateChats(): string[] {
  try {
    const raw = defaultStorage()?.getItem(PRIVATE_CHATS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Kept for as long as the chat exists (deleting a chat drops it): a chat sent in Private stays one. */
function savePrivateChats(ids: string[]): void {
  try {
    defaultStorage()?.setItem(PRIVATE_CHATS_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable: the replies' own privacy tags still mark the chat.
  }
}

/** What the user chose when switching Anonymous / Private with a chat open. */
export type PrivacySwitchChoice = {
  /** Start a new chat instead of carrying on in the open one. */
  newChat?: boolean;
  /** Carry the open chat's private history into Anonymous anyway. */
  keepPrivateHistory?: boolean;
  /** The chat the user was warned about; consent is recorded for it only, and only while it is still open. */
  conversationId?: string | null;
};

export type ChatModuleApi = {
  /** Reload the gateway's model list (`force` skips main's one-minute cache). */
  refreshChatModels: (options?: { force?: boolean }) => Promise<void>;
  privacyModeChosen: (mode: 'anonymous' | 'private', choice?: PrivacySwitchChoice) => void;
  privacySwitchLanded: (mode: 'anonymous' | 'private') => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  startNewChat: () => void;
  startNewChatOnModel: (modelId: string) => void;
  /** Null once the chat is gone; otherwise why it couldn't be deleted (the list is restored). */
  deleteConversation: (convId?: string) => Promise<string | null>;
  renameConversation: (convId: string, newTitle: string) => void;
  /** Pin, unpin, archive or unarchive a chat in the sidebar. Null when saved; otherwise why not (the change is undone). */
  setConversationFlags: (convId: string, flags: ConversationFlags) => Promise<string | null>;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[], options?: { privateAtSubmit?: boolean }) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[], options?: { privateAtSubmit?: boolean }) => void;
  generateImage: (prompt: string, options?: { privateAtSubmit?: boolean }) => void;
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
/** How long a first message waits for a free seller to be found, and how often it looks. */
const FREE_MODEL_WAIT_MS = 45_000;
const FREE_MODEL_POLL_MS = 2_000;
const FINDING_FREE_MODEL = 'Finding a free model';
/** The new chat's key among chats Private moved. */
const DRAFT = '';
const PRIVATE_NOT_CONFIRMED = 'Private couldn\'t be turned on, so this message wasn\'t sent. Switch to Private again, or send it in Anonymous.';
const PRIVATE_HISTORY_REFUSAL = 'This chat was sent in Private. Carrying on here in Anonymous would send its history to providers that don\'t run in a TEE. Start a new chat, or switch back to Private.';

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
  let conversationOpenToken = 0;
  let permissionRefreshToken = 0;
  let desiredWorkspacePath: string | null = uiState.chatWorkspacePath || null;
  let newChatDraftVersion = 0;
  /**
   * First messages of new chats, before their chats exist. Each submission has
   * its own token: `shownDraft` is the one on screen (it owns the composer's
   * sending state, and Stop cancels only it); starting another chat detaches it
   * without cancelling, so it still sends in the background.
   */
  let shownDraft = 0;
  let draftSeq = 0;
  const stoppedDrafts = new Set<number>();
  let firstModelShownRecorded = false;
  const sendingConversationIds = new Set<string>();
  const streamStartedAtByConversation = new Map<string, number>();
  const streamCompletedAtByConversation = new Map<string, number>();
  const streamFailedAtByConversation = new Map<string, number>();
  const localConversationMessages = new Map<string, ChatMessage[]>();
  const streamingMessagesByConversation = new Map<string, ChatMessage>();
  const pendingStreamingUiFlushes = new Set<string>();
  /** In-flight model rebinds, awaited before the conversation's next send. */
  /** A chat's model change still being saved: what was picked, and when it is stored. */
  const pendingModelUpdates = new Map<string, { modelId: string; done: Promise<void> }>();
  /** Each chat's latest model choice and how many it has had, so a read that began before one can't undo it. */
  const modelChoices = new Map<string, { revision: number; modelId: string }>();
  /** Conversations whose last send stopped for lack of funds, with the notice to show when reopened. */
  const fundsNoticeByConversation = new Map<string, { message: string; canAddFunds: boolean }>();

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function showChatError(message: unknown): void {
    uiState.chatError = describeChatError(
      asErrorMessage(message, 'Unexpected chat error'),
      (id) => uiState.chatModels.find((model) => model.id === id)?.label,
    );
    notifyUiStateChanged();
  }

  function clearChatNotices(): void {
    uiState.chatError = null;
    uiState.chatFundsNotice = null;
  }

  function reportChatError(err: unknown, fallback: string): string {
    const message = asErrorMessage(err, fallback);
    showChatError(message);
    appendSystemLog(`Chat error: ${message}`);
    return message;
  }

  function showFundsNotice(convId: string, notice: { message: string; canAddFunds: boolean }): void {
    fundsNoticeByConversation.set(convId, notice);
    if (convId === uiState.chatActiveConversation) {
      uiState.chatError = null;
      uiState.chatFundsNotice = notice;
      notifyUiStateChanged();
    }
  }

  function forgetFundsNotice(convId: string): void {
    fundsNoticeByConversation.delete(convId);
    imageRetryByConversation.delete(convId);
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
  /**
   * Models Private put chats on, by chat (DRAFT for the new chat), with the
   * model each had before: when Private ends, each one still on the model
   * Private chose goes back, open or not. `privateChoice` is the latest, which
   * new chats start on while Private is on.
   */
  const privateMoves = new Map<string, { from: string; to: string }>();
  let privateChoice: { from: string; to: string } | null = null;
  /** Chats the user chose to carry from Private into Anonymous. */
  const privateHistoryAllowed = new Set<string>();
  /** Stop presses per conversation: a request checks its count is unchanged after every wait. */
  /**
   * Which request owns each conversation's "sending" state. Only the owner may
   * clear it, so an earlier request finishing late can't end a follow-up's;
   * Stop takes ownership away, which also cancels a request still waiting.
   */
  const sendOwners = new Map<string, number>();
  let sendSeq = 0;
  function beginSend(convId: string): number {
    const token = ++sendSeq;
    sendOwners.set(convId, token);
    setConversationSending(convId, true);
    return token;
  }
  const ownsSend = (convId: string, token: number): boolean => sendOwners.get(convId) === token;
  /** A done or error event from a send that a newer one has replaced: it must not touch the chat. */
  const isStaleStreamEvent = (data: { conversationId: string; sendId?: number }): boolean =>
    staleStreamEvent(sendOwners.get(data.conversationId), data.sendId);
  /** Output of a send that no longer holds the chat (stopped, or replaced): it must not reach the chat's reply. */
  const isStaleReplyEvent = (data: { conversationId: string; sendId?: number }): boolean =>
    staleReplyEvent(sendOwners.get(data.conversationId), data.sendId);
  function endSend(convId: string, token: number): void {
    if (!ownsSend(convId, token)) return;
    sendOwners.delete(convId);
    setConversationSending(convId, false);
  }
  /** A model the new chat was started on by hand (Home's), which the default must not replace. */
  let draftModel: string | null = null;
  /**
   * Bumped whenever the new-chat screen's model is chosen or the draft is
   * replaced: a Private list read that resolves after it must not move the
   * draft off what the user just picked.
   */
  let draftSelectionRevision = 0;
  uiState.chatPrivateConversationIds = loadPrivateChats();

  /** Remembers that a prompt in this chat went out under Private, whatever came back. */
  function markPrivateChat(convId: string): void {
    if (uiState.chatPrivateConversationIds.includes(convId)) return;
    uiState.chatPrivateConversationIds = [...uiState.chatPrivateConversationIds, convId];
    savePrivateChats(uiState.chatPrivateConversationIds);
    notifyUiStateChanged();
  }

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
    if (privateMoves.get(DRAFT)?.to === current && listed) return;
    if (draftModel && current === draftModel && listed?.type === 'text') return;
    if (lastModel && current !== lastModel && findChatModel(uiState.chatModels, lastModel)?.type === 'text') {
      uiState.chatSelectedModelId = lastModel;
      void refreshPermissionModeForModel(lastModel);
      return;
    }
    // The saved choice counts only while it is the model selected: a fallback
    // picked because it went unlisted is still provisional.
    const keep = listed?.type === 'text' && (current === lastModel || listed.free || splitPinnedModel(current).peerId);
    if (keep) return;
    const next = chooseDefaultChatModel(uiState.chatModels, lastModel);
    if (next && next !== current) {
      // Private's shorter list left the model out: like a move Private makes
      // itself, it is undone when Private ends.
      if (current && privacyResource.getSnapshot().data?.mode === 'private') {
        privateChoice = { from: privateMoves.get(DRAFT)?.from ?? current, to: next };
        privateMoves.set(DRAFT, privateChoice);
      }
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
          uiState.chatModels = Array.isArray(result.data) ? result.data : [];
          // The list comes from the peers found so far, so it can be empty just after
          // launch, with a short-lived cache in front of it.
          if (uiState.chatModels.some((model) => model.type === 'text')) modelRetryCount = 0;
          else scheduleModelRetry({ force: true });
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
        uiState.chatModelsError = asErrorMessage(error, 'The gateway did not return a model list.');
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
    const convId = uiState.chatActiveConversation;
    const key = convId ?? DRAFT;
    const current = uiState.chatSelectedModelId;
    privateChoice = { from: privateMoves.get(key)?.from ?? current, to: next };
    privateMoves.set(key, privateChoice);
    uiState.chatImageModelId = null;
    uiState.chatSelectedModelId = next;
    // The open chat carries on with the model Private can use.
    if (convId) saveChatModel(convId, next);
    clearChatNotices();
    void refreshPermissionModeForModel(next);
    notifyUiStateChanged();
  }

  /**
   * Private has ended: each chat still on the model Private chose for it goes
   * back to its own, whether it is open or not. One the user moved since keeps
   * the user's choice.
   */
  function restorePrivateMoves(): void {
    const moves = [...privateMoves];
    privateMoves.clear();
    privateChoice = null;
    const active = uiState.chatActiveConversation;
    for (const [key, move] of moves) {
      if (key === DRAFT) {
        if (active || uiState.chatSelectedModelId !== move.to) continue;
        uiState.chatSelectedModelId = move.from;
        void refreshPermissionModeForModel(move.from);
        continue;
      }
      const saved = pendingModelUpdates.get(key)?.modelId ?? modelChoices.get(key)?.modelId ?? findConversationSummary(key)?.service;
      if (saved !== move.to) continue;
      if (key === active) {
        uiState.chatSelectedModelId = move.from;
        void refreshPermissionModeForModel(move.from);
      }
      saveChatModel(key, move.from);
    }
    notifyUiStateChanged();
  }


  /**
   * Applies the user's new-chat or private-history choice when the toggle is
   * chosen. Model changes wait for privacySwitchLanded, after the gateway
   * successfully switches. The open chat stays open unless `newChat`; carrying
   * a chat with private history into Anonymous needs `keepPrivateHistory`.
   */
  function privacyModeChosen(_mode: 'anonymous' | 'private', choice: PrivacySwitchChoice = {}): void {
    if (choice.newChat && activeConversation) startNewChat();
    else if (choice.keepPrivateHistory) {
      const convId = choice.conversationId ?? uiState.chatActiveConversation;
      // The warning named the chat on screen; another chat opened since then
      // (or one still loading over the warned one) gets no consent.
      if (convId && convId === uiState.chatActiveConversation) privateHistoryAllowed.add(convId);
    }
    // Models move only once the gateway has switched (privacySwitchLanded): a
    // switch that fails changes nothing about the chat.
  }


  /** Once the gateway has switched: its list now says what each model costs under this mode. */
  async function privacySwitchLanded(mode: 'anonymous' | 'private'): Promise<void> {
    if (mode !== 'private') {
      restorePrivateMoves();
      await refreshChatModels({ force: true });
      return;
    }
    // The chat and its model as the switch landed: a list read that comes back
    // after the user moved on must not change another chat's model.
    const chatAtStart = uiState.chatActiveConversation;
    const before = uiState.chatSelectedModelId;
    const revisionAtStart = chatAtStart ? modelChoices.get(chatAtStart)?.revision : draftSelectionRevision;
    await refreshChatModels({ force: true });
    if (uiState.chatActiveConversation !== chatAtStart) return;
    const revisionNow = chatAtStart ? modelChoices.get(chatAtStart)?.revision : draftSelectionRevision;
    if (revisionNow !== revisionAtStart) return;
    // Judged from `before`: the refresh's own default for a model no longer listed prefers free.
    const next = chooseModelForPrivate(uiState.chatModels, before, selectHasFunds(uiState));
    if (next && next !== uiState.chatSelectedModelId) {
      uiState.chatSelectedModelId = before;
      moveModelForPrivate(next);
    }
  }


  function scheduleModelRetry(options: { force?: boolean } = {}): void {
    if (modelRetryTimer || modelRetryCount >= MODEL_LIST_MAX_AUTO_RETRIES) return;
    modelRetryCount += 1;
    modelRetryTimer = setTimeout(() => {
      modelRetryTimer = null;
      void refreshChatModels(options);
    }, MODEL_LIST_RETRY_MS);
  }

  function selectChatModel(modelId: string): void {
    const id = modelId.trim();
    if (!id) return;
    const model = findChatModel(uiState.chatModels, id);
    if (model && model.type !== 'text') {
      // Image models drive the image tool; the conversation keeps its text model.
      uiState.chatImageModelId = model.type === 'image' ? id : null;
      // A stopped image request would otherwise retry on the model just replaced.
      const openConvId = activeConversation?.id ?? null;
      if (openConvId && imageRetryByConversation.has(openConvId)) {
        forgetFundsNotice(openConvId);
        clearChatNotices();
      }
      if (model.type !== 'image') showChatError(`${model.label} cannot be used in the chat.`);
      notifyUiStateChanged();
      return;
    }
    uiState.chatImageModelId = null;
    uiState.chatSelectedModelId = id;
    // The user's own pick replaces whatever Private chose, for this chat and new ones.
    privateMoves.delete(uiState.chatActiveConversation ?? DRAFT);
    privateChoice = null;
    draftModel = null;
    if (!uiState.chatActiveConversation) draftSelectionRevision += 1;
    clearChatNotices();
    saveLastChatModel(id);
    saveOpenChatModel(id);
    void refreshPermissionModeForModel(id);
    notifyUiStateChanged();
  }

  /** The open chat continues on `id` (the model it is saved with, for its next send). */
  function saveOpenChatModel(id: string): void {
    // The chat on screen, which may still be loading: not the last one loaded.
    saveChatModel(uiState.chatActiveConversation, id);
  }

  /** Saves `id` as the chat's model (a draft has no chat yet: nothing to save but the selection). */
  function saveChatModel(convId: string | null, id: string): void {
    if (convId) forgetFundsNotice(convId);
    if (convId) modelChoices.set(convId, { revision: (modelChoices.get(convId)?.revision ?? 0) + 1, modelId: id });
    if (convId) {
      if (activeConversation?.id === convId) activeConversation.service = id;
      const summary = getConversationSummaries().find((c) => c.id === convId);
      if (summary) summary.service = id;
    }
    if (bridge?.chatAiSetModel) {
      const update = bridge.chatAiSetModel(convId, id)
        .catch((error: unknown) => ({ ok: false, error: asErrorMessage(error) }));
      if (convId) {
        const entry = {
          modelId: id,
          done: update.then((result) => {
            if (pendingModelUpdates.get(convId) === entry) pendingModelUpdates.delete(convId);
            if (!result.ok) appendSystemLog(`Could not save the chat's model: ${result.error ?? 'unknown error'}`);
          }),
        };
        pendingModelUpdates.set(convId, entry);
      }
    }
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
    if (modelId) void bridge?.chatPermissionModeSet?.(modelId, nextMode)?.catch(() => undefined);
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
    const conversationSending = isConversationSending(activeConvId);
    // A first message on the new-chat screen, still waiting for a model or
    // its chat, keeps its Sending and Stop while other chats finish.
    const draftSending = !activeConvId && shownDraft !== 0 && !stoppedDrafts.has(shownDraft);
    const sending = conversationSending || draftSending;
    uiState.chatSendingConversationIds = sendingConversationIds.size === 0 ? [] : Array.from(sendingConversationIds);
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = conversationSending ? activeConvId : null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    if (!draftSending) {
      uiState.chatThinkingPhase = null;
      clearThinkingPhaseExpiry();
    }
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

  function setLocalConversationMessages(convId: string, messages: ChatMessage[]): void {
    localConversationMessages.set(convId, messages.map(cloneChatMessage));
  }

  /** Shows `messages` as the chat's: its cache, the open chat's list and the active conversation. */
  function projectConversationMessages(convId: string, messages: ChatMessage[], updatedAt: number): void {
    setLocalConversationMessages(convId, messages);
    if (convId === uiState.chatActiveConversation) uiState.chatMessages = messages;
    if (activeConversation?.id === convId) {
      activeConversation.messages = messages;
      activeConversation.updatedAt = updatedAt;
    }
  }

  function getLocalConversationMessages(convId: string): ChatMessage[] | null {
    const cached = localConversationMessages.get(convId);
    return cached ? cached.map(cloneChatMessage) : null;
  }

  function setStreamingMessage(message: ChatMessage | null): void {
    uiState.chatStreamingMessage = message ? cloneChatMessage(message) : null;
    notifyUiStateChangedSync();
    if (message) queueScrollChatToBottom();
  }

  function flushStreamingMessage(): void {
    const activeConvId = uiState.chatActiveConversation;
    const message = activeConvId ? streamingMessagesByConversation.get(activeConvId) ?? null : null;
    uiState.chatStreamingMessage = message ? cloneChatMessage(message) : null;
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
    return message ? cloneChatMessage(message) : null;
  }

  function hasConversationStreamingMessage(convId: string): boolean {
    return streamingMessagesByConversation.has(convId);
  }

  function setConversationStreamingMessage(convId: string, message: ChatMessage | null): void {
    if (message) streamingMessagesByConversation.set(convId, cloneChatMessage(message));
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

  function materializeStreamingMessage(message: ChatMessage | null): ChatMessage | null {
    if (!message) return null;
    const cloned = cloneChatMessage(message);
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
          delete details.inlineThink;
          if (Object.keys(details).length === 0) delete block.details;
        }
      }
    }
    return cloned;
  }

  /**
   * Ends the chat's streaming reply where it stands: what already streamed
   * becomes a reply of its own, and the buffer is emptied for the next run.
   */
  function keepStreamedPart(convId: string): void {
    const finalized = materializeStreamingMessage(getConversationStreamingMessage(convId));
    const outputAlreadyStarted = Boolean(
      finalized && (Array.isArray(finalized.content) ? finalized.content.length > 0 : Boolean(finalized.content)),
    );
    if (finalized && outputAlreadyStarted) {
      if (convId === uiState.chatActiveConversation) commitAssistantMessage(finalized);
      else appendAssistantMessageToConversation(convId, finalized);
    }
    setConversationStreamingMessage(convId, null);
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
    const revisionsAtRead = new Map([...modelChoices].map(([id, choice]) => [id, choice.revision]));
    // A save still out when the read starts may land before the read answers.
    const savingAtRead = new Map([...pendingModelUpdates].map(([id, update]) => [id, update.modelId]));
    try {
      const result = await bridge.chatAiListConversations();
      if (result.ok) {
        // A list read before a model change was saved, or before it was even
        // made, still names the old model.
        const conversations = (Array.isArray(result.data) ? (result.data as ChatConversationSummary[]) : [])
          .map((summary) => {
            const pending = pendingModelUpdates.get(summary.id);
            if (pending) return { ...summary, service: pending.modelId };
            const choice = modelChoices.get(summary.id);
            if (choice && choice.revision !== revisionsAtRead.get(summary.id)) return { ...summary, service: choice.modelId };
            const saving = savingAtRead.get(summary.id);
            return saving ? { ...summary, service: saving } : summary;
          });
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
    // Leaving the new-chat screen, like starting another chat: a first message
    // still being prepared goes on in the background and doesn't pull the user back.
    newChatDraftVersion += 1;
    shownDraft = 0;
    const workspacePathAtOpen = uiState.chatWorkspacePath;
    const openToken = ++conversationOpenToken;
    // A slower answer for a chat the user has since left must not replace the current one.
    const isCurrentOpen = () => openToken === conversationOpenToken && uiState.chatActiveConversation === convId;
    uiState.chatActiveConversation = convId;
    uiState.chatOpeningConversationId = convId;
    clearChatNotices();
    uiState.chatFundsNotice = fundsNoticeByConversation.get(convId) ?? null;
    // Its sending state shows while it loads: a prompt already on its way to
    // it (a new chat's first) keeps the composer busy.
    syncActiveConversationSendingState();
    notifyUiStateChanged();

    // A model choice still being saved, or made while this read was out, is
    // newer than what the read may return.
    const modelSaving = pendingModelUpdates.get(convId);
    const revisionAtRead = modelChoices.get(convId)?.revision;
    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (!isCurrentOpen()) return;
      if (!result.ok || !result.data) {
        uiState.chatOpeningConversationId = null;
        reportChatError(result.error, 'Failed to open conversation');
        return;
      }
      const choice = modelChoices.get(convId);
      // Newest first, as the list refresh does: a save still out, then a choice
      // made since the read started, then the save that was out when it started.
      const chosen = pendingModelUpdates.get(convId)
        ?? (choice && choice.revision !== revisionAtRead ? choice : undefined)
        ?? modelSaving;
      const conv = { ...(result.data as ChatConversation), ...(chosen ? { service: chosen.modelId } : {}) };
      const serverMessages = normalizeInlineThinkInMessages(Array.isArray(conv.messages) ? conv.messages : []);
      // A prompt waiting on funds may not be in the session yet; Try again needs it on screen.
      const preferLocal = hasConversationStreamingMessage(convId) || isConversationSending(convId) || fundsNoticeByConversation.has(convId);
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
      if (!isCurrentOpen()) return;
      uiState.chatOpeningConversationId = null;
      reportChatError(err, 'Failed to open conversation');
    }
  }

  /** Home shows one model while a chat is open; the new chat must use what's on screen. */
  function startNewChatOnModel(modelId: string): void {
    startNewChat();
    if (!modelId) return;
    draftModel = modelId;
    draftSelectionRevision += 1;
    if (uiState.chatSelectedModelId === modelId) return;
    uiState.chatSelectedModelId = modelId;
    void refreshPermissionModeForModel(modelId);
    notifyUiStateChanged();
  }

  function startNewChat(): void {
    newChatDraftVersion += 1;
    draftSelectionRevision += 1;
    // A first message still being prepared goes on in the background.
    shownDraft = 0;
    draftModel = null;
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
    privateMoves.delete(DRAFT);
    if (privateChoice && findChatModel(uiState.chatModels, privateChoice.to)) {
      uiState.chatSelectedModelId = privateChoice.to;
      privateMoves.set(DRAFT, privateChoice);
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
        const draftMove = privateMoves.get(DRAFT);
        if (draftMove && modelId === draftMove.to) privateMoves.set(conversationId, draftMove);
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

  /** True once the chat is gone; false when it couldn't be deleted (the error is shown in the chat). */
  async function deleteConversation(targetId?: string): Promise<string | null> {
    const convId = targetId || uiState.chatActiveConversation;
    if (!convId || !bridge?.chatAiDeleteConversation) return 'Could not delete the chat';
    const previousConversations = [...getConversationSummaries()];
    uiState.chatConversations = previousConversations.filter((conv) => conv.id !== convId);
    streamingMessagesByConversation.delete(convId);
    sendingConversationIds.delete(convId);
    streamStartedAtByConversation.delete(convId);
    syncActiveConversationSendingState();
    if (convId === uiState.chatActiveConversation) startNewChat();
    else notifyUiStateChanged();

    try {
      const result = await bridge.chatAiDeleteConversation(convId) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) throw new Error(result.error ?? 'Could not delete the chat');
      // Only now: a chat whose delete fails comes back with its unsaved
      // messages, its funds notice and the request Try again would resend.
      localConversationMessages.delete(convId);
      fundsNoticeByConversation.delete(convId);
      imageRetryByConversation.delete(convId);
      if (uiState.chatPrivateConversationIds.includes(convId)) {
        uiState.chatPrivateConversationIds = uiState.chatPrivateConversationIds.filter((id) => id !== convId);
        savePrivateChats(uiState.chatPrivateConversationIds);
      }
      await refreshChatConversations();
      return null;
    } catch (err) {
      uiState.chatConversations = previousConversations;
      notifyUiStateChanged();
      void refreshChatConversations();
      return reportChatError(err, 'Failed to delete conversation');
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
    void bridge?.chatAiRenameConversation?.(convId, newTitle)?.catch((err: unknown) => {
      appendSystemLog(`Failed to persist conversation rename: ${String(err)}`);
    });
  }

  async function setConversationFlags(
    convId: string,
    flags: ConversationFlags,
  ): Promise<string | null> {
    const previous = getConversationSummaries();
    const now = Date.now();
    // Shown at once; the list read after the write is the source of truth.
    uiState.chatConversations = previous.map((conv) => {
      if (conv.id !== convId) return conv;
      const next: ChatConversationSummary = { ...conv };
      if (flags.pinned === true) { next.pinnedAt = conv.pinnedAt ?? now; delete next.archivedAt; }
      if (flags.pinned === false) delete next.pinnedAt;
      if (flags.archived === true) { next.archivedAt = conv.archivedAt ?? now; delete next.pinnedAt; }
      if (flags.archived === false) delete next.archivedAt;
      return next;
    });
    notifyUiStateChanged();
    try {
      const result = await bridge?.chatAiSetConversationFlags?.(convId, flags);
      if (result && !result.ok) throw new Error(result.error ?? 'Could not update the chat');
      await refreshChatConversations();
      return null;
    } catch (err) {
      uiState.chatConversations = previous;
      notifyUiStateChanged();
      return reportChatError(err, 'Failed to update the chat');
    }
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

  function sendMessage(text: string, rawAttachments?: RawChatAttachment[], options: { privateAtSubmit?: boolean } = {}): void {
    if (!bridge) return;
    if (text.trim().length === 0 && !rawAttachments?.length) return;

    // What the screen showed when Send was pressed: a message sent in Private
    // never goes out Anonymous because the switch to Private failed.
    const privateAtSubmit = options.privateAtSubmit ?? privacyResource.getSnapshot().data?.mode === 'private';
    if (!uiState.chatActiveConversation) {
      const draftVersion = newChatDraftVersion;
      const draftToken = ++draftSeq;
      shownDraft = draftToken;
      const stillDraft = () => !stoppedDrafts.has(draftToken);
      // A default nobody chose can predate the free sellers or the list's final
      // ids, and a sent chat keeps its model: settle it against the list now.
      applyDefaultModel();
      let writtenWith = uiState.chatSelectedModelId;
      // What this submission was written with, kept for when the user moves on
      // to another chat: a model chosen there is that chat's, not this one's.
      let submitted = { modelId: writtenWith, chosen: modelChosen(writtenWith) };
      const needsFree = () => (draftVersion === newChatDraftVersion ? needsFreeModel() : needsFreeModel(submitted));
      setDraftSending(true);
      void (async () => {
        // A new chat keeps its model, and the mode being switched to can move it.
        if (await holdForPrivacySwitch()) {
          if (!stillDraft()) { stoppedDrafts.delete(draftToken); return; }
          const mode = privacyResource.getSnapshot().data?.mode;
          if (mode) await privacySwitchLanded(mode);
          if (draftVersion === newChatDraftVersion) {
            applyDefaultModel();
            writtenWith = uiState.chatSelectedModelId;
            submitted = { modelId: writtenWith, chosen: modelChosen(writtenWith) };
          }
        }
        const waited = await waitForFreeModel(stillDraft, needsFree);
        if (!stillDraft()) { stoppedDrafts.delete(draftToken); return; }
        // The draft's model is captured here: the user may switch before the
        // conversation finishes creating. A wait that found a free model moves to it.
        let modelId = writtenWith;
        if (waited) {
          if (draftVersion === newChatDraftVersion) {
            applyDefaultModel();
            modelId = uiState.chatSelectedModelId;
          } else if (!submitted.chosen && !needsFreeModel(submitted)) {
            // Left behind: the free model the wait found, never the last model
            // saved, which another chat may have chosen meanwhile.
            modelId = chooseDefaultChatModel(uiState.chatModels, null) ?? writtenWith;
          }
        }
        const convId = await createConversationForModel(modelId, { activate: false });
        // Stopped while the chat was being made: it stays, empty, and nothing is sent.
        if (!stillDraft()) { stoppedDrafts.delete(draftToken); return; }
        // The new chat's send is this prompt's from here on, before it opens:
        // a second submit while it loads finds it busy, and Stop there cancels this.
        const reserved = convId ? beginSend(convId) : null;
        // Only the draft on screen owns the composer's sending state.
        if (shownDraft === draftToken) {
          shownDraft = 0;
          if (uiState.chatActiveConversation === null) setDraftSending(false);
        }
        if (!convId || reserved === null) return;
        if (draftVersion === newChatDraftVersion) await openConversation(convId);
        if (!ownsSend(convId, reserved)) return;
        sendMessageToConversation(convId, text, rawAttachments, { privateAtSubmit, reservedToken: reserved });
      })();
      return;
    }
    sendMessageToConversation(uiState.chatActiveConversation, text, rawAttachments, { privateAtSubmit });
  }

  /** Whether the user picked this model, rather than it being a default nobody chose. */
  function modelChosen(modelId: string | null): boolean {
    return (modelId !== null && modelId === loadLastChatModel()) || draftModel !== null || Boolean(modelId && splitPinnedModel(modelId).peerId);
  }

  /**
   * Whether a first message should hold until a free model is listed (see
   * `shouldWaitForFreeModel`): for the composer's selection, or for a
   * submission's own model once it is no longer on screen.
   */
  function needsFreeModel(selection?: { modelId: string | null; chosen: boolean }): boolean {
    const current = selection ? selection.modelId : uiState.chatSelectedModelId;
    return shouldWaitForFreeModel(uiState.chatModels, current, {
      chosen: selection ? selection.chosen : modelChosen(current),
      // A remote gateway that doesn't report its balance counts as funded.
      funded: (uiState.gatewayStatus?.mode === 'remote' && !uiState.creditsBalanceKnown)
        || (uiState.creditsBalanceKnown && Number(uiState.creditsTotalOwnedUsdc) > 0),
    });
  }

  /**
   * Re-reads the list until a free model shows up, the wait runs out, or the
   * send is stopped. True when it waited at all.
   */
  async function waitForFreeModel(stillSending: () => boolean, needs: () => boolean = needsFreeModel): Promise<boolean> {
    if (!needs()) return false;
    uiState.chatThinkingPhase = FINDING_FREE_MODEL;
    notifyUiStateChanged();
    const deadline = Date.now() + FREE_MODEL_WAIT_MS;
    for (;;) {
      await refreshChatModels({ force: true });
      if (!stillSending() || !needs() || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, FREE_MODEL_POLL_MS));
    }
    if (uiState.chatThinkingPhase === FINDING_FREE_MODEL) uiState.chatThinkingPhase = null;
    return true;
  }

  /** `privateAtSubmit`: Private was on screen when Send was pressed (read now when not given). */
  /**
   * `reservedToken`: the send a new chat's first prompt took before the chat
   * opened (see `sendMessage`); it goes out under that ownership, and not at
   * all if Stop took it meanwhile.
   */
  function sendMessageToConversation(convId: string, text: string, rawAttachments?: RawChatAttachment[], options: { privateAtSubmit?: boolean; reservedToken?: number } = {}): void {
    const privateAtSubmit = options.privateAtSubmit ?? privacyResource.getSnapshot().data?.mode === 'private';
    const reserved = options.reservedToken;
    if (reserved !== undefined) {
      if (!ownsSend(convId, reserved)) return;
    } else if (isConversationSending(convId)) {
      showChatError('This conversation already has a request in progress.');
      return;
    }
    // Refused at once when it plainly can't go; the send itself checks again.
    if (privacyResource.getSnapshot().data?.mode === 'anonymous' && heldPrivate(convId)) {
      showChatError(PRIVATE_HISTORY_REFUSAL);
      if (reserved !== undefined) endSend(convId, reserved);
      return;
    }
    const content = text.trim();
    clearChatNotices();
    fundsNoticeByConversation.delete(convId);
    const token = reserved ?? beginSend(convId);
    void (async () => {
      let preparedAttachments: PreparedChatAttachment[];
      try {
        preparedAttachments = await prepareAttachmentsForSend(convId, rawAttachments);
      } catch (err) {
        reportChatError(err, 'Attachment preparation failed');
        endSend(convId, token);
        return;
      }
      if (!ownsSend(convId, token)) return;

      const readyAttachmentCount = preparedAttachments.filter((attachment) => attachment.status === 'ready').length;
      if (content.length === 0 && readyAttachmentCount === 0) {
        const firstError = preparedAttachments.find((attachment) => attachment.status === 'error')?.error;
        showChatError(firstError || 'No supported attachment content to send.');
        endSend(convId, token);
        return;
      }

      const modelId = findConversationSummary(convId)?.service || uiState.chatSelectedModelId;
      const hasReadyImage = preparedAttachments.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready');
      const model = findChatModel(uiState.chatModels, modelId);
      if (hasReadyImage && model && !modelAcceptsImages(model, modelId)) {
        showChatError(`${model.label} doesn't accept images. Sending without image input for this turn.`);
      }

      const localMessages = getLocalConversationMessages(convId)
        ?? (convId === uiState.chatActiveConversation ? (uiState.chatMessages as ChatMessage[]) : []);
      const nextMessages = [...localMessages, { role: 'user' as const, content: buildUserMessageContent(content, preparedAttachments), createdAt: Date.now() }];
      projectConversationMessages(convId, nextMessages, Date.now());
      notifyUiStateChanged();
      void dispatchChatRequest(convId, token, content, preparedAttachments, privateAtSubmit);
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

  /** `token`: the request's ownership of the conversation (see `beginSend`); losing it cancels the request. */
  async function dispatchChatRequest(convId: string, token: number, content: string, attachments?: PreparedChatAttachment[], privateAtSubmit = false): Promise<void> {
    if (!bridge?.chatAiSendStream) {
      endSend(convId, token);
      return;
    }
    // The model picked before Send, not whatever the summary says once its save lands.
    const modelUpdate = pendingModelUpdates.get(convId);
    if (modelUpdate) await modelUpdate.done;
    if (!ownsSend(convId, token)) return;
    const privacy = await clearForPrivacy(convId, token, privateAtSubmit);
    if (!privacy) {
      endSend(convId, token);
      return;
    }
    const modelId = modelUpdate?.modelId || findConversationSummary(convId)?.service || uiState.chatSelectedModelId;
    if (!modelId) {
      reportChatError('Choose a model for this chat.', 'Request failed');
      endSend(convId, token);
      return;
    }

    const requestStartedAt = Date.now();
    streamCompletedAtByConversation.delete(convId);
    streamFailedAtByConversation.delete(convId);
    // A newer text message supersedes an image request waiting on funds.
    imageRetryByConversation.delete(convId);
    // `sendId` comes back on the run's done and error events (see `isStaleStreamEvent`).
    const send = () => bridge.chatAiSendStream!(convId, content || ' ', modelId, attachments, uiState.chatPermissionMode, { ...privacy, sendId: token });
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
      // A request still streaming ends with its done event; a follow-up that
      // started meanwhile owns the flag now.
      if (!hasConversationStreamingMessage(convId)) endSend(convId, token);
    }
  }

  /** Its history went out in Private, and the user hasn't chosen to carry it into Anonymous. */
  function heldPrivate(convId: string): boolean {
    return !privateHistoryAllowed.has(convId) && conversationHasPrivateHistory(convId);
  }

  /**
   * The last word before a request leaves: waits out a mode change still
   * reaching the gateway (the send is held, not dropped), then refuses a chat
   * sent in Private once Private is off. Null when it must not go out (refused,
   * or stopped while held); otherwise whether the gateway must still be in
   * Private when it sends, which the main process checks after its own wait.
   */
  async function clearForPrivacy(convId: string, token: number, privateAtSubmit = false): Promise<{ requirePrivate: boolean; allowPrivateHistory: boolean } | null> {
    await holdForPrivacySwitch();
    if (!ownsSend(convId, token)) return null;
    const mode = privacyResource.getSnapshot().data?.mode;
    // Sent while the screen showed Private, but the switch didn't take: it waits for the user.
    if (privateAtSubmit && mode !== 'private') {
      showChatError(PRIVATE_NOT_CONFIRMED);
      return null;
    }
    const held = heldPrivate(convId);
    if (mode === 'anonymous' && held) {
      showChatError(PRIVATE_HISTORY_REFUSAL);
      return null;
    }
    if (mode === 'private') {
      markPrivateChat(convId);
      // Consent covered the history the user was shown; a new Private turn
      // needs it asked again before it can leave in Anonymous.
      privateHistoryAllowed.delete(convId);
    }
    return { requirePrivate: mode === 'private' || held, allowPrivateHistory: privateHistoryAllowed.has(convId) };
  }

  /** Waits, showing why, while a mode change is reaching the gateway. True when it waited. */
  async function holdForPrivacySwitch(): Promise<boolean> {
    if (!getPrivacySwitchState().switching) return false;
    const phase = privacyResource.getSnapshot().data?.mode === 'private' ? 'Switching to Private' : 'Switching to Anonymous';
    uiState.chatThinkingPhase = phase;
    notifyUiStateChanged();
    await whenPrivacySwitchSettled();
    if (uiState.chatThinkingPhase === phase) uiState.chatThinkingPhase = null;
    notifyUiStateChanged();
    return true;
  }

  /** A reply in this chat went out under Private (a failed one too: its prompt was sent). */
  function conversationHasPrivateHistory(convId: string): boolean {
    const messages = getLocalConversationMessages(convId)
      ?? (convId === uiState.chatActiveConversation ? (uiState.chatMessages as ChatMessage[]) : []);
    return hasPrivateHistory(convId, uiState.chatPrivateConversationIds, messages);
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
    if (!convId || !fundsNoticeByConversation.has(convId) || isConversationSending(convId)) return;
    const imageRequest = imageRetryByConversation.get(convId);
    if (imageRequest) {
      imageRetryByConversation.delete(convId);
      fundsNoticeByConversation.delete(convId);
      clearChatNotices();
      void runImageRequest(convId, imageRequest);
      return;
    }
    const last = lastUserMessage(convId);
    if (!last) return;
    fundsNoticeByConversation.delete(convId);
    clearChatNotices();
    const token = beginSend(convId);
    void dispatchChatRequest(convId, token, last.content, last.attachments.length > 0 ? last.attachments : undefined);
  }

  function dismissFundsNotice(): void {
    const convId = uiState.chatActiveConversation;
    if (convId) forgetFundsNotice(convId);
    uiState.chatFundsNotice = null;
    notifyUiStateChanged();
  }

  async function abortChat(): Promise<void> {
    const convId = uiState.chatActiveConversation;
    if (convId) {
      // What already streamed is kept as its own reply, and the buffer is
      // emptied, before the chat is free: a follow-up sent before this run's
      // abort arrives starts a reply of its own instead of continuing this one.
      keepStreamedPart(convId);
      sendOwners.delete(convId);
      setConversationSending(convId, false);
    }
    else {
      // A draft has no run in the main process yet: stopping it must not abort
      // every chat's run, which is what an abort without a chat id does. Only
      // the draft on screen stops; one detached by a new chat keeps going.
      if (shownDraft) stoppedDrafts.add(shownDraft);
      shownDraft = 0;
      setDraftSending(false);
      return;
    }
    if (bridge?.chatAiAbort) await bridge.chatAiAbort(convId);
  }

  // ---------------------------------------------------------------------------
  // Image generation (gateway /v1/images, the selected image model)
  // ---------------------------------------------------------------------------

  /** An image request stopped for lack of funds; Try again replays it, not the text model. */
  const imageRetryByConversation = new Map<string, ImageRequest>();

  /** The prompt is already in the conversation, from the first attempt. */
  async function runImageRequest(convId: string, request: ImageRequest, privateAtSubmit = false, reservedToken?: number): Promise<void> {
    if (!bridge?.chatGenerateImage) return;
    if (reservedToken !== undefined && !ownsSend(convId, reservedToken)) return;
    const token = reservedToken ?? beginSend(convId);
    queueScrollChatToBottom();
    try {
      const privacy = await clearForPrivacy(convId, token, privateAtSubmit);
      if (!privacy) return;
      uiState.chatThinkingPhase = request.sourceImageAttachmentId ? 'Editing image' : 'Generating image';
      notifyUiStateChanged();
      const result = await bridge.chatGenerateImage({ conversationId: convId, ...request, ...privacy });
      const funds = fundsNoticeFromStopReason(result.stopReason);
      if (funds) {
        imageRetryByConversation.set(convId, request);
        showFundsNotice(convId, funds);
        return;
      }
      if (!result.ok || !result.user || !result.assistant) {
        throw new Error(result.error || 'Image generation failed.');
      }
      // The prompt was projected optimistically; append only the reply.
      const current = getLocalConversationMessages(convId) ?? (convId === uiState.chatActiveConversation ? uiState.chatMessages as ChatMessage[] : []);
      const messages = [...current, result.assistant as ChatMessage];
      projectConversationMessages(convId, messages, Date.now());
      scheduleChatConversationsRefresh();
      notifyUiStateChanged();
      queueScrollChatToBottom();
    } catch (error) {
      const message = asErrorMessage(error, 'Image generation failed');
      if (message !== 'Request aborted') {
        reportChatError(message, 'Image generation failed');
      }
    } finally {
      // Stopped: the flag now belongs to whatever was sent after it.
      endSend(convId, token);
    }
  }

  /**
   * The chat's own history for an image request. While the chat is still
   * opening, the screen shows the previous chat's messages, so they're never
   * used for it: the history is read from the chat itself instead.
   */
  async function imageRequestHistory(convId: string): Promise<ChatMessage[]> {
    const local = getLocalConversationMessages(convId);
    if (local) return local;
    if (convId === uiState.chatActiveConversation && uiState.chatOpeningConversationId !== convId) {
      return uiState.chatMessages as ChatMessage[];
    }
    try {
      const result = await bridge?.chatAiGetConversation?.(convId);
      const messages = result?.ok ? (result.data as ChatConversation | undefined)?.messages : undefined;
      return Array.isArray(messages) ? normalizeInlineThinkInMessages(messages) : [];
    } catch {
      return [];
    }
  }

  function generateImage(prompt: string, options: { privateAtSubmit?: boolean } = {}): void {
    const privateAtSubmit = options.privateAtSubmit ?? privacyResource.getSnapshot().data?.mode === 'private';
    const content = prompt.trim();
    if (!content || !bridge?.chatGenerateImage) return;
    const imageModelId = uiState.chatImageModelId;
    if (!imageModelId) {
      showChatError('Choose an image model first.');
      return;
    }
    const imageModel = findChatModel(uiState.chatModels, imageModelId);

    // A first prompt on the new-chat screen already being prepared owns the
    // composer: a second submit would make a second chat and a second paid image.
    if (!uiState.chatActiveConversation && shownDraft) return;
    void (async () => {
      let convId = uiState.chatActiveConversation;
      // A new chat's send, taken before it opens (as for a first text message).
      let reserved: number | undefined;
      if (!convId) {
        const textModelId = uiState.chatSelectedModelId;
        if (!textModelId) {
          showChatError('Choose a text model before starting an image conversation.');
          return;
        }
        // The same draft ownership as a first text message: Stop cancels it,
        // and a user who moved on isn't pulled back to this chat.
        const draftVersion = newChatDraftVersion;
        const draftToken = ++draftSeq;
        shownDraft = draftToken;
        const stillDraft = () => !stoppedDrafts.has(draftToken);
        setDraftSending(true);
        convId = await createConversationForModel(textModelId, { activate: false });
        if (!stillDraft()) { stoppedDrafts.delete(draftToken); return; }
        if (convId) reserved = beginSend(convId);
        if (shownDraft === draftToken) {
          shownDraft = 0;
          if (uiState.chatActiveConversation === null) setDraftSending(false);
        }
        if (!convId) return;
        // Follow-ups in this chat are image requests too.
        if (draftVersion === newChatDraftVersion) await openConversation(convId, { keepImageModel: true });
        // Stopped while the chat opened: nothing is sent.
        if (reserved !== undefined && !ownsSend(convId, reserved)) return;
      }
      if (!convId) return;
      if (reserved === undefined) {
        if (isConversationSending(convId)) {
          showChatError('This conversation already has a request in progress.');
          return;
        }
        // Owned from here, before any wait: a second submit while the
        // history below loads is refused instead of replacing this one.
        reserved = beginSend(convId);
      }
      // An earlier image of a chat sent in Private would go out as the one to edit.
      if (privacyResource.getSnapshot().data?.mode === 'anonymous' && heldPrivate(convId)) {
        showChatError(PRIVATE_HISTORY_REFUSAL);
        if (reserved !== undefined) endSend(convId, reserved);
        return;
      }

      clearChatNotices();
      // This prompt supersedes one waiting on funds.
      fundsNoticeByConversation.delete(convId);
      imageRetryByConversation.delete(convId);
      const existingBeforeRequest = await imageRequestHistory(convId);
      // Stopped while the history loaded: nothing is sent.
      if (!ownsSend(convId, reserved)) return;
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
      const editing = Boolean(sourceImageAttachmentId) && Boolean(imageModel) && imageModelCanEdit(imageModel!, imageModelId);
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
      projectConversationMessages(convId, pendingMessages, optimisticUserMessage.createdAt ?? Date.now());

      await runImageRequest(convId, {
        prompt: requestPrompt,
        model: imageModelId,
        ...(editing ? { sourceImageAttachmentId } : {}),
      }, privateAtSubmit, reserved);
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
      // A stopped send's reply was already kept as it stood, and a newer send
      // owns the chat's Sending state: its final message must touch neither.
      if (isStaleReplyEvent(data)) {
        scheduleChatConversationsRefresh();
        return;
      }
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
      // Its prompt's timestamp must not land on a newer send's prompt.
      if (isStaleStreamEvent(data)) return;
      if (data.conversationId !== uiState.chatActiveConversation) return;
      const last = (uiState.chatMessages[uiState.chatMessages.length - 1] || null) as ChatMessage | null;
      if (last && last.role === 'user' && !last.createdAt) {
        last.createdAt = data.message?.createdAt || Date.now();
        setLocalConversationMessages(data.conversationId, uiState.chatMessages as ChatMessage[]);
        notifyUiStateChanged();
      }
    });

    bridge.onChatConversationTitleUpdated?.((data) => {
      // Tagged like every run event, but always taken: the title names the
      // conversation, not the reply, and stays right after Stop or a follow-up.
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
      if (isStaleReplyEvent(data)) return;
      const streaming = getConversationStreamingMessage(data.conversationId);
      if (!streaming) return;
      setConversationStreamingMessage(data.conversationId, { ...streaming, meta: { ...(streaming.meta ?? {}), ...data.meta } });
    });

    bridge.onChatAiStreamStart?.((data) => {
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleReplyEvent(data)) return;
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
      if (isStaleStreamEvent(data)) return;
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
      // Stop frees the chat at once, so a stopped send's abort can arrive
      // after a follow-up started: it is that send's, not the follow-up's.
      if (isStaleStreamEvent(data)) return;
      const shouldClearSending = isConversationSending(data.conversationId);
      const stopReason = data.stopReason;
      const isAbort = data.error === 'Request aborted' || stopReason?.kind === 'aborted';
      // Keep whatever already streamed in — users never lose visible content
      // because the stream didn't finish; the error shows below it.
      keepStreamedPart(data.conversationId);
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
    setConversationFlags,
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
