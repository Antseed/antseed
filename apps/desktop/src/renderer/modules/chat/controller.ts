import type { BadgeTone, DiscoverRow, RendererUiState, VprModelCatalogEntry, VprSelectedModel } from '../../core/state';
import { LOCALHOST_URL } from '../../constants';
import { notifyUiStateChanged, notifyUiStateChangedSync } from '../../core/store';
import { deriveConnectBadge } from '../app/connect-badge';
import { normalizeDiscoverRow, projectRowsToChatServiceOptions } from '../catalog/discover-rows.js';
import { resolveVprChatOption } from './projection.js';
import { supportsImageEdits, supportsServiceParameter } from '../catalog/model-capabilities.js';
import { findCatalogEntry, projectRowsToVprModelCatalog, selectDefaultVprModel } from '../catalog/model-catalog.js';
import { sameCanonicalModel } from '../catalog/model-identity.js';
import { bestFreeVprRouteReputation, chooseBestVprRoute, filterRoutableVprRoutes, isRouteEligibleForAutoSelection } from '../routing/select.js';
import { routesForSelectedModel } from '../catalog/view-models.js';
import { saveVprRouteSelection } from '../routing/preferences.js';
import { syncBuyerDefaultRoute } from '../routing/proxy-sync.js';
import { clearVprModelPin, saveVprModelPins, setVprModelPin } from '../routing/model-pins.js';
import {
  applyOpenRouterBaselines,
  ensureOpenRouterPrices,
  getCachedOpenRouterPrices,
} from '../catalog/openrouter-baseline.js';
import type {
  DesktopBridge,
  PreparedChatAttachment,
  RawChatAttachment,
  ChatPermissionMode,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../../types/bridge';
import type {
  ChatMessage,
  ContentBlock,
} from '../../ui/components/chat/chat-shared';
import { formatUsd } from '../../core/format';
import {
  cloneContentBlock,
  formatCompactNumber,
  getMyrmecochoryLabel,
  isImageRequestPhase,
  normalizeAssistantMeta,
  paymentLogToThinkingPhase,
} from '../../ui/components/chat/chat-shared';

type ChatConversationUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type ChatConversationSummary = {
  id: string;
  title?: string;
  service?: string;
  provider?: string;
  peerId?: string;
  /** Seller that produced the latest assistant response. Display-only; the
   * conversation's `peerId` remains its text route. */
  lastResponsePeerId?: string;
  /**
   * How this thread's peer was chosen. Absent on threads created before route
   * modes were recorded; those are treated as 'auto'.
   */
  routeMode?: 'auto' | 'pinned';
  workspacePath?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  usage?: ChatConversationUsage;
  totalTokens?: number;
  totalEstimatedCostUsd?: number;
  [key: string]: unknown;
};

type ChatConversation = ChatConversationSummary & {
  messages?: ChatMessage[];
};

type ChatServiceCatalogEntry = {
  id?: string;
  label?: string;
  provider?: string;
  protocol?: string;
  count?: number;
  [key: string]: unknown;
};

type ChatModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  appendSystemLog: (message: string) => void;
  onPaymentCardShown?: () => void;
  onResponseCompleted?: (conversationId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    service: string | null;
  }) => void;
};

const CUMULATIVE_IMAGE_PROMPT_HEADER = 'Generate a new image using the full conversation history below as cumulative instructions.';
const CUMULATIVE_IMAGE_PROMPT_FOOTER = 'Return only the newly generated image.';

function buildCumulativeImagePrompt(priorPrompts: string[], currentPrompt: string): string {
  const previousPrompt = priorPrompts.at(-1) ?? '';
  if (previousPrompt.startsWith(CUMULATIVE_IMAGE_PROMPT_HEADER)
    && previousPrompt.endsWith(CUMULATIVE_IMAGE_PROMPT_FOOTER)) {
    const history = previousPrompt
      .slice(CUMULATIVE_IMAGE_PROMPT_HEADER.length, -CUMULATIVE_IMAGE_PROMPT_FOOTER.length)
      .trim();
    const followUpNumbers = [...history.matchAll(/^Follow-up (\d+):/gm)]
      .map((match) => Number.parseInt(match[1] ?? '0', 10));
    const nextFollowUp = Math.max(0, ...followUpNumbers) + 1;
    return [
      CUMULATIVE_IMAGE_PROMPT_HEADER,
      '',
      history,
      `Follow-up ${String(nextFollowUp)}: ${currentPrompt}`,
      '',
      CUMULATIVE_IMAGE_PROMPT_FOOTER,
    ].join('\n');
  }
  return [
    CUMULATIVE_IMAGE_PROMPT_HEADER,
    '',
    ...[...priorPrompts, currentPrompt].map((entry, index) => `${index === 0 ? 'Initial request' : `Follow-up ${String(index)}`}: ${entry}`),
    '',
    CUMULATIVE_IMAGE_PROMPT_FOOTER,
  ].join('\n');
}

export type ChatModuleApi = {
  refreshChatServiceOptions: () => Promise<void>;
  /** Re-derive the routable rows, model catalog and service list after a peer
      allow/block rule changes. */
  applyPeerAccessRules: () => void;
  /** End the provisional-default window after an explicit model choice made
      outside this module (the model page's "Use" button). */
  endProvisionalDefaultModel: () => void;
  refreshChatProxyStatus: () => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[]) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[]) => void;
  generateImage: (prompt: string) => void;
  retryAfterPayment: () => void;
  abortChat: () => Promise<void>;
  handleServiceChange: (
    value: string,
    explicitPeerId?: string,
    rememberModelPin?: boolean,
    routeMode?: 'auto' | 'pinned',
  ) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  decideToolApproval: (decision: ToolApprovalDecision, requestId?: string) => void;
  handleLogLineForThinkingPhase: (line: string) => void;
};

export function initChatModule({
  bridge,
  uiState,
  appendSystemLog,
  onPaymentCardShown,
  onResponseCompleted,
}: ChatModuleOptions): ChatModuleApi {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const fallbackChatServices: NormalizedChatServiceEntry[] = [];
  const PAYMENT_AUTO_RETRY_DELAY_MS = 7_000;
  const PAYMENT_AUTO_RETRY_MAX_ATTEMPTS = 2;

  type NormalizedChatServiceEntry = Required<
    Pick<ChatServiceCatalogEntry, 'id' | 'label' | 'provider' | 'protocol' | 'count'>
  > & {
    peerId: string;
    peerDisplayName: string | null;
    peerLabel: string;
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    categories: string[];
    description: string;
  };
  type ChatServiceSelection = { id: string; provider: string | null; peerId?: string };
  type ChatServiceOption = ChatServiceSelection & { label: string; value: string };

  const CHAT_SERVICE_SELECTION_SEPARATOR = '\u0001';
  const CHAT_SERVICE_REFRESH_INTERVAL_MS = 60_000;
  const PROXY_STARTUP_PROBE_INTERVAL_MS = 1_000;
  // Faster retry during first-run setup while no services have been found yet.
  const CHAT_SERVICE_SETUP_REFRESH_INTERVAL_MS = 2_000;
  // Last-resort backstop only: the main-process handler bounds itself to
  // ~26s worst case via per-phase budgets, so on a healthy machine this never
  // fires. Generous so slow machines/connections still get their rows late
  // rather than never.
  const CHAT_SERVICE_LIST_TIMEOUT_MS = 30_000;

  // ---------------------------------------------------------------------------
  // Module-local state
  // ---------------------------------------------------------------------------

  let activeConversation: ChatConversation | null = null;
  let streamingIndicatorTimer: number | null = null;
  let proxyState: 'unknown' | 'online' | 'offline' = 'unknown';
  let proxyPort = 0;
  let lastServiceOptionsSignature = '';
  let pendingServiceOptions: NormalizedChatServiceEntry[] | null = null;
  let lastServiceRefreshAt = 0;
  let serviceRefreshToken = 0;
  let serviceRefreshInProgress = false;
  let serviceSelectFocused = false;
  let workspaceSwitchToken = 0;
  let permissionRefreshToken = 0;
  let desiredWorkspacePath: string | null = uiState.chatWorkspacePath || null;
  const sendingConversationIds = new Set<string>();
  const streamTurnsByConversation = new Map<string, number>();
  const streamStartedAtByConversation = new Map<string, number>();
  const streamCompletedAtByConversation = new Map<string, number>();
  const streamFailedAtByConversation = new Map<string, number>();
  const localConversationMessages = new Map<string, ChatMessage[]>();
  const streamingMessagesByConversation = new Map<string, ChatMessage>();
  const pendingStreamingUiFlushes = new Set<string>();
  let newChatDraftVersion = 0;

  const normalizePermissionMode = (value: unknown): ChatPermissionMode => (
    value === 'full' ? 'full' : 'manual'
  );

  function getActivePermissionPeerId(): string {
    const conversationPeerId = activeConversation?.peerId?.trim() ?? '';
    if (conversationPeerId) return conversationPeerId;
    if (uiState.chatSelectedPeerId) return uiState.chatSelectedPeerId;
    const selected = decodeChatServiceSelection(uiState.chatSelectedServiceValue);
    return selected.peerId?.trim() ?? '';
  }

  async function refreshChatPermissionModeForPeer(peerId = getActivePermissionPeerId()): Promise<void> {
    const refreshToken = permissionRefreshToken + 1;
    permissionRefreshToken = refreshToken;
    const normalizedPeerId = peerId.trim();
    if (!normalizedPeerId) {
      uiState.chatPermissionMode = 'manual';
      notifyUiStateChanged();
      return;
    }
    uiState.chatPermissionMode = 'manual';
    notifyUiStateChanged();
    try {
      const result = await bridge?.chatPeerPermissionModeGet?.(normalizedPeerId);
      if (permissionRefreshToken !== refreshToken || normalizedPeerId !== getActivePermissionPeerId().trim()) {
        return;
      }
      if (result?.ok && result.mode) {
        uiState.chatPermissionMode = normalizePermissionMode(result.mode);
        notifyUiStateChanged();
      }
    } catch {
      // Keep the current in-memory value.
    }
  }

  void refreshChatPermissionModeForPeer();

  function setChatPermissionMode(mode: ChatPermissionMode): void {
    const nextMode = normalizePermissionMode(mode);
    const peerId = getActivePermissionPeerId();
    uiState.chatPermissionMode = nextMode;
    if (peerId) {
      void bridge?.chatPeerPermissionModeSet?.(peerId, nextMode).catch(() => undefined);
    }
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
  // Payment approval helpers
  // ---------------------------------------------------------------------------

  async function fetchPeerInfo(peerId: string): Promise<void> {
    if (!bridge?.paymentsGetPeerInfo) return;
    try {
      const result = await bridge.paymentsGetPeerInfo(peerId);
      if (result.ok && result.data) {
        const now = Date.now() / 1000;
        const timestamp = result.data.timestamp || now;
        const ageDays = Math.floor((now - timestamp) / 86400);

        uiState.chatPaymentApprovalPeerInfo = {
          reputation: result.data.onChainChannelCount ?? result.data.reputation ?? 0,
          channelCount: result.data.onChainChannelCount ?? null,
          disputeCount: result.data.onChainGhostCount ?? null,
          networkAgeDays: ageDays > 0 ? ageDays : null,
          evmAddress: result.data.evmAddress ?? null,
        };
        notifyUiStateChanged();
      }
    } catch {
      // Silently fail — card shows without peer info
    }
  }

  function primePaymentApprovalState(amountBaseUnits: string): { peerId: string | null } {
    const selectedService = uiState.chatServiceOptions.find(
      (opt) => opt.value === uiState.chatSelectedServiceValue,
    );
    uiState.chatPaymentApprovalAmount = (Number(amountBaseUnits) / 1_000_000).toFixed(2);
    uiState.chatPaymentApprovalPeerName = selectedService?.peerLabel ?? selectedService?.label ?? null;
    uiState.chatPaymentApprovalPeerInfo = null;
    uiState.chatPaymentApprovalError = null;
    return { peerId: selectedService?.peerId ?? null };
  }

  /**
   * Show the payment approval card with peer context from the currently
   * selected service, and kick off a fetchPeerInfo call for reputation data.
   */
  function showPaymentApprovalCard(amountBaseUnits: string): void {
    const { peerId } = primePaymentApprovalState(amountBaseUnits);
    uiState.chatPaymentApprovalVisible = true;
    notifyUiStateChanged();
    onPaymentCardShown?.();
    if (peerId) {
      void fetchPeerInfo(peerId);
    }
  }

  function hidePaymentApprovalCard(): void {
    uiState.chatPaymentApprovalVisible = false;
    uiState.chatPaymentApprovalPeerName = null;
    uiState.chatPaymentApprovalPeerInfo = null;
    uiState.chatPaymentApprovalLoading = false;
    uiState.chatPaymentApprovalError = null;
  }

  function clearTransientChatNotices(): void {
    uiState.chatError = null;
    hidePaymentApprovalCard();
  }

  async function refreshAvailableCreditsUsdc(): Promise<number> {
    if (!bridge?.creditsGetInfo) {
      return parseFloat(uiState.creditsAvailableUsdc || '0');
    }

    try {
      // Decides whether a 402 can be retried right away: never from cache.
      const result = await bridge.creditsGetInfo({ fresh: true });
      if (!result.ok || !result.data) {
        return parseFloat(uiState.creditsAvailableUsdc || '0');
      }

      uiState.creditsAvailableUsdc = result.data.availableUsdc;
      uiState.creditsReservedUsdc = result.data.reservedUsdc;
      uiState.creditsTotalUsdc = result.data.balanceUsdc;
      uiState.creditsPendingUsdc = result.data.pendingUsdc;
      uiState.creditsSpendableUsdc = result.data.spendableUsdc;
      uiState.creditsWalletUsdc = result.data.walletUsdc;
      uiState.creditsTotalOwnedUsdc = result.data.totalOwnedUsdc;
      uiState.creditsCreditLimitUsdc = result.data.creditLimitUsdc;
      uiState.creditsEvmAddress = result.data.evmAddress;
      uiState.creditsOperatorAddress = result.data.operatorAddress ?? null;
      return parseFloat(result.data.availableUsdc || '0');
    } catch {
      return parseFloat(uiState.creditsAvailableUsdc || '0');
    }
  }

  type ChatRetryContext = {
    convId: string;
    content?: string;
    attachments?: PreparedChatAttachment[];
    selection?: ChatServiceSelection;
  };

  const chatRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const chatRetryAttempts = new Map<string, number>();
  const chatRetryFailedPeerIds = new Map<string, Set<string>>();

  function clearPaymentRetry(convId: string): void {
    const timer = chatRetryTimers.get(convId);
    if (timer) clearTimeout(timer);
    chatRetryTimers.delete(convId);
    chatRetryAttempts.delete(convId);
    chatRetryFailedPeerIds.delete(convId);
    uiState.chatRoutingNotice = null;
  }

  function findConversationSummary(convId: string): ChatConversationSummary | null {
    if (activeConversation?.id === convId) return activeConversation;
    return Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[]).find((c) => c.id === convId) ?? null
      : null;
  }

  function isPinnedConversation(convId: string): boolean {
    return findConversationSummary(convId)?.routeMode === 'pinned';
  }

  /**
   * Pick a different healthy peer for a conversation whose current peer just
   * failed.
   *
   * Returns null when failover must not happen: the thread is pinned (the user
   * chose that peer), or no better alternative exists — retrying the same peer
   * still beats refusing to send.
   */
  function resolveFailoverSelection(
    convId: string,
    failedPeerId: string | undefined,
    excludePeerIds: string[],
  ): { selection: ChatServiceSelection; fromLabel: string; toLabel: string } | null {
    if (!failedPeerId) return null;

    const conversation = findConversationSummary(convId);
    // Threads with no recorded mode predate route-mode tracking; they are
    // treated as auto, since failover only runs after a failure.
    if (isPinnedConversation(convId)) return null;

    const serviceId = normalizeChatServiceId(conversation?.service);
    if (serviceId.length === 0) return null;

    const provider = normalizeProviderId(conversation?.provider) ?? '';
    const catalogEntry = provider
      ? findCatalogEntry(uiState.vprModelCatalog, provider, serviceId)
      : null;
    const model = catalogEntry
      ? {
          provider: catalogEntry.provider,
          serviceId: catalogEntry.serviceId,
          label: catalogEntry.label,
          categories: [...catalogEntry.categories],
        }
      : { provider, serviceId, label: serviceId, categories: [] };

    const option = resolveVprChatOption(
      uiState.chatServiceOptions,
      uiState.discoverRows,
      { model, mode: 'auto', peerId: null },
      uiState.vprRoutingPreferences,
      { excludePeerIds },
    );
    if (!option || option.peerId === failedPeerId) return null;

    const selection = decodeChatServiceSelection(option.value);
    if (selection.id.length === 0 || !selection.peerId) return null;

    const failedLabel = uiState.discoverRows.find((row) => row.peerId === failedPeerId)?.peerLabel
      ?? `${failedPeerId.slice(0, 8)}...`;
    return {
      selection,
      fromLabel: failedLabel,
      toLabel: option.peerLabel || `${option.peerId?.slice(0, 8)}...`,
    };
  }

  /**
   * Rebind a conversation to a new peer in renderer state.
   *
   * Applied eagerly rather than threaded through the retry context so both
   * retry entry points pick it up: the one that re-dispatches with an explicit
   * selection, and the one that re-reads the conversation's own peer.
   */
  function applyFailoverSelection(convId: string, selection: ChatServiceSelection): void {
    const patch = {
      service: selection.id,
      provider: selection.provider ?? undefined,
      peerId: undefined,
      routeMode: 'auto' as const,
    };
    if (activeConversation?.id === convId) Object.assign(activeConversation, patch);
    if (Array.isArray(uiState.chatConversations)) {
      const row = (uiState.chatConversations as ChatConversationSummary[]).find((c) => c.id === convId);
      if (row) Object.assign(row, patch);
    }
    void bridge?.chatAiSelectPeer?.({
      conversationId: convId,
      peerId: null,
      service: selection.id,
      provider: selection.provider,
      routeMode: 'auto',
    }).catch(() => undefined);
    notifyUiStateChanged();
  }

  function scheduleChatRetry(
    ctx?: ChatRetryContext,
    reason: 'payment' | 'request' = 'payment',
    finalError?: unknown,
  ): void {
    const convId = ctx?.convId ?? uiState.chatActiveConversation;
    if (!convId) return;

    const nextAttempt = (chatRetryAttempts.get(convId) ?? 0) + 1;
    if (nextAttempt > PAYMENT_AUTO_RETRY_MAX_ATTEMPTS) {
      if (reason === 'payment') {
        appendSystemLog('Payment negotiation is still pending. Please retry the request in a moment.');
      } else {
        reportChatError(finalError ?? 'Request failed after retry.', 'Request failed');
      }
      return;
    }

    const existing = chatRetryTimers.get(convId);
    if (existing) clearTimeout(existing);
    chatRetryAttempts.set(convId, nextAttempt);

    // Retrying the same dead peer is what made a failed conversation fail
    // three times in a row. Move to a healthy peer before arming the timer, so
    // both retry paths below dispatch to the new one.
    let retryCtx = ctx;
    if (reason === 'request') {
      const failedPeerId = ctx?.selection?.peerId ?? findConversationSummary(convId)?.peerId;
      const failedPeerIds = chatRetryFailedPeerIds.get(convId) ?? new Set<string>();
      if (failedPeerId) failedPeerIds.add(failedPeerId);
      chatRetryFailedPeerIds.set(convId, failedPeerIds);
      const failover = resolveFailoverSelection(convId, failedPeerId, [...failedPeerIds]);
      if (failover) {
        applyFailoverSelection(convId, failover.selection);
        if (ctx) {
          retryCtx = {
            ...ctx,
            selection: { id: failover.selection.id, provider: failover.selection.provider },
          };
        }
        const notice = `${failover.fromLabel} isn't responding. `
          + `Retrying on ${failover.toLabel} in ${PAYMENT_AUTO_RETRY_DELAY_MS / 1000}s...`;
        if (convId === uiState.chatActiveConversation) {
          uiState.chatRoutingNotice = notice;
        }
        appendSystemLog(notice);
      }
    }

    if (!uiState.chatRoutingNotice || reason === 'payment') {
      appendSystemLog(
        reason === 'payment'
          ? `Payment negotiation is still settling. Retrying in ${PAYMENT_AUTO_RETRY_DELAY_MS / 1000}s...`
          : `Chat request failed. Retrying in ${PAYMENT_AUTO_RETRY_DELAY_MS / 1000}s...`,
      );
    }

    const timer = setTimeout(() => {
      chatRetryTimers.delete(convId);
      if (convId !== uiState.chatActiveConversation && uiState.chatRoutingNotice) {
        uiState.chatRoutingNotice = null;
        notifyUiStateChanged();
      }
      const ctxForRetry = retryCtx;
      if (ctxForRetry?.content != null) {
        setConversationSending(convId, true);
        dispatchChatRequest(convId, ctxForRetry.content, ctxForRetry.attachments, ctxForRetry.selection);
      } else {
        retryAfterPayment(convId);
      }
    }, PAYMENT_AUTO_RETRY_DELAY_MS);
    chatRetryTimers.set(convId, timer);
  }

  async function handlePaymentRequired(amountBaseUnits: string, retryCtx?: ChatRetryContext): Promise<void> {
    const required = Number(amountBaseUnits) / 1_000_000;
    const available = await refreshAvailableCreditsUsdc();

    if (
      Number.isFinite(required)
      && required > 0
      && available >= required
    ) {
      scheduleChatRetry(retryCtx, 'payment');
      notifyUiStateChanged();
      return;
    }

    showPaymentApprovalCard(amountBaseUnits);
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  function normalizeProviderId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  function normalizeChatServiceId(service: unknown): string {
    return String(service ?? '').trim();
  }

  function encodeChatServiceSelection(serviceId: string, provider: string | null, peerId?: string): string {
    const normalizedServiceId = normalizeChatServiceId(serviceId);
    if (!normalizedServiceId) return '';
    const normalizedProvider = normalizeProviderId(provider);
    const base = normalizedProvider
      ? `${normalizedProvider}${CHAT_SERVICE_SELECTION_SEPARATOR}${normalizedServiceId}`
      : normalizedServiceId;
    const normalizedPeerId = peerId?.trim();
    return normalizedPeerId
      ? `${base}${CHAT_SERVICE_SELECTION_SEPARATOR}${normalizedPeerId}`
      : base;
  }

  function decodeChatServiceSelection(value: unknown): ChatServiceSelection {
    const raw = String(value ?? '');
    if (!raw) return { id: '', provider: null };
    const parts = raw.split(CHAT_SERVICE_SELECTION_SEPARATOR);
    if (parts.length === 1) return { id: normalizeChatServiceId(raw), provider: null };
    // Format: "provider\x01service" or "provider\x01service\x01peerId"
    const provider = normalizeProviderId(parts[0]);
    const id = normalizeChatServiceId(parts[1]);
    const peerId = parts[2]?.trim() || undefined;
    return { id, provider, peerId };
  }

  function modelOnlySelection(selection: ChatServiceSelection): ChatServiceSelection {
    return { id: selection.id, provider: selection.provider };
  }

  function selectionForCurrentRoute(selection: ChatServiceSelection): ChatServiceSelection {
    return uiState.vprRouteSelection.mode === 'pinned-peer'
      ? selection
      : modelOnlySelection(selection);
  }

  function pinnedConversationPeerId(
    conversation: ChatConversationSummary | null | undefined,
    fallbackPeerId = '',
  ): string | undefined {
    if (conversation?.routeMode !== 'pinned') return undefined;
    return conversation.peerId?.trim() || fallbackPeerId.trim() || undefined;
  }

  function findMatchingChatServiceOptionValue(
    options: ChatServiceOption[],
    targetServiceId: unknown,
    targetProvider?: unknown,
    targetPeerId?: unknown,
  ): string | null {
    const serviceId = normalizeChatServiceId(targetServiceId);
    if (!serviceId) return null;
    const provider = normalizeProviderId(targetProvider);
    const peerId = typeof targetPeerId === 'string' ? targetPeerId.trim() : '';
    if (peerId && provider) {
      const exactPeer = options.find(
        (o) => o.id === serviceId && o.provider === provider && o.peerId === peerId,
      );
      if (exactPeer) return exactPeer.value;
    }
    if (peerId) {
      const peerMatch = options.find((o) => o.id === serviceId && o.peerId === peerId);
      if (peerMatch) return peerMatch.value;
    }
    if (provider) {
      const exact = options.find((o) => o.id === serviceId && o.provider === provider);
      if (exact) return exact.value;
    }
    const fallback = options.find((o) => o.id === serviceId);
    return fallback?.value ?? null;
  }

  function computeServiceOptionsSignature(options: NormalizedChatServiceEntry[]): string {
    return options
      .map(
        (e) =>
          `${e.id}|${e.label}|${e.provider}|${e.peerId}|${e.peerDisplayName}|${e.peerLabel}|${e.protocol}|${String(e.count)}|${String(e.inputUsdPerMillion)}|${String(e.outputUsdPerMillion)}|${e.categories.join(',')}`,
      )
      .join('\n');
  }

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  function getConversationSummaries(): ChatConversationSummary[] {
    return Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[])
      : [];
  }

  function getActiveConversationId(): string | null {
    return typeof uiState.chatActiveConversation === 'string'
      ? uiState.chatActiveConversation
      : null;
  }

  function getConversationId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const id = (payload as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  function getConversationTokenCounts(conv: ChatConversationSummary) {
    const usage = (conv as Record<string, unknown>)?.usage as
      | ChatConversationUsage
      | undefined;
    const inputTokens = Math.max(0, Math.floor(Number(usage?.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(usage?.outputTokens) || 0));
    const totalFromUsage = inputTokens + outputTokens;
    const totalFromSummary = Math.max(0, Math.floor(Number(conv?.totalTokens) || 0));
    return {
      inputTokens,
      outputTokens,
      totalTokens: totalFromSummary > 0 ? totalFromSummary : totalFromUsage,
    };
  }

  function formatChatDateTime(timestamp: unknown): string {
    if (!timestamp || Number(timestamp) <= 0) return 'n/a';
    const d = new Date(Number(timestamp));
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function toErrorMessage(err: unknown, fallback = 'Unexpected error'): string {
    if (typeof err === 'string' && err.trim().length > 0) return err;
    if (
      err &&
      typeof err === 'object' &&
      'message' in err &&
      typeof err.message === 'string' &&
      err.message.trim().length > 0
    ) {
      return err.message;
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Message helpers
  // ---------------------------------------------------------------------------

  function isToolResultOnlyMessage(msg: ChatMessage): boolean {
    return (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      (msg.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')
    );
  }

  function visibleMessages(messages: unknown[]): ChatMessage[] {
    if (!Array.isArray(messages)) return [];
    return (messages as ChatMessage[]).filter((msg) => !isToolResultOnlyMessage(msg));
  }

  // ---------------------------------------------------------------------------
  // Display state updates (no DOM — writes to uiState + notifies React)
  // ---------------------------------------------------------------------------

  function setServiceSelectLoading(loading: boolean): void {
    uiState.chatServiceSelectDisabled = loading;
    notifyUiStateChanged();
  }

  function setRuntimeActivity(tone: BadgeTone, message: string): void {
    uiState.runtimeActivity = { tone, message };
    notifyUiStateChanged();
  }

  function showChatError(message: unknown): void {
    uiState.chatError = toErrorMessage(message, 'Unexpected chat error');
    notifyUiStateChanged();
  }

  function clearChatError(): void {
    uiState.chatError = null;
    notifyUiStateChanged();
  }

  function reportChatError(err: unknown, fallback: string): string {
    const message = toErrorMessage(err, fallback);
    showChatError(message);
    appendSystemLog(`Chat error: ${message}`);
    return message;
  }

  function updateStreamingIndicator(): void {
    const activeConvId = uiState.chatActiveConversation;
    const activeSending = activeConvId ? sendingConversationIds.has(activeConvId) : uiState.chatSending;
    const activeStreamStartedAt = activeConvId ? streamStartedAtByConversation.get(activeConvId) ?? 0 : 0;
    const elapsedMs =
      activeStreamStartedAt > 0 ? Date.now() - activeStreamStartedAt : 0;

    uiState.chatThinkingElapsedMs = activeSending ? elapsedMs : 0;
    notifyUiStateChanged();
  }

  function updateThreadMeta(conv: ChatConversation | null): void {
    if (!conv) {
      uiState.chatRoutedPeer = '';
      uiState.chatRoutedPeerId = '';
      uiState.chatSessionStarted = '';
      uiState.chatSessionReservedUsdc = '';
      uiState.chatSessionAccumulatedCostUsd = '';
      uiState.chatSessionTotalTokens = '';
      uiState.chatLifetimeSpentUsdc = '';
      uiState.chatLifetimeTotalTokens = '';
      uiState.chatLifetimeSessions = '';
      return;
    }

    const messages = visibleMessages(conv.messages || []);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastServingPeerId = '';
    for (const msg of messages) {
      const meta = normalizeAssistantMeta(msg);
      if (meta) {
        if (meta.peerId) lastServingPeerId = meta.peerId;
        totalInputTokens += meta.inputTokens;
        totalOutputTokens += meta.outputTokens;
      }
    }

    // Prefer message-derived token counts (always up-to-date) over stale conv.usage
    const msgTotalTokens = totalInputTokens + totalOutputTokens;
    const tokenCounts = msgTotalTokens > 0
      ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: msgTotalTokens }
      : getConversationTokenCounts(conv);

    // Show the conversation-bound peer first. The global selector can move while
    // a thread is open, but the thread header must keep displaying the peer this
    // conversation is actually pinned to.
    const conversationPeerId = conv.peerId?.trim() ?? '';
    if (conversationPeerId) {
      const pinnedOption = uiState.chatServiceOptions.find((o) => o.peerId === conversationPeerId);
      uiState.chatRoutedPeer = pinnedOption?.peerDisplayName || pinnedOption?.peerLabel || conversationPeerId.slice(0, 8);
    } else if (uiState.chatSelectedPeerId) {
      const pinnedOption = uiState.chatServiceOptions.find((o) => o.peerId === uiState.chatSelectedPeerId);
      uiState.chatRoutedPeer = pinnedOption?.peerDisplayName || pinnedOption?.peerLabel || uiState.chatSelectedPeerId.slice(0, 8);
    } else if (lastServingPeerId) {
      const knownPeer = Array.isArray(uiState.lastPeers)
        ? uiState.lastPeers.find((p) => p.peerId === lastServingPeerId)
        : undefined;
      const shortId = lastServingPeerId.slice(0, 8);
      uiState.chatRoutedPeer = knownPeer?.displayName
        ? `${knownPeer.displayName} (${shortId})`
        : shortId;
    } else {
      uiState.chatRoutedPeer = '';
    }

    const resolvedPeerId = resolveConversationPeerId(conv) || lastServingPeerId;
    uiState.chatRoutedPeerId = resolvedPeerId;
    // Only set fallback values for fields the metering endpoint hasn't populated yet.
    // This prevents flicker: updateThreadMeta runs first with message-derived data,
    // then fetchAndApplyMeteringStats overwrites with authoritative data.
    if (!uiState.chatSessionStarted) {
      uiState.chatSessionStarted = conv.createdAt ? formatChatDateTime(conv.createdAt) : '';
    }
    if (!uiState.chatSessionTotalTokens && tokenCounts.totalTokens > 0) {
      uiState.chatSessionTotalTokens = formatCompactNumber(tokenCounts.totalTokens);
    }
  }

  // ---------------------------------------------------------------------------
  // Metering stats from buyer proxy endpoint (source of truth)
  // ---------------------------------------------------------------------------

  function resolveConversationPeerId(conv: ChatConversation | null): string {
    if (!conv) return '';
    const convPeerId = conv.peerId?.trim() ?? '';
    if (convPeerId) return convPeerId;
    if (uiState.chatSelectedPeerId) return uiState.chatSelectedPeerId;
    // Fallback: resolve from service options (the service maps to a peer)
    const serviceOption = uiState.chatServiceOptions.find(
      (o) => o.value === uiState.chatSelectedServiceValue || o.id === conv.service,
    );
    if (serviceOption?.peerId) return serviceOption.peerId;
    // Last resort: extract peerId from the encoded service value (format: "provider\x01service\x01peerId")
    const parts = uiState.chatSelectedServiceValue.split(CHAT_SERVICE_SELECTION_SEPARATOR);
    return parts.length >= 3 ? parts[2]!.trim() : '';
  }

  type MeteringPeerStats = {
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reservedUsdc: string | null;
    consumedUsdc: string | null;
    channelStatus: string | null;
    reservedAt: number | null;
    lifetimeSessions: number;
    lifetimeRequests: number;
    lifetimeInputTokens: number;
    lifetimeOutputTokens: number;
    lifetimeTotalTokens: number;
    lifetimeAuthorizedUsdc: string;
    lifetimeFirstSessionAt: number | null;
  };

  async function fetchAndApplyMeteringStats(sellerPeerId: string): Promise<void> {
    const port = uiState.chatProxyPort;
    if (!port) return;
    try {
      const prev = {
        tokens: uiState.chatSessionTotalTokens,
        cost: uiState.chatSessionAccumulatedCostUsd,
        reserved: uiState.chatSessionReservedUsdc,
        started: uiState.chatSessionStarted,
        ltSpent: uiState.chatLifetimeSpentUsdc,
        ltTokens: uiState.chatLifetimeTotalTokens,
        ltSessions: uiState.chatLifetimeSessions,
      };
      const url = `${LOCALHOST_URL}:${port}/_antseed/metering/${encodeURIComponent(sellerPeerId)}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const stats = (await resp.json()) as MeteringPeerStats;
      if (stats.totalTokens > 0) {
        uiState.chatSessionTotalTokens = formatCompactNumber(stats.totalTokens);
      }
      // reservedUsdc and consumedUsdc are USDC amounts stored as 6-decimal bigint strings
      if (stats.reservedUsdc) {
        const reservedNum = Number(stats.reservedUsdc) / 1_000_000;
        if (reservedNum > 0) uiState.chatSessionReservedUsdc = formatUsd(reservedNum);
      }
      if (stats.consumedUsdc) {
        const consumedNum = Number(stats.consumedUsdc) / 1_000_000;
        if (consumedNum > 0) uiState.chatSessionAccumulatedCostUsd = formatUsd(consumedNum);
      }
      if (stats.reservedAt) {
        uiState.chatSessionStarted = formatChatDateTime(stats.reservedAt);
      }
      // Lifetime totals across all sessions with this peer
      const lifetimeSpent = Number(stats.lifetimeAuthorizedUsdc || '0') / 1_000_000;
      if (lifetimeSpent > 0) uiState.chatLifetimeSpentUsdc = formatUsd(lifetimeSpent);
      if (stats.lifetimeTotalTokens > 0) uiState.chatLifetimeTotalTokens = formatCompactNumber(stats.lifetimeTotalTokens);
      if (stats.lifetimeSessions > 1) uiState.chatLifetimeSessions = String(stats.lifetimeSessions);

      if (uiState.chatSessionTotalTokens !== prev.tokens ||
          uiState.chatSessionAccumulatedCostUsd !== prev.cost ||
          uiState.chatSessionReservedUsdc !== prev.reserved ||
          uiState.chatSessionStarted !== prev.started ||
          uiState.chatLifetimeSpentUsdc !== prev.ltSpent ||
          uiState.chatLifetimeTotalTokens !== prev.ltTokens ||
          uiState.chatLifetimeSessions !== prev.ltSessions) {
        notifyUiStateChanged();
      }
    } catch {
      // Buyer proxy unavailable — keep message-derived values
    }
  }

  let _meteringDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedFetchMeteringStats(peerId: string): void {
    if (_meteringDebounceTimer) clearTimeout(_meteringDebounceTimer);
    _meteringDebounceTimer = setTimeout(() => {
      _meteringDebounceTimer = null;
      void fetchAndApplyMeteringStats(peerId);
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Streaming indicator timer
  // ---------------------------------------------------------------------------

  function clearStreamingIndicatorTimer(): void {
    if (streamingIndicatorTimer !== null) {
      clearInterval(streamingIndicatorTimer);
      streamingIndicatorTimer = null;
    }
  }

  function ensureStreamingIndicatorTimer(): void {
    if (streamingIndicatorTimer !== null) return;
    streamingIndicatorTimer = window.setInterval(() => {
      if (sendingConversationIds.size === 0 && !uiState.chatSending) {
        clearStreamingIndicatorTimer();
        return;
      }
      updateStreamingIndicator();
    }, 1000);
  }

  function isConversationSending(convId: string | null | undefined): boolean {
    return Boolean(convId && sendingConversationIds.has(convId));
  }

  function publishSendingConversationIds(): void {
    // Snapshot the set into the uiState so the conversation list can show a
    // running indicator for every in-flight conversation (not just the active
    // one).
    uiState.chatSendingConversationIds =
      sendingConversationIds.size === 0 ? [] : Array.from(sendingConversationIds);
  }

  function syncActiveConversationSendingState(): void {
    const activeConvId = uiState.chatActiveConversation;
    const sending = isConversationSending(activeConvId);
    publishSendingConversationIds();
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = sending ? activeConvId : null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    uiState.chatThinkingPhase = null;
    clearThinkingPhaseExpiry();

    if (sendingConversationIds.size > 0 || sending) {
      ensureStreamingIndicatorTimer();
    } else {
      clearStreamingIndicatorTimer();
    }

    updateStreamingIndicator();
  }

  function setConversationSending(convId: string, sending: boolean): void {
    if (sending) {
      sendingConversationIds.add(convId);
      if (!streamStartedAtByConversation.has(convId)) {
        streamStartedAtByConversation.set(convId, Date.now());
      }
    } else {
      sendingConversationIds.delete(convId);
      streamTurnsByConversation.delete(convId);
      streamStartedAtByConversation.delete(convId);
    }
    syncActiveConversationSendingState();
    notifyUiStateChangedSync();
  }

  function setChatSending(sending: boolean): void {
    const activeConvId = uiState.chatActiveConversation;
    if (activeConvId) {
      setConversationSending(activeConvId, sending);
      return;
    }
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
    if (sending) {
      ensureStreamingIndicatorTimer();
    } else if (sendingConversationIds.size === 0) {
      clearStreamingIndicatorTimer();
    }
    updateStreamingIndicator();
  }

  // ---------------------------------------------------------------------------
  // Scroll helper
  // ---------------------------------------------------------------------------

  function scrollChatToBottom(): void {
    const container = document.querySelector<HTMLElement>('[data-chat-scroll]');
    if (!container) return;
    const threshold = 40;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < threshold) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function queueScrollChatToBottom(): void {
    requestAnimationFrame(() => {
      scrollChatToBottom();
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

  function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => cloneStreamingMessage(message));
  }

  function setLocalConversationMessages(convId: string, messages: ChatMessage[]): void {
    localConversationMessages.set(convId, cloneMessages(messages));
  }

  function getLocalConversationMessages(convId: string): ChatMessage[] | null {
    const cached = localConversationMessages.get(convId);
    return cached ? cloneMessages(cached) : null;
  }

  function setStreamingMessage(message: ChatMessage | null): void {
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
    notifyUiStateChangedSync();
    if (message) queueScrollChatToBottom();
  }

  function publishActiveStreamingMessage(): void {
    const activeConvId = uiState.chatActiveConversation;
    const message = activeConvId
      ? streamingMessagesByConversation.get(activeConvId) ?? null
      : null;
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
  }

  function flushStreamingMessage(): void {
    publishActiveStreamingMessage();
    notifyUiStateChanged();
    if (uiState.chatStreamingMessage) queueScrollChatToBottom();
  }

  function scheduleStreamingMessageFlush(convId: string): void {
    if (uiState.chatActiveConversation !== convId) return;
    if (pendingStreamingUiFlushes.has(convId)) return;
    pendingStreamingUiFlushes.add(convId);
    queueAnimationFrame(() => {
      pendingStreamingUiFlushes.delete(convId);
      if (uiState.chatActiveConversation === convId) {
        flushStreamingMessage();
      }
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
    if (message) {
      streamingMessagesByConversation.set(convId, cloneStreamingMessage(message));
    } else {
      streamingMessagesByConversation.delete(convId);
    }
    pendingStreamingUiFlushes.delete(convId);

    if (uiState.chatActiveConversation === convId) {
      setStreamingMessage(message);
    }
  }

  function updateStreamingMessage(convId: string, mutator: (message: ChatMessage) => void): void {
    const current = streamingMessagesByConversation.get(convId);
    if (!current) return;
    mutator(current);
    scheduleStreamingMessageFlush(convId);
  }

  // ---------------------------------------------------------------------------
  // Service management
  // ---------------------------------------------------------------------------

  function getAvailableChatServiceOptions(): ChatServiceOption[] {
    if (uiState.chatServiceOptions.length > 0) {
      return uiState.chatServiceOptions
        .map((entry): ChatServiceOption | null => {
          const selection = decodeChatServiceSelection(entry.value);
          if (!selection.id) return null;
          return {
            id: selection.id,
            label: entry.label,
            provider: selection.provider,
            peerId: selection.peerId ?? entry.peerId ?? undefined,
            value: entry.value,
          };
        })
        .filter((opt): opt is ChatServiceOption => opt !== null);
    }

    return fallbackChatServices.map((entry) => ({
      id: normalizeChatServiceId(entry.id),
      label: String(entry.label ?? entry.id),
      provider: normalizeProviderId(entry.provider),
      peerId: entry.peerId || undefined,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
    }));
  }

  function getConversationServiceSelection(convId: string): ChatServiceSelection {
    const conversation =
      activeConversation?.id === convId
        ? activeConversation
        : (Array.isArray(uiState.chatConversations)
            ? (uiState.chatConversations as ChatConversationSummary[]).find((conv) => conv.id === convId)
            : null);

    const conversationModel = normalizeChatServiceId(conversation?.service);
    if (conversationModel.length > 0) {
      const conversationPeerId = pinnedConversationPeerId(conversation);
      return {
        id: conversationModel,
        provider: normalizeProviderId(conversation?.provider),
        ...(conversationPeerId ? { peerId: conversationPeerId } : {}),
      };
    }

    return getSelectedChatServiceSelection();
  }

  function getSelectedChatServiceSelection(): ChatServiceSelection {
    // Active conversations are immutable unless the user explicitly switches
    // service/peer. Always prefer the persisted model and any explicit pin over
    // the global dropdown value, because Discover may refresh or re-sort it
    // while a thread is open.
    const conversationModel = normalizeChatServiceId(activeConversation?.service);
    if (conversationModel.length > 0) {
      const conversationPeerId = pinnedConversationPeerId(
        activeConversation,
        uiState.chatSelectedPeerId,
      );
      return {
        id: conversationModel,
        provider: normalizeProviderId(activeConversation?.provider),
        ...(conversationPeerId ? { peerId: conversationPeerId } : {}),
      };
    }

    const vprOption = resolveVprChatOption(
      uiState.chatServiceOptions,
      uiState.discoverRows,
      uiState.vprRouteSelection,
      uiState.vprRoutingPreferences,
    );
    if (vprOption) {
      const selected = decodeChatServiceSelection(vprOption.value);
      if (selected.id.length > 0) {
        return selectionForCurrentRoute(selected);
      }
    }

    const selectedValue = decodeChatServiceSelection(uiState.chatSelectedServiceValue);
    if (selectedValue.id.length > 0) {
      return selectionForCurrentRoute(selectedValue);
    }

    if (uiState.chatServiceOptions.length > 0) {
      const firstOption = decodeChatServiceSelection(uiState.chatServiceOptions[0].value);
      if (firstOption.id.length > 0) {
        const selection = {
          ...firstOption,
          peerId: firstOption.peerId ?? uiState.chatServiceOptions[0].peerId,
        };
        return selectionForCurrentRoute(selection);
      }
    }

    return { id: '', provider: null };
  }

  function applyChatServiceOptions(entries: NormalizedChatServiceEntry[]): void {
    const currentSelection = decodeChatServiceSelection(uiState.chatSelectedServiceValue);
    const activeConversationModel = normalizeChatServiceId(activeConversation?.service);
    const activeConversationProvider = normalizeProviderId(activeConversation?.provider);

    const unique = new Map<string, NormalizedChatServiceEntry>();
    for (const entry of entries) {
      const key = `${entry.peerId || entry.provider}${CHAT_SERVICE_SELECTION_SEPARATOR}${entry.id}`;
      if (!entry.id || unique.has(key)) continue;
      unique.set(key, entry);
    }

    const options = Array.from(unique.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.id.localeCompare(b.id);
    });

    const optionCandidates: ChatServiceOption[] = options.map((entry) => ({
      id: entry.id,
      provider: normalizeProviderId(entry.provider),
      peerId: entry.peerId || undefined,
      label: entry.label,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
    }));

    const activeConversationPeerId = activeConversation?.peerId?.trim() ?? '';
    const hasActiveConversation = Boolean(activeConversation?.id);

    // Resolve the preferred selection. The first-available-option fallback
    // (`optionCandidates[0]?.value`) is ONLY safe for the new-chat landing
    // page — silently rebinding an active conversation to whatever happens
    // to sort first in the catalog has catastrophic consequences:
    // `chatSelectedPeerId` and `preferredPeerByConversationId` in main stay
    // pinned to the conversation's original peer, so the outbound request
    // ends up with pin-peer=<originalPeer> + service=<unrelated peer's
    // service>, which the buyer proxy rejects with "Service strict-miss" in
    // a permanent 502 loop. This is the exact flip that turned a kimi-k2.6
    // chat into a chaotic-pm chat when the original peer's metadata briefly
    // dropped its service on re-hydration.
    const firstOptionFallback = hasActiveConversation ? null : (optionCandidates[0]?.value ?? null);
    const preferred =
      findMatchingChatServiceOptionValue(
        optionCandidates,
        currentSelection.id,
        currentSelection.provider,
        currentSelection.peerId,
      )
      ?? findMatchingChatServiceOptionValue(
        optionCandidates,
        activeConversationModel,
        activeConversationProvider,
        activeConversationPeerId,
      )
      ?? firstOptionFallback;

    const nextSignature = computeServiceOptionsSignature(options);
    if (
      nextSignature === lastServiceOptionsSignature
      && (preferred === null || uiState.chatSelectedServiceValue === preferred)
    ) {
      return;
    }

    if (options.length === 0) {
      uiState.chatServiceOptions = [];
      // Preserve the chat's pinned (service, peer) across a transient empty
      // catalog. Clearing here would otherwise force the next refresh into
      // the first-option fallback when options reappear, re-opening the
      // silent-rebind hole above.
      if (!hasActiveConversation) {
        uiState.chatSelectedServiceValue = '';
      }
      lastServiceOptionsSignature = '';
      notifyUiStateChanged();
      return;
    }

    uiState.chatServiceOptions = options.map((entry) => ({
      id: entry.id,
      label: entry.label,
      provider: entry.provider,
      protocol: entry.protocol,
      count: entry.count,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
      peerId: entry.peerId,
      peerDisplayName: entry.peerDisplayName,
      peerLabel: entry.peerLabel,
      peerIconUrl: null,
      inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion,
      categories: entry.categories,
      description: entry.description,
    }));

    if (preferred !== null) {
      uiState.chatSelectedServiceValue = preferred;
    }
    // When `preferred === null` (active conversation whose (service, peer)
    // pair is temporarily missing from the catalog), we intentionally leave
    // `chatSelectedServiceValue` as-is. The dropdown shows the refreshed
    // option list; the chat stays bound to its original service until the
    // user explicitly switches via `handleServiceChange`, and any send that
    // reaches the proxy in the meantime surfaces a real error instead of
    // silently retargeting a different peer's service.
    lastServiceOptionsSignature = nextSignature;
    notifyUiStateChanged();
  }

  /**
   * Re-derive everything gated by the peer allow/block rules from the last
   * discovery snapshot: the routable rows, the model catalog and the chat
   * service list. Called whenever a rule changes so excluded sellers — and the
   * models only they offer — disappear immediately instead of lingering until
   * the next discovery refresh.
   */
  function freeEntryRouteReputation(entry: VprModelCatalogEntry): number | null {
    return bestFreeVprRouteReputation(
      routesForSelectedModel(uiState.vprRoutableRows, entry),
      uiState.vprRoutingPreferences,
    );
  }

  // The auto-picked default model, while it is only provisional: not backed by
  // an eligible free route. First-launch discovery snapshots are cold — DHT
  // discovery is partial and on-chain reputation hasn't been fetched yet, so
  // every free seller fails the trust gate and the default pick falls back to
  // a paid model. Persisting that pick would lock a brand-new user onto a paid
  // default forever, so a provisional pick is kept in memory only and
  // re-evaluated on every refresh until a free-backed default appears or the
  // user chooses a model explicitly.
  let provisionalDefaultModel: VprSelectedModel | null = null;

  /** Keep the UI's "finding free peers" hint in step with the provisional pick. */
  function setProvisionalDefaultModel(model: VprSelectedModel | null): void {
    provisionalDefaultModel = model;
    uiState.vprDefaultModelProvisional = model !== null;
  }

  /**
   * An explicit model choice ends the provisional-default window — even when
   * it lands on the very model the provisional default chose. For selection
   * paths outside this module (the model page's "Use" button) that must stop
   * the refresh loop from re-picking over the user's choice.
   */
  function endProvisionalDefaultModel(): void {
    setProvisionalDefaultModel(null);
  }

  /**
   * Pick the default model and adopt it into the route selection. Free-backed
   * picks are final (persisted); anything else is provisional (see above).
   * Returns the pick, or null when the catalog offers nothing to pick.
   */
  function adoptDefaultVprModel(): VprSelectedModel | null {
    const defaultModel = selectDefaultVprModel(uiState.vprModelCatalog, null, freeEntryRouteReputation);
    if (!defaultModel) return null;
    const entry = findCatalogEntry(uiState.vprModelCatalog, defaultModel.provider, defaultModel.serviceId);
    const freeBacked = entry !== null && freeEntryRouteReputation(entry) !== null;
    const current = uiState.vprRouteSelection;
    const changed = !current.model
      || current.model.provider !== defaultModel.provider
      || current.model.serviceId !== defaultModel.serviceId
      || current.mode !== 'auto'
      || current.peerId !== null;
    if (changed) {
      uiState.vprRouteSelection = { model: defaultModel, mode: 'auto', peerId: null };
    }
    if (freeBacked) {
      setProvisionalDefaultModel(null);
      saveVprRouteSelection(uiState.vprRouteSelection);
    } else {
      setProvisionalDefaultModel(defaultModel);
    }
    return defaultModel;
  }

  // Catalog price tags must only come from sellers auto-routing may pick, so
  // an untrusted seller's $0 offer can't render a "Free" badge for a model
  // that would really route (and bill) through a trusted paid seller.
  function isPricingRowEligible(row: DiscoverRow): boolean {
    return isRouteEligibleForAutoSelection(row, uiState.vprRoutingPreferences);
  }

  function applyPeerAccessRules(): void {
    uiState.vprRoutableRows = filterRoutableVprRoutes(
      uiState.discoverRows,
      uiState.vprRoutingPreferences,
    );
    uiState.vprModelCatalog = applyOpenRouterBaselines(
      projectRowsToVprModelCatalog(uiState.vprRoutableRows, isPricingRowEligible),
      getCachedOpenRouterPrices(),
    );

    // The selected model may only have been offered by a seller the new rules
    // exclude — leaving it selected would strand every send with no route.
    const selected = uiState.vprRouteSelection.model;
    if (selected && routesForSelectedModel(uiState.vprRoutableRows, selected).length === 0) {
      if (!adoptDefaultVprModel()) {
        uiState.vprRouteSelection = { model: null, mode: 'auto', peerId: null };
        saveVprRouteSelection(uiState.vprRouteSelection);
      }
    }

    updateChatServiceOptions(projectRowsToChatServiceOptions(uiState.vprRoutableRows));
    notifyUiStateChanged();
  }

  function updateChatServiceOptions(entries: NormalizedChatServiceEntry[]): void {
    if (serviceSelectFocused) {
      pendingServiceOptions = entries;
      return;
    }
    applyChatServiceOptions(entries);
  }

  async function listChatServicesWithTimeout(
    refreshToken: number,
  ): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    if (!bridge?.chatAiListDiscoverRows) {
      return { ok: false, data: [], error: 'Service catalog bridge unavailable' };
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<{
        ok: boolean;
        data?: unknown[];
        error?: string;
      }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            ok: false,
            data: [],
            error: `Service discovery timed out after ${String(CHAT_SERVICE_LIST_TIMEOUT_MS)}ms`,
          });
        }, CHAT_SERVICE_LIST_TIMEOUT_MS);
      });

      const result = await Promise.race([bridge.chatAiListDiscoverRows(), timeoutPromise]);

      if (refreshToken !== serviceRefreshToken) {
        return { ok: false, data: [], error: 'stale service refresh' };
      }
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // Service-discovery failures (notably the 12s IPC timeout above) used to be
  // invisible in exported logs — the runtime looked healthy while the model
  // list stayed empty. Log the first failure, then one summary per minute,
  // plus the recovery, so a log export tells the story.
  let discoverFailureStreak = 0;
  let discoverFailureLogAt = 0;
  function noteDiscoverFailure(message: string): void {
    discoverFailureStreak += 1;
    const now = Date.now();
    if (discoverFailureStreak === 1 || now - discoverFailureLogAt >= 60_000) {
      discoverFailureLogAt = now;
      appendSystemLog(discoverFailureStreak === 1
        ? `Service discovery failed: ${message}`
        : `Service discovery still failing (${String(discoverFailureStreak)} consecutive): ${message}`);
    }
  }
  function noteDiscoverSuccess(rowCount: number): void {
    if (discoverFailureStreak === 0) return;
    appendSystemLog(`Service discovery recovered after ${String(discoverFailureStreak)} failure(s): ${String(rowCount)} row(s)`);
    discoverFailureStreak = 0;
    discoverFailureLogAt = 0;
  }

  async function refreshChatServiceOptions(): Promise<void> {
    // Skip if a fetch is already in-flight — the 30s timeout outlasts the 5s poll
    // cycle, so without this guard every result gets a stale token and is dropped.
    if (serviceRefreshInProgress) return;
    serviceRefreshInProgress = true;

    const refreshToken = ++serviceRefreshToken;
    const fallback = fallbackChatServices.map((entry) => ({ ...entry }));

    if (!bridge?.chatAiListDiscoverRows) {
      uiState.chatDiscoverRowsLoaded = false;
      updateChatServiceOptions(fallback);
      setRuntimeActivity('warn', 'Service catalog unavailable (bridge missing).');
      serviceRefreshInProgress = false;
      return;
    }

    setRuntimeActivity('warn', 'Loading service catalog from peers...');
    setServiceSelectLoading(true);
    try {
      const result = await listChatServicesWithTimeout(refreshToken);
      if (refreshToken !== serviceRefreshToken) return;

      if (!result.ok || !Array.isArray(result.data)) {
        uiState.chatDiscoverRowsLoaded = false;
        updateChatServiceOptions(fallback);
        noteDiscoverFailure(result.error || 'Service catalog unavailable.');
        setRuntimeActivity('warn', result.error || 'Service catalog unavailable.');
        notifyUiStateChanged();
        return;
      }

      const rawRows = Array.isArray(result.data) ? result.data : [];
      const rows = rawRows
        .map((raw) => normalizeDiscoverRow(raw))
        .filter((row): row is DiscoverRow => row !== null);
      uiState.discoverRows = rows;
      uiState.vprRoutableRows = filterRoutableVprRoutes(rows, uiState.vprRoutingPreferences);
      uiState.chatDiscoverRowsLoaded = true;
      noteDiscoverSuccess(rows.length);
      // Guard on the raw discovery result, not the projection: an allowlist
      // that excludes every discovered seller must empty the catalog, while a
      // transient empty discovery snapshot must leave the last one standing.
      if (rows.length > 0 || uiState.vprModelCatalog.length === 0) {
        uiState.vprModelCatalog = applyOpenRouterBaselines(
          projectRowsToVprModelCatalog(uiState.vprRoutableRows, isPricingRowEligible),
          getCachedOpenRouterPrices(),
        );
      }
      // Warm the OpenRouter reference-price cache in the background; once it
      // resolves, re-stamp baselines onto the current catalog so the Home
      // "Popular" list can show the struck-through retail price.
      void ensureOpenRouterPrices().then((map) => {
        if (!map) return;
        uiState.vprModelCatalog = applyOpenRouterBaselines(uiState.vprModelCatalog, map);
        notifyUiStateChanged();
      });
      // Only auto-fill an empty selection. A user-chosen model that is briefly
      // missing from a partial discover snapshot (peer flap, partial DHT
      // results) must not be silently replaced — it resolves again as soon as
      // its peer reappears in the catalog. A provisional default (auto-picked
      // with no eligible free route in sight yet) is the one exception: it
      // keeps being re-picked so the first-launch experience upgrades to a
      // free model as soon as discovery and reputation warm up.
      const selectedRouteModel = uiState.vprRouteSelection.model;
      const selectedRouteEntry = selectedRouteModel
        ? findCatalogEntry(uiState.vprModelCatalog, selectedRouteModel.provider, selectedRouteModel.serviceId)
        : null;
      if (provisionalDefaultModel && (!selectedRouteModel
        || selectedRouteModel.provider !== provisionalDefaultModel.provider
        || selectedRouteModel.serviceId !== provisionalDefaultModel.serviceId
        || uiState.vprRouteSelection.mode !== 'auto'
        || uiState.vprRouteSelection.peerId !== null)) {
        // The selection moved off the provisional pick — a different model, or
        // the same model deliberately pinned to a seller. Either way that was
        // an explicit choice (or a rules-driven re-pick); stop second-guessing
        // it — re-picking here would flatten a pin back to auto.
        setProvisionalDefaultModel(null);
      }
      if (!selectedRouteModel || selectedRouteEntry?.kind === 'image' || provisionalDefaultModel !== null) {
        adoptDefaultVprModel();
      }
      // Keep the buyer proxy's default route on the current selection. Runs
      // on every poll tick, but main dedupes repeats — the repetition is what
      // lands the route once the buyer proxy finishes starting.
      void syncBuyerDefaultRoute(bridge, uiState);
      const optionsToRender = rows.length > 0
        ? projectRowsToChatServiceOptions(uiState.vprRoutableRows)
        : fallback;
      updateChatServiceOptions(optionsToRender);
      setRuntimeActivity(
        optionsToRender.length > 0 ? 'active' : 'warn',
        optionsToRender.length > 0
          ? `Service catalog ready (${String(optionsToRender.length)} services)`
          : 'Discovering services',
      );
    } catch (error) {
      if (refreshToken !== serviceRefreshToken) return;
      uiState.chatDiscoverRowsLoaded = false;
      updateChatServiceOptions(fallback);
      const message = toErrorMessage(error, 'Failed to load services');
      noteDiscoverFailure(message);
      setRuntimeActivity('bad', message);
    } finally {
      serviceRefreshInProgress = false;
      if (refreshToken === serviceRefreshToken) {
        setServiceSelectLoading(false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy status
  // ---------------------------------------------------------------------------

  // Re-probe timer used while the runtime process is up but the proxy port
  // is not answering yet (startup) — the 5s poll is too slow for the power
  // button / status strip to feel responsive.
  let proxyStartupProbeTimer: ReturnType<typeof setTimeout> | null = null;

  function setProxyOnline(online: boolean): void {
    uiState.chatProxyOnline = online;
    uiState.connectBadge = deriveConnectBadge(uiState.processes, online);
    const connectRunning = uiState.processes.some((process) => process.mode === 'connect' && process.running === true);
    if (proxyStartupProbeTimer) {
      clearTimeout(proxyStartupProbeTimer);
      proxyStartupProbeTimer = null;
    }
    if (!online && connectRunning) {
      proxyStartupProbeTimer = setTimeout(() => {
        proxyStartupProbeTimer = null;
        void refreshChatProxyStatus();
      }, PROXY_STARTUP_PROBE_INTERVAL_MS);
    }
  }

  async function refreshChatProxyStatus(): Promise<void> {
    const previousProxyState = proxyState;
    if (!bridge || !bridge.chatAiGetProxyStatus) {
      proxyState = 'unknown';
      proxyPort = 0;
      setProxyOnline(false);
      notifyUiStateChanged();
      updateStreamingIndicator();
      return;
    }

    try {
      const result = await bridge.chatAiGetProxyStatus();
      if (result.ok && result.data) {
        const { running, port } = result.data;
        if (running) {
          proxyState = 'online';
          proxyPort = Number(port) || 0;
          uiState.chatProxyPort = proxyPort;
          setProxyOnline(true);
          notifyUiStateChanged();
          // Proxy just became available — fetch metering stats for active conversation
          if (activeConversation) {
            const peerId = resolveConversationPeerId(activeConversation);
            if (peerId) debouncedFetchMeteringStats(peerId);
          }
          if (previousProxyState !== 'online') {
            setRuntimeActivity(
              'active',
              `Buyer proxy online on :${String(proxyPort || port)}.`,
            );
          }
        } else {
          proxyState = 'offline';
          proxyPort = 0;
          uiState.chatProxyPort = 0;
          setProxyOnline(false);
          notifyUiStateChanged();
          if (previousProxyState !== 'offline') {
            setRuntimeActivity('warn', 'Waiting for runtime.');
          }
        }
      }
    } catch {
      proxyState = 'offline';
      proxyPort = 0;
      uiState.chatProxyPort = 0;
      setProxyOnline(false);
      notifyUiStateChanged();
      if (previousProxyState !== 'offline') {
        setRuntimeActivity('warn', 'Buyer proxy unreachable; retrying.');
      }
    } finally {
      const now = Date.now();
      const setupMode = uiState.appSetupComplete && uiState.chatServiceOptions.length === 0;
      const refreshInterval = setupMode
        ? CHAT_SERVICE_SETUP_REFRESH_INTERVAL_MS
        : CHAT_SERVICE_REFRESH_INTERVAL_MS;
      const shouldRefreshModels =
        proxyState === 'online' &&
        (previousProxyState !== 'online' ||
          now - lastServiceRefreshAt >= refreshInterval);
      if (shouldRefreshModels) {
        lastServiceRefreshAt = now;
        void refreshChatServiceOptions();
      }
      updateStreamingIndicator();
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation management
  // ---------------------------------------------------------------------------

  function syncActiveConversationSummary(
    conversations: ChatConversationSummary[],
  ): void {
    const activeId = getActiveConversationId();
    if (!activeId) return;

    const activeSummary = conversations.find((c) => c.id === activeId);
    if (!activeSummary) return;

    activeConversation = {
      ...(activeConversation || {}),
      ...activeSummary,
      messages: activeConversation?.messages || [],
    };
    updateThreadMeta(activeConversation);
  }

  async function refreshChatConversations(): Promise<void> {
    if (!bridge || !bridge.chatAiListConversations) return;

    try {
      const result = await bridge.chatAiListConversations();
      if (result.ok) {
        const conversations = Array.isArray(result.data)
          ? (result.data as ChatConversationSummary[])
          : [];
        uiState.chatConversations = conversations;
        syncActiveConversationSummary(conversations);
        notifyUiStateChanged();
      }
    } catch {
      // Chat unavailable
    } finally {
      uiState.chatConversationsLoaded = true;
      updateStreamingIndicator();
    }
  }

  let chatConversationsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesce the stream-event refreshers: assistant-done, title-updated and
      stream-completed can fire in quick bursts, and each refresh re-lists
      every conversation over IPC. Trailing-edge only, without resetting on
      repeat events, so a long stream still refreshes at a steady cadence. */
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
        // A newer conversation/manual workspace selection won the race. The IPC
        // call above may still have persisted this stale workspace in main, so
        // re-apply the latest requested workspace to keep main and the UI aligned.
        const latestWorkspacePath = desiredWorkspacePath;
        if (latestWorkspacePath && latestWorkspacePath !== workspacePath) {
          void restoreWorkspace(latestWorkspacePath);
        }
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
      if (token === workspaceSwitchToken) {
        desiredWorkspacePath = uiState.chatWorkspacePath || null;
      }
      // Silently fail — the user can still manually set the workspace
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (!bridge?.pickDirectory || !bridge.chatAiSetWorkspace) return;

    try {
      const picked = await bridge.pickDirectory();
      if (!picked.ok || !picked.path) {
        return;
      }

      const token = ++workspaceSwitchToken;
      desiredWorkspacePath = picked.path;
      const result = await bridge.chatAiSetWorkspace(picked.path);
      if (!result.ok || !result.data) {
        if (token === workspaceSwitchToken) {
          desiredWorkspacePath = uiState.chatWorkspacePath || null;
        }
        showChatError(result.error || 'Failed to set workspace');
        return;
      }
      if (token !== workspaceSwitchToken) {
        return;
      }

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

  async function openConversation(convId: string): Promise<void> {
    if (!bridge || !bridge.chatAiGetConversation) return;

    const workspacePathAtOpen = uiState.chatWorkspacePath;

    uiState.chatActiveConversation = convId;
    uiState.chatOpeningConversationId = convId;
    uiState.chatRoutedPeerId = '';
    uiState.chatSelectedPeerId = '';
    uiState.chatSessionStarted = '';
    uiState.chatSessionReservedUsdc = '';
    uiState.chatSessionAccumulatedCostUsd = '';
    uiState.chatSessionTotalTokens = '';
    uiState.chatLifetimeSpentUsdc = '';
    uiState.chatLifetimeTotalTokens = '';
    uiState.chatLifetimeSessions = '';
    clearTransientChatNotices();
    notifyUiStateChanged();

    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (result.ok && result.data) {
        const conv = result.data as ChatConversation;
        const serverMessages = normalizeInlineThinkInMessages(
          Array.isArray(conv.messages) ? conv.messages : [],
        );
        const shouldPreferLocalMessages =
          hasConversationStreamingMessage(convId) || isConversationSending(convId);
        const nextMessages =
          shouldPreferLocalMessages
            ? (getLocalConversationMessages(convId) ?? serverMessages)
            : serverMessages;
        activeConversation = {
          ...conv,
          messages: nextMessages,
        };
        uiState.chatMessages = nextMessages;
        uiState.chatStreamingMessage = getConversationStreamingMessage(convId);
        syncActiveConversationSendingState();

        const optionCandidates = getAvailableChatServiceOptions();
        const convPeerIdForMatch = conv.peerId?.trim() ?? '';
        const preferredValue = findMatchingChatServiceOptionValue(
          optionCandidates,
          conv.service,
          conv.provider,
          convPeerIdForMatch,
        );
        if (preferredValue) {
          uiState.chatSelectedServiceValue = preferredValue;
          const matchedOption = optionCandidates.find((o) => o.value === preferredValue);
          if (matchedOption?.peerId) {
            uiState.chatSelectedPeerId = matchedOption.peerId;
          }
        }
        if (!uiState.chatSelectedPeerId && convPeerIdForMatch) {
          uiState.chatSelectedPeerId = convPeerIdForMatch;
        }

        setLocalConversationMessages(convId, uiState.chatMessages as ChatMessage[]);
        updateThreadMeta(activeConversation);
        clearTransientChatNotices();
        uiState.chatOpeningConversationId = null;
        void refreshChatPermissionModeForPeer(resolveConversationPeerId(activeConversation));
        notifyUiStateChanged();

        const convWorkspacePath = conv.workspacePath;
        if (
          typeof convWorkspacePath === 'string' &&
          convWorkspacePath.length > 0 &&
          convWorkspacePath !== workspacePathAtOpen
        ) {
          void restoreWorkspace(convWorkspacePath);
        }

        const peerId = resolveConversationPeerId(activeConversation);
        if (peerId) debouncedFetchMeteringStats(peerId);
      } else {
        uiState.chatOpeningConversationId = null;
        reportChatError(result.error, 'Failed to open conversation');
      }
    } catch (err) {
      uiState.chatOpeningConversationId = null;
      reportChatError(err, 'Failed to open conversation');
    }
  }

  function startNewChat(): void {
    newChatDraftVersion += 1;
    uiState.chatActiveConversation = null;
    uiState.chatOpeningConversationId = null;
    uiState.chatMessages = [];
    setStreamingMessage(null);
    activeConversation = null;
    clearTransientChatNotices();
    // Re-derive sending flags from the (now null) active conversation so that
    // the thinking indicator does not leak in from whichever chat the user was
    // previously viewing while it was still streaming. Without this, the
    // stale chatSending=true / chatSendingConversationId values would make
    // ChatView's activeConversationIsSending fall back to chatSending and
    // render the WalkingAnt inside the empty new-chat screen.
    syncActiveConversationSendingState();
    updateThreadMeta(null);
    void refreshChatPermissionModeForPeer();
    notifyUiStateChanged();
  }

  function materializeStreamingMessage(message: ChatMessage | null): ChatMessage | null {
    const current = message;
    if (!current) return null;
    const cloned = cloneStreamingMessage(current);
    // Strip synthetic renderKeys and IDs (e.g. "stream-text-0", "text-0") so that
    // when multiple turns get merged by buildDisplayMessages, getBlockRenderKey
    // falls back to the array-position index and avoids duplicate-key warnings.
    // Also drop transient inline-think bookkeeping so persisted messages don't
    // carry streaming-only markers.
    if (Array.isArray(cloned.content)) {
      for (const block of cloned.content as ContentBlock[]) {
        delete block.renderKey;
        if (typeof block.id === 'string' && /^(text|thinking)-[\d-]+$/.test(block.id)) {
          delete block.id;
        }
        if (block.details && typeof block.details === 'object') {
          const details = block.details as Record<string, unknown>;
          delete details.inlineThinkFor;
          if (Object.keys(details).length === 0) delete block.details;
        }
      }
    }
    return cloned;
  }

  // Move any leading <think>...[</think>] segment out of a text block and
  // into an adjacent thinking block. Handles the streaming case (no closing
  // tag yet — keeps accumulating into a streaming thinking block) and the
  // non-streaming case (fully-closed segment present in the committed text).
  // Used by both the per-delta path and the final commit path so models like
  // DeepSeek / Qwen that emit thinking as inline XML render correctly.
  function syncInlineThink(blocks: ContentBlock[], textBlock: ContentBlock): void {
    const CLOSE_TAG = '</think>';
    const OPEN_TAG = '<think>';

    // If we've already opened an inline <think> for this text block, any
    // text sitting on the text block was streamed in after that opening and
    // still belongs to the thinking buffer. Migrate it over and scan for the
    // closing tag.
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

    // No inline <think> open yet — see if the text block just grew into one.
    const raw = String(textBlock.text || '');
    if (!raw.startsWith(OPEN_TAG)) return;
    const body = raw.slice(OPEN_TAG.length);
    const closeIdx = body.indexOf(CLOSE_TAG);
    const thinkingBlock = createInlineThinkingBlock(blocks, textBlock);
    if (closeIdx === -1) {
      thinkingBlock.thinking = body;
      thinkingBlock.streaming = true;
      textBlock.text = '';
    } else {
      thinkingBlock.thinking = body.slice(0, closeIdx).trim();
      thinkingBlock.streaming = false;
      textBlock.text = body.slice(closeIdx + CLOSE_TAG.length).replace(/^\s*/, '');
    }
  }

  function findOpenInlineThink(
    blocks: ContentBlock[],
    textBlock: ContentBlock,
  ): ContentBlock | undefined {
    const textIdx = blocks.indexOf(textBlock);
    const prev = textIdx > 0 ? blocks[textIdx - 1] : undefined;
    if (
      prev &&
      prev.type === 'thinking' &&
      prev.streaming &&
      prev.details &&
      (prev.details as Record<string, unknown>).inlineThinkFor === textBlock.renderKey
    ) {
      return prev;
    }
    return undefined;
  }

  function createInlineThinkingBlock(
    blocks: ContentBlock[],
    textBlock: ContentBlock,
  ): ContentBlock {
    const textIdx = blocks.indexOf(textBlock);
    const thinkingBlock: ContentBlock = {
      type: 'thinking',
      thinking: '',
      streaming: true,
      details: { inlineThinkFor: textBlock.renderKey },
    };
    const insertAt = textIdx >= 0 ? textIdx : blocks.length;
    blocks.splice(insertAt, 0, thinkingBlock);
    return thinkingBlock;
  }

  // Run syncInlineThink across every text block in a committed message so the
  // non-streaming path (onChatAiDone) gets the same treatment as streaming.
  // Any inline thinking blocks left open (missing </think>) are finalized.
  function extractInlineThinkBlocks(blocks: ContentBlock[]): void {
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block?.type === 'text') syncInlineThink(blocks, block);
    }
    for (const block of blocks) {
      if (
        block?.type === 'thinking' &&
        block.details &&
        (block.details as Record<string, unknown>).inlineThinkFor !== undefined
      ) {
        block.streaming = false;
      }
    }
  }

  // Apply inline-think extraction across every assistant message in a list.
  // Used when messages are loaded from disk (via chatAiGetConversation) and
  // may still contain raw '<think>...</think>' inside text blocks because the
  // response was persisted before we extracted it.
  function normalizeInlineThinkInMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        return message;
      }
      const content = (message.content as ContentBlock[]).map((b) => ({ ...b }));
      extractInlineThinkBlocks(content);
      return { ...message, content };
    });
  }

  function commitAssistantMessage(message: ChatMessage): void {
    if (Array.isArray(message?.content)) {
      extractInlineThinkBlocks(message.content as ContentBlock[]);
    }
    const assistantMessage = {
      ...message,
      createdAt: message?.createdAt || Date.now(),
    };
    uiState.chatMessages = [...uiState.chatMessages, assistantMessage];
    if (uiState.chatActiveConversation) {
      setLocalConversationMessages(
        uiState.chatActiveConversation,
        uiState.chatMessages as ChatMessage[],
      );
    }
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Number(assistantMessage.createdAt) || Date.now();
      updateThreadMeta(activeConversation);
      const peerId = resolveConversationPeerId(activeConversation);
      if (peerId) debouncedFetchMeteringStats(peerId);
    }
  }

  function appendAssistantMessageToConversation(convId: string, message: ChatMessage): void {
    if (Array.isArray(message?.content)) {
      extractInlineThinkBlocks(message.content as ContentBlock[]);
    }
    const assistantMessage = {
      ...message,
      createdAt: message?.createdAt || Date.now(),
    };
    const existingMessages = getLocalConversationMessages(convId) ?? [];
    setLocalConversationMessages(convId, [...existingMessages, assistantMessage]);
  }

  async function createConversationForSelection(
    selection: ChatServiceSelection,
    options: { activate: boolean } = { activate: true },
  ): Promise<string | null> {
    if (!bridge || !bridge.chatAiCreateConversation) return null;

    if (selection.id.length === 0) {
      showChatError(
        'No service is currently available. Start Buyer runtime and refresh services.',
      );
      return null;
    }

    try {
      // Record how this thread's peer was chosen: a pinned thread must keep its
      // peer forever, while an auto thread may be re-routed if the peer dies.
      const routeMode = uiState.vprRouteSelection.mode === 'pinned-peer' ? 'pinned' : 'auto';
      const peerId = routeMode === 'pinned'
        ? (selection.peerId ?? uiState.chatSelectedPeerId) || undefined
        : undefined;
      const result = await bridge.chatAiCreateConversation(
        selection.id,
        selection.provider ?? undefined,
        peerId,
        routeMode,
      );
      if (result.ok && result.data) {
        const conversationId = getConversationId(result.data);
        if (!conversationId) {
          throw new Error('Conversation created but ID is missing');
        }
        await refreshChatConversations();
        if (options.activate) {
          await openConversation(conversationId);
        }
        clearChatError();
        return conversationId;
      }
      reportChatError(result.error, 'Failed to create conversation');
    } catch (err) {
      reportChatError(err, 'Failed to create conversation');
    }
    return null;
  }

  async function createNewConversation(): Promise<void> {
    await createConversationForSelection(getSelectedChatServiceSelection(), { activate: true });
  }

  async function deleteConversation(targetId?: string): Promise<void> {
    const convId = targetId || uiState.chatActiveConversation;
    if (!convId || !bridge || !bridge.chatAiDeleteConversation) return;

    const previousConversations = Array.isArray(uiState.chatConversations)
      ? [...uiState.chatConversations]
      : [];
    const nextConversations = previousConversations.filter((conv) => {
      const candidate = conv as ChatConversationSummary;
      return candidate.id !== convId;
    });
    if (nextConversations.length !== previousConversations.length) {
      uiState.chatConversations = nextConversations;
    }
    localConversationMessages.delete(convId);
    streamingMessagesByConversation.delete(convId);
    sendingConversationIds.delete(convId);
    streamTurnsByConversation.delete(convId);
    streamStartedAtByConversation.delete(convId);
    // Publish the updated sending set (and resync active-conv UI) before we
    // potentially reset to new-chat state. This covers both the active and
    // non-active delete paths.
    syncActiveConversationSendingState();

    // If we deleted the active conversation, reset to new-chat state immediately
    // so the UI does not wait on IPC, storage, or attachment cleanup.
    if (convId === uiState.chatActiveConversation) {
      startNewChat();
    } else {
      notifyUiStateChanged();
    }

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
    const conversations = Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[])
      : [];
    const conv = conversations.find((c) => c.id === convId);
    if (conv) {
      conv.title = newTitle;
      uiState.chatConversations = [...conversations];
    }
    notifyUiStateChanged();
    if (bridge?.chatAiRenameConversation) {
      void bridge.chatAiRenameConversation(convId, newTitle).catch((err: unknown) => {
        appendSystemLog(`Failed to persist conversation rename: ${String(err)}`);
      });
    }
  }

  function isInProgressErrorMessage(message: unknown): boolean {
    return String(message ?? '')
      .toLowerCase()
      .includes('already in progress');
  }

  function buildUserMessageContent(text: string, attachments: PreparedChatAttachment[]): unknown {
    const blocks: ContentBlock[] = [];
    if (text.length > 0) {
      blocks.push({ type: 'text', text });
    }
    for (const attachment of attachments) {
      blocks.push({
        type: 'file',
        fileName: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        status: attachment.status,
        error: attachment.error,
        truncated: attachment.truncated,
        // Carry the stable disk-store ID onto the block so the renderer
        // can later open a native preview via `antseed-attachment://`.
        ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
        attachment,
      });
      if (attachment.kind === 'image' && attachment.image?.data && attachment.image.mimeType) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.image.mimeType, data: attachment.image.data },
        });
      }
    }
    return blocks.length > 0 ? blocks : text;
  }

  async function prepareAttachmentsForSend(
    conversationId: string,
    rawAttachments: RawChatAttachment[] | undefined,
  ): Promise<PreparedChatAttachment[]> {
    if (!rawAttachments?.length) return [];
    const activeBridge = bridge;
    if (!activeBridge?.chatPrepareAttachments) {
      throw new Error('Attachment preparation is not available in this desktop build.');
    }
    const result = await activeBridge.chatPrepareAttachments(conversationId, rawAttachments);
    if (!result.ok) {
      throw new Error(result.error || 'Attachment preparation failed');
    }
    return result.data ?? [];
  }

  function sendMessage(text: string, rawAttachments?: RawChatAttachment[]): void {
    if (!bridge) return;

    // Payment gate for paid services
    // Payment is handled by the node's 402-based flow — no pre-blocking here.
    // If the seller requires payment, the node returns a 402 with payment info.

    const content = text.trim();
    if (content.length === 0 && !rawAttachments?.length) return;

    // If no active conversation, create one first then send. Capture the
    // draft's service/peer now: the user may immediately go back to Discover
    // and choose another peer before this conversation finishes creating.
    if (!uiState.chatActiveConversation) {
      const draftVersion = newChatDraftVersion;
      const selection = getSelectedChatServiceSelection();
      setChatSending(true);
      void (async () => {
        const convId = await createConversationForSelection(selection, { activate: false });
        setChatSending(false);
        if (convId) {
          if (draftVersion === newChatDraftVersion) {
            await openConversation(convId);
          }
          sendMessageToConversation(convId, text, rawAttachments, selection);
        } else {
          showChatError('Failed to create a conversation. Please try again.');
        }
      })();
      return;
    }

    sendMessageToConversation(uiState.chatActiveConversation, text, rawAttachments);
  }

  function sendMessageToConversation(
    convId: string,
    text: string,
    rawAttachments?: RawChatAttachment[],
    selectionOverride?: ChatServiceSelection,
  ): void {
    if (isConversationSending(convId)) {
      showChatError('This conversation already has a request in progress.');
      return;
    }

    const content = text.trim();
    // Build message content — multipart with prepared attachments, or plain string
    uiState.chatError = null;
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

      // Multimodal gate — if the user attached image(s) but the current
      // service isn't tagged `multimodal` in the catalog, the main side
      // drops images while still sending text/docs. Warn, but do not block,
      // so prompt text is never discarded at send-time.
      const hasReadyImage = preparedAttachments.some(
        (attachment) => attachment.kind === 'image' && attachment.status === 'ready',
      );
      if (hasReadyImage) {
        const currentOption = uiState.chatServiceOptions.find(
          (opt) => opt.value === uiState.chatSelectedServiceValue,
        );
        const supportsMultimodal = currentOption?.categories?.includes('multimodal') ?? false;
        if (!supportsMultimodal) {
          const label = currentOption?.label || 'this service';
          showChatError(
            `${label} doesn't support images. Sending without image input for this turn.`,
          );
        }
      }

      const messageContent = buildUserMessageContent(content, preparedAttachments);
      const localMessages = getLocalConversationMessages(convId) ?? (
        convId === uiState.chatActiveConversation
          ? (uiState.chatMessages as ChatMessage[])
          : []
      );
      const nextMessages = [...localMessages, { role: 'user' as const, content: messageContent, createdAt: Date.now() }];
      setLocalConversationMessages(convId, nextMessages);
      if (convId === uiState.chatActiveConversation) {
        uiState.chatMessages = nextMessages;
      }
      if (activeConversation && activeConversation.id === convId) {
        activeConversation.messages = nextMessages;
        activeConversation.updatedAt = Date.now();
        updateThreadMeta(activeConversation);
      }
      notifyUiStateChanged();

      dispatchChatRequest(convId, content, preparedAttachments, selectionOverride);
    })();
  }

  /**
   * Shared send logic for both sendMessage and retryAfterPayment.
   * Dispatches via streaming or non-streaming bridge, handles stuck-request
   * recovery, payment-required errors, and fallback timeouts.
   */
  function resolveSelectedImageRoute({
    requiresImageInput = false,
    preferredPeerId = '',
  }: {
    requiresImageInput?: boolean;
    preferredPeerId?: string;
  } = {}): { service: string; peerId?: string; moderation?: 'low' } | null {
    const selection = uiState.chatImageRouteSelection;
    const model = selection?.model;
    if (!model) return null;
    const routes = routesForSelectedModel(uiState.vprRoutableRows, model)
      .filter((row) => row.protocol === 'openai-images');
    if (routes.length === 0) return null;
    if (selection.mode === 'pinned-peer' && selection.peerId) {
      const route = routes.find((row) => row.peerId === selection.peerId);
      if (!route || (requiresImageInput && !supportsImageEdits(route))) return null;
      return { service: route.serviceId, peerId: route.peerId, moderation: 'low' };
    }
    const eligibleRoutes = requiresImageInput ? routes.filter(supportsImageEdits) : routes;
    const moderationRoutes = eligibleRoutes.filter((row) => supportsServiceParameter(row, 'moderation'));
    // Prefer capability-compatible sellers for requests that resolve to one
    // concrete peer (image edits). If none advertise support, keep a route so
    // the buyer proxy can fail with its explicit required-capability error.
    const routingPool = moderationRoutes.length > 0 ? moderationRoutes : eligibleRoutes;
    const preferredRoute = routingPool.find((row) => row.peerId === preferredPeerId);
    const route = preferredRoute ?? chooseBestVprRoute(routingPool, uiState.vprRoutingPreferences);
    if (!route) return null;
    if (requiresImageInput) {
      return { service: route.serviceId, peerId: route.peerId, moderation: 'low' };
    }
    // Keep model-only routing for generation. The internal required-parameter
    // header makes the buyer proxy filter fallback candidates to sellers that
    // advertise moderation instead of silently dropping the field.
    return { service: model.serviceId, moderation: 'low' };
  }

  function generateImage(prompt: string): void {
    const content = prompt.trim();
    if (!content || !bridge?.chatGenerateImage) return;
    let route = resolveSelectedImageRoute();
    if (!route) {
      showChatError('No seller is currently available for this image model.');
      return;
    }

    void (async () => {
      let convId = uiState.chatActiveConversation;
      if (!convId) {
        const textSelection = getSelectedChatServiceSelection();
        if (!textSelection.id) {
          showChatError('Choose a text model before starting an image conversation.');
          return;
        }
        convId = await createConversationForSelection(textSelection, { activate: true });
      }
      if (!convId) return;
      if (isConversationSending(convId)) {
        showChatError('This conversation already has a request in progress.');
        return;
      }

      clearChatError();
      const optimisticUserMessage: ChatMessage = {
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      const existingBeforeRequest = getLocalConversationMessages(convId) ?? (
        convId === uiState.chatActiveConversation ? uiState.chatMessages as ChatMessage[] : []
      );
      let sourceImageAttachmentId = '';
      let sourceImagePeerId = '';
      let sourceImageServiceId = '';
      let editing = false;
      for (let messageIndex = existingBeforeRequest.length - 1; messageIndex >= 0 && !sourceImageAttachmentId; messageIndex -= 1) {
        const message = existingBeforeRequest[messageIndex];
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
        for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
          const block = message.content[blockIndex];
          if (block?.type === 'file' && block.generated === true && typeof block.attachmentId === 'string') {
            sourceImageAttachmentId = block.attachmentId.trim();
            sourceImagePeerId = typeof message.meta?.peerId === 'string' ? message.meta.peerId.trim() : '';
            sourceImageServiceId = typeof message.meta?.service === 'string' ? message.meta.service.trim() : '';
            break;
          }
        }
      }
      if (sourceImageAttachmentId) {
        const preferredPeerId = sourceImagePeerId && sameCanonicalModel(sourceImageServiceId, route.service)
          ? sourceImagePeerId
          : '';
        const editRoute = resolveSelectedImageRoute({ requiresImageInput: true, preferredPeerId });
        if (editRoute) {
          route = editRoute;
          editing = true;
        }
      }
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
      optimisticUserMessage.content = requestPrompt;
      const pendingMessages = [...existingBeforeRequest, optimisticUserMessage];
      setLocalConversationMessages(convId, pendingMessages);
      if (convId === uiState.chatActiveConversation) uiState.chatMessages = pendingMessages;
      if (activeConversation?.id === convId) {
        activeConversation.messages = pendingMessages;
        activeConversation.updatedAt = optimisticUserMessage.createdAt;
      }

      setConversationSending(convId, true);
      uiState.chatThinkingPhase = editing ? 'Editing image' : 'Generating image';
      notifyUiStateChanged();
      queueScrollChatToBottom();
      try {
        const result = await bridge.chatGenerateImage!({
          conversationId: convId,
          prompt: requestPrompt,
          service: route.service,
          ...(route.peerId ? { peerId: route.peerId } : {}),
          ...(route.moderation ? { moderation: route.moderation } : {}),
          ...(editing ? { sourceImageAttachmentId } : {}),
        });
        if (!result.ok || !result.user || !result.assistant) {
          throw new Error(result.error || 'Image generation failed.');
        }
        const responsePeerId = typeof result.assistant.meta?.peerId === 'string'
          ? result.assistant.meta.peerId.trim()
          : route.peerId ?? '';
        const existing = getLocalConversationMessages(convId) ?? pendingMessages;
        // The prompt was projected optimistically before the slow image call;
        // main persists that same user turn alongside the generated attachment.
        // Append only the returned assistant message to avoid a duplicate prompt.
        const messages = [...existing, result.assistant as ChatMessage];
        setLocalConversationMessages(convId, messages);
        if (convId === uiState.chatActiveConversation) uiState.chatMessages = messages;
        if (activeConversation?.id === convId) {
          activeConversation.messages = messages;
          activeConversation.updatedAt = Date.now();
          activeConversation.lastResponsePeerId = responsePeerId || undefined;
          updateThreadMeta(activeConversation);
        }
        if (Array.isArray(uiState.chatConversations)) {
          const summary = (uiState.chatConversations as ChatConversationSummary[])
            .find((conversation) => conversation.id === convId);
          if (summary) summary.lastResponsePeerId = responsePeerId || undefined;
        }
        scheduleChatConversationsRefresh();
        notifyUiStateChanged();
        queueScrollChatToBottom();
      } catch (error) {
        if (toErrorMessage(error) !== 'Request aborted') {
          reportChatError(error, 'Image generation failed');
        }
      } finally {
        setConversationSending(convId, false);
      }
    })();
  }

  function dispatchChatRequest(
    convId: string,
    content: string,
    attachments?: PreparedChatAttachment[],
    selectionOverride?: ChatServiceSelection,
  ): void {
    if (!bridge) return;

    const selection = selectionOverride ?? getConversationServiceSelection(convId);
    const requestStartedAt = Date.now();
    streamCompletedAtByConversation.delete(convId);
    streamFailedAtByConversation.delete(convId);

    if (!selection.id) {
      reportChatError('No service is selected for this conversation.', 'Request failed');
      setConversationSending(convId, false);
      return;
    }

    if (bridge.chatAiSendStream) {
      const sendStreamRequest = async () =>
        await bridge.chatAiSendStream!(
          convId,
          content || ' ',
          selection.id || undefined,
          selection.provider ?? undefined,
          attachments,
          selection.peerId,
          uiState.chatPermissionMode,
        );

      void (async () => {
        try {
          let result = await sendStreamRequest();
          if (
            !result.ok &&
            isInProgressErrorMessage(result.error) &&
            bridge.chatAiAbort
          ) {
            appendSystemLog(
              'Detected stuck in-flight chat request. Aborting and retrying once...',
            );
            await bridge.chatAiAbort(convId).catch(() => undefined);
            result = await sendStreamRequest();
          }

          if (!result.ok) {
            if (
              (streamCompletedAtByConversation.get(convId) ?? 0) >= requestStartedAt
              || (streamFailedAtByConversation.get(convId) ?? 0) >= requestStartedAt
            ) {
              clearPaymentRetry(convId);
              setConversationSending(convId, false);
              return;
            }

            const errorMsg = typeof result.error === 'string' ? result.error : '';
            const paymentMatch = /^payment_required:(\d+)$/i.exec(errorMsg);
            if (paymentMatch) {
              setConversationSending(convId, false);
              void handlePaymentRequired(paymentMatch[1], {
                convId,
                content,
                attachments,
                selection,
              });
            } else if (errorMsg === 'Request aborted') {
              // User-initiated abort: the stream-error handler has already
              // finalized the partial message. Don't overwrite with an error.
              clearPaymentRetry(convId);
              setConversationSending(convId, false);
            } else if (
              result.stopReason?.retryable === false
              || isPinnedConversation(convId)
            ) {
              reportChatError(result.stopReason?.message || result.error, 'Request failed');
              setConversationSending(convId, false);
            } else {
              scheduleChatRetry(
                { convId, content, attachments, selection },
                'request',
                result.stopReason?.message ?? result.error,
              );
              setConversationSending(convId, false);
            }
          }
        } catch (err) {
          if (
            (streamCompletedAtByConversation.get(convId) ?? 0) >= requestStartedAt
            || (streamFailedAtByConversation.get(convId) ?? 0) >= requestStartedAt
          ) {
            clearPaymentRetry(convId);
            setConversationSending(convId, false);
            return;
          }

          scheduleChatRetry({ convId, content, attachments, selection }, 'request', err);
          setConversationSending(convId, false);
        }
      })();
    } else if (bridge.chatAiSend) {
      void (async () => {
        try {
          const sendRequest = async () =>
            await bridge.chatAiSend!(
              convId,
              content || ' ',
              selection.id || undefined,
              selection.provider ?? undefined,
              attachments,
              selection.peerId,
              uiState.chatPermissionMode,
            );

          let result = await sendRequest();
          if (
            !result.ok &&
            isInProgressErrorMessage(result.error) &&
            bridge.chatAiAbort
          ) {
            appendSystemLog(
              'Detected stuck in-flight chat request. Aborting and retrying once...',
            );
            await bridge.chatAiAbort(convId).catch(() => undefined);
            result = await sendRequest();
          }

          if (!result.ok) {
            const errorMsg = typeof result.error === 'string' ? result.error : '';
            const paymentMatch = /^payment_required:(\d+)$/i.exec(errorMsg);
            if (paymentMatch) {
              void handlePaymentRequired(paymentMatch[1], {
                convId,
                content,
                attachments,
                selection,
              });
            } else if (errorMsg === 'Request aborted') {
              // User-initiated abort: don't auto-retry.
              clearPaymentRetry(convId);
            } else {
              scheduleChatRetry({ convId, content, attachments, selection }, 'request', result.error);
            }
          } else {
            clearPaymentRetry(convId);
          }
          setConversationSending(convId, false);
        } catch (err) {
          scheduleChatRetry({ convId, content, attachments, selection }, 'request', err);
          setConversationSending(convId, false);
        }
      })();
    }
  }

  /**
   * Retry the last user message after a payment failure. Keeps the
   * payment-approval card visible while the user stays in the same chat;
   * context switches are responsible for dismissing transient notices.
   */
  function retryAfterPayment(convId = uiState.chatActiveConversation): void {
    if (!bridge) return;
    if (!convId) return;

    // Find the last user message to resend
    type MsgShape = { role?: string; content?: unknown };
    const messages = getLocalConversationMessages(convId) ?? (
      convId === uiState.chatActiveConversation ? uiState.chatMessages : []
    );
    const lastUserMsg = ([...messages] as MsgShape[]).reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
        ? (lastUserMsg.content as ContentBlock[])
            .filter((block) => block.type === 'text')
            .map((block) => String(block.text ?? ''))
            .filter(Boolean)
            .join('\n\n')
        : '';

    const attachments: PreparedChatAttachment[] = [];
    if (Array.isArray(lastUserMsg.content)) {
      for (const block of lastUserMsg.content as ContentBlock[]) {
        if (block.type === 'file' && block.attachment && typeof block.attachment === 'object') {
          attachments.push(block.attachment as PreparedChatAttachment);
        }
      }
    }

    setConversationSending(convId, true);
    dispatchChatRequest(convId, content, attachments.length > 0 ? attachments : undefined);
  }

  async function abortChat(): Promise<void> {
    const convId = uiState.chatActiveConversation;
    if (convId) {
      setConversationSending(convId, false);
    } else {
      setChatSending(false);
    }
    if (bridge && bridge.chatAiAbort) {
      await bridge.chatAiAbort(convId ?? undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Service select handlers (called by ChatView)
  // ---------------------------------------------------------------------------

  function handleServiceChange(
    value: string,
    explicitPeerId?: string,
    rememberModelPin = true,
    routeMode?: 'auto' | 'pinned',
  ): void {
    uiState.chatSelectedServiceValue = value;
    pendingServiceOptions = null;
    clearTransientChatNotices();

    // Prefer an explicit peerId (e.g. from a Discover card click) so we don't
    // depend on chatServiceOptions.value matching the encoded form exactly.
    // Fall back to looking up the option by value for the dropdown case.
    let peerId = explicitPeerId?.trim() ?? '';
    const selectedOption = uiState.chatServiceOptions.find((o) => o.value === value);
    if (!peerId) {
      peerId = selectedOption?.peerId || '';
    }
    uiState.chatSelectedPeerId = peerId;

    const decoded = decodeChatServiceSelection(value);
    const nextServiceId = normalizeChatServiceId(selectedOption?.id ?? decoded.id);
    const nextProvider = normalizeProviderId(selectedOption?.provider ?? decoded.provider);
    const nextRouteMode = routeMode ?? (peerId ? 'pinned' : 'auto');
    const pinnedPeerId = nextRouteMode === 'pinned' ? peerId : '';

    // Write the explicit pick through to the AI VPN route selection so the two
    // never disagree about which model+peer a new conversation targets. The
    // service options are per-peer entries, so a dropdown pick is a peer pin.
    if (nextServiceId) {
      const catalogEntry = nextProvider
        ? findCatalogEntry(uiState.vprModelCatalog, nextProvider, nextServiceId)
        : null;
      const selectedModel = catalogEntry
        ? {
            provider: catalogEntry.provider,
            serviceId: catalogEntry.serviceId,
            label: catalogEntry.label,
            categories: [...catalogEntry.categories],
          }
        : {
            provider: nextProvider ?? '',
            serviceId: nextServiceId,
            label: selectedOption?.label ?? nextServiceId,
            categories: [...(selectedOption?.categories ?? [])],
          };
      uiState.vprRouteSelection = {
        model: selectedModel,
        mode: pinnedPeerId ? 'pinned-peer' : 'auto',
        peerId: pinnedPeerId || null,
      };
      // An explicit pick ends the provisional-default window even when the
      // user picks the very model the provisional default landed on.
      setProvisionalDefaultModel(null);
      if (rememberModelPin) {
        if (pinnedPeerId) {
          uiState.vprModelPins = setVprModelPin(
            uiState.vprModelPins,
            selectedModel.provider,
            selectedModel.serviceId,
            pinnedPeerId,
          );
        } else {
          uiState.vprModelPins = clearVprModelPin(
            uiState.vprModelPins,
            selectedModel.provider,
            selectedModel.serviceId,
          );
        }
        saveVprModelPins(uiState.vprModelPins);
      }
      saveVprRouteSelection(uiState.vprRouteSelection);
      void syncBuyerDefaultRoute(bridge, uiState);
    }

    if (activeConversation) {
      activeConversation.peerId = pinnedPeerId || undefined;
      activeConversation.peerLabel = pinnedPeerId
        ? selectedOption?.peerDisplayName || selectedOption?.peerLabel || undefined
        : undefined;
      activeConversation.routeMode = nextRouteMode;

      if (nextServiceId) {
        activeConversation.service = nextServiceId;
        activeConversation.provider = nextProvider ?? '';
      }

      const convId = activeConversation.id;
      if (convId && Array.isArray(uiState.chatConversations)) {
        const list = uiState.chatConversations as ChatConversationSummary[];
        const summary = list.find((c) => c.id === convId);
        if (summary) {
          summary.peerId = pinnedPeerId || '';
          summary.peerLabel = activeConversation.peerLabel ?? '';
          summary.routeMode = nextRouteMode;
          if (nextServiceId) {
            summary.service = nextServiceId;
            summary.provider = nextProvider ?? '';
          }
        }
      }
    }
    if (bridge?.chatAiSelectPeer) {
      void bridge.chatAiSelectPeer({
        conversationId: uiState.chatActiveConversation,
        peerId: pinnedPeerId || null,
        // Persist the model rebinding too — the in-memory summary update
        // above is otherwise reverted by the next conversation-list refresh.
        ...(nextServiceId ? { service: nextServiceId, provider: nextProvider ?? '' } : {}),
        routeMode: nextRouteMode,
      }).catch(() => undefined);
    }
    void refreshChatPermissionModeForPeer(pinnedPeerId);

    notifyUiStateChanged();
  }

  function handleServiceFocus(): void {
    serviceSelectFocused = true;
  }

  function handleServiceBlur(): void {
    serviceSelectFocused = false;
    if (pendingServiceOptions) {
      const pending = pendingServiceOptions;
      pendingServiceOptions = null;
      applyChatServiceOptions(pending);
    }
  }

  function clearPinnedPeer(): void {
    uiState.chatSelectedPeerId = '';
    uiState.chatRoutedPeer = '';
    clearTransientChatNotices();
    if (activeConversation) {
      delete activeConversation.peerId;
      delete activeConversation.peerLabel;
    }
    if (bridge?.chatAiSelectPeer) {
      void bridge.chatAiSelectPeer({
        conversationId: uiState.chatActiveConversation,
        peerId: null,
      }).catch(() => undefined);
    }
    void refreshChatPermissionModeForPeer('');
    notifyUiStateChanged();
  }

  // ---------------------------------------------------------------------------
  // Bridge callbacks
  // ---------------------------------------------------------------------------

  if (bridge) {
    void refreshWorkspace();
    // --- Non-streaming callbacks ---

    if (bridge.onChatAiDone) {
      bridge.onChatAiDone((data) => {
        const incomingMessage = data.message as ChatMessage;
        const responsePeerId = typeof incomingMessage.meta?.peerId === 'string'
          ? incomingMessage.meta.peerId.trim()
          : '';
        if (responsePeerId && Array.isArray(uiState.chatConversations)) {
          const summary = (uiState.chatConversations as ChatConversationSummary[])
            .find((conversation) => conversation.id === data.conversationId);
          if (summary) summary.lastResponsePeerId = responsePeerId;
        }
        const isStreamingCommit = hasConversationStreamingMessage(data.conversationId);
        if (isStreamingCommit) {
          updateStreamingMessage(data.conversationId, (message) => {
            message.meta = {
              ...(message.meta ?? {}),
              ...(incomingMessage.meta ?? {}),
            };
            if (!message.createdAt && incomingMessage.createdAt) {
              message.createdAt = incomingMessage.createdAt;
            }
          });
        } else if (data.conversationId === uiState.chatActiveConversation) {
          commitAssistantMessage(incomingMessage);
          uiState.chatError = null;
          setConversationSending(data.conversationId, false);
          notifyUiStateChanged();
        }
        scheduleChatConversationsRefresh();
      });
    }

    if (bridge.onChatAiError) {
      bridge.onChatAiError((data) => {
        setConversationSending(data.conversationId, false);
        if (data.conversationId === uiState.chatActiveConversation) {
          const errStr = typeof data.error === 'string' ? data.error : '';
          const paymentMatch = /^payment_required:(\d+)$/i.exec(errStr);
          if (paymentMatch) {
            void handlePaymentRequired(paymentMatch[1], { convId: data.conversationId });
          } else if (data.error === 'Request aborted') {
            clearPaymentRetry(data.conversationId);
          } else {
            scheduleChatRetry({ convId: data.conversationId }, 'request', data.error);
            appendSystemLog(`AI Chat error: ${data.error}`);
          }
        }
      });
    }

    if (bridge.onChatAiUserPersisted) {
      bridge.onChatAiUserPersisted((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;
        const last = (uiState.chatMessages[uiState.chatMessages.length - 1] ||
          null) as ChatMessage | null;
        if (last && last.role === 'user' && !last.createdAt) {
          last.createdAt = data.message?.createdAt || Date.now();
          setLocalConversationMessages(
            data.conversationId,
            uiState.chatMessages as ChatMessage[],
          );
          notifyUiStateChanged();
        }
      });
    }

    if (bridge.onChatConversationTitleUpdated) {
      bridge.onChatConversationTitleUpdated((data) => {
        const title = String(data.title || '').trim();
        if (!title) return;
        const conversations = Array.isArray(uiState.chatConversations)
          ? (uiState.chatConversations as ChatConversationSummary[])
          : [];
        const conv = conversations.find((c) => c.id === data.conversationId);
        if (conv) {
          conv.title = title;
          uiState.chatConversations = [...conversations];
        }
        notifyUiStateChanged();
        scheduleChatConversationsRefresh();
      });
    }

    if (bridge.onChatDefaultRouteChanged) {
      // A non-renderer frontend (the Telegram bridge's /model) moved the
      // sticky model selection. Adopt it exactly as a dropdown pick would —
      // minus the active-conversation rebind, which main already applied to
      // its own conversation — so the next catalog poll re-posts the new
      // route instead of stomping it with the stale selection.
      bridge.onChatDefaultRouteChanged((data) => {
        const peerId = typeof data.peerId === 'string' ? data.peerId.trim() : '';
        const serviceId = normalizeChatServiceId(data.service);
        if (!peerId || !serviceId) return;
        const provider = normalizeProviderId(data.provider);
        const option = uiState.chatServiceOptions.find((o) => (
          o.peerId === peerId && normalizeChatServiceId(o.id) === serviceId
        ));
        uiState.chatSelectedServiceValue = option?.value ?? encodeChatServiceSelection(serviceId, provider, peerId);
        uiState.chatSelectedPeerId = peerId;
        const catalogEntry = findCatalogEntry(uiState.vprModelCatalog, option?.provider ?? provider ?? '', serviceId);
        const selectedModel = catalogEntry
          ? {
              provider: catalogEntry.provider,
              serviceId: catalogEntry.serviceId,
              label: catalogEntry.label,
              categories: [...catalogEntry.categories],
            }
          : {
              provider: option?.provider ?? provider ?? '',
              serviceId,
              label: option?.label ?? serviceId,
              categories: [...(option?.categories ?? [])],
            };
        uiState.vprRouteSelection = { model: selectedModel, mode: 'pinned-peer', peerId };
        // An external explicit pick ends the provisional-default window even
        // when it lands on the very model the provisional default chose —
        // otherwise the next refresh's re-pick would flatten the pin to auto.
        setProvisionalDefaultModel(null);
        uiState.vprModelPins = setVprModelPin(
          uiState.vprModelPins,
          selectedModel.provider,
          selectedModel.serviceId,
          peerId,
        );
        saveVprModelPins(uiState.vprModelPins);
        saveVprRouteSelection(uiState.vprRouteSelection);
        notifyUiStateChanged();
      });
    }

    // --- Streaming callbacks ---

    function getStreamingBlocks(message: ChatMessage | null = uiState.chatStreamingMessage): ContentBlock[] {
      return message && Array.isArray(message.content)
        ? (message.content as ContentBlock[])
        : [];
    }

    function getStreamingBlockId(blockType: string, index: number | string): string {
      return `${blockType}-${String(index)}`;
    }

    function createStreamingRenderKey(blockType: string, index: number | string): string {
      return `stream-${blockType}-${String(index)}`;
    }

    function findLastStreamingThinkingBlock(blocks: ContentBlock[], index: number | string): ContentBlock | undefined {
      const contentIndex = String(index);
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (
          block?.type === 'thinking' &&
          String(block.details?.streamContentIndex ?? '') === contentIndex &&
          block.streaming
        ) {
          return block;
        }
      }
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (
          block?.type === 'thinking' &&
          String(block.details?.streamContentIndex ?? '') === contentIndex
        ) {
          return block;
        }
      }
      return undefined;
    }

    function findLastStreamingBlockByType(blocks: ContentBlock[], type: string): ContentBlock | undefined {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.type === type) return block;
      }
      return undefined;
    }

    if (bridge.onChatAiStreamStart) {
      bridge.onChatAiStreamStart((data) => {
        if (data.conversationId === uiState.chatActiveConversation) {
          uiState.chatError = null;
          notifyUiStateChanged();
        }

        if (isConversationSending(data.conversationId)) {
          streamTurnsByConversation.set(data.conversationId, Number(data.turn) + 1);
          streamStartedAtByConversation.set(data.conversationId, Date.now());
          updateStreamingIndicator();
        }
        if (!hasConversationStreamingMessage(data.conversationId)) {
          setConversationStreamingMessage(data.conversationId, {
            role: 'assistant',
            content: [],
            createdAt: Date.now(),
            meta: {},
          });
        }
      });
    }

    if (bridge.onChatAiStreamBlockStart) {
      bridge.onChatAiStreamBlockStart((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;

        if (
          data.conversationId === uiState.chatActiveConversation &&
          uiState.chatWaitingForStream
        ) {
          uiState.chatWaitingForStream = false;
          uiState.chatThinkingPhase = null;
          clearThinkingPhaseExpiry();
          notifyUiStateChanged();
        }

        if (data.blockType === 'text') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'text',
              renderKey: createStreamingRenderKey('text', blocks.length),
              text: '',
              streaming: true,
            });
            message.content = blocks;
          });
        } else if (data.blockType === 'thinking') {
          const turn = streamTurnsByConversation.get(data.conversationId) ?? 0;
          const thinkingLabel = getMyrmecochoryLabel(turn + Number(data.index || 0));
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = getStreamingBlocks(message);
            const thinkingInstance = blocks.filter((block) => block?.type === 'thinking').length;
            blocks.push({
              type: 'thinking',
              renderKey: createStreamingRenderKey('thinking', `${data.index}-${thinkingInstance}`),
              id: getStreamingBlockId('thinking', `${data.index}-${thinkingInstance}`),
              name: thinkingLabel,
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
    }

    if (bridge.onChatAiStreamDelta) {
      bridge.onChatAiStreamDelta((data) => {
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
            const blocks = message.content as ContentBlock[];
            const thinkingBlock = findLastStreamingThinkingBlock(blocks, data.index);
            if (thinkingBlock && thinkingBlock.type === 'thinking') {
              thinkingBlock.thinking = `${String(thinkingBlock.thinking || '')}${data.text}`;
              thinkingBlock.streaming = true;
            }
          });
        }
      });
    }

    if (bridge.onChatAiStreamBlockStop) {
      bridge.onChatAiStreamBlockStop((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;

        if (data.blockType === 'text') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const textBlock = findLastStreamingBlockByType(blocks, 'text');
            if (!textBlock) return;
            textBlock.streaming = false;
            // Handle the rare case where '<think>' opened but never closed:
            // finalize the adjacent inline thinking block.
            const openThink = findOpenInlineThink(blocks, textBlock);
            if (openThink) {
              openThink.thinking = String(openThink.thinking || '').trim();
              openThink.streaming = false;
            }
          });
        } else if (data.blockType === 'thinking') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const thinkingBlock = findLastStreamingThinkingBlock(blocks, data.index);
            if (thinkingBlock && thinkingBlock.type === 'thinking') {
              thinkingBlock.streaming = false;
            }
          });
        } else if (data.blockType === 'tool_use' && data.input) {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            let toolBlock = blocks.find(
              (block) => block.type === 'tool_use' && block.id === data.toolId,
            );
            // Fallback: the block may have been created with a placeholder ID
            // (e.g. "tool-0") when the real ID wasn't available at toolcall_start.
            if (!toolBlock && data.toolId) {
              const fallbackId = getStreamingBlockId('tool', data.index);
              toolBlock = blocks.find(
                (block) => block.type === 'tool_use' && block.id === fallbackId,
              );
              if (toolBlock) {
                toolBlock.id = data.toolId;
                toolBlock.renderKey = createStreamingRenderKey('tool', data.toolId);
              }
            }
            if (toolBlock) {
              toolBlock.input = data.input;
              if (data.toolName) toolBlock.name = String(data.toolName);
            }
          });
        }
      });
    }

    if (bridge.onChatAiToolExecuting) {
      bridge.onChatAiToolExecuting((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          // Fallback: match by tool name against placeholder blocks
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id) &&
                (block.name === data.name || block.name === 'tool'),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.name = String(data.name || toolBlock.name || 'tool');
            toolBlock.input = data.input;
            toolBlock.status = 'running';
          }
        });
      });
    }

    if (bridge.onChatAiToolUpdate) {
      bridge.onChatAiToolUpdate((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id) &&
                (block.name === data.name || block.name === 'tool'),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.name = String(data.name || toolBlock.name || 'tool');
            toolBlock.input = data.input;
            toolBlock.content = data.output;
            if (data.details) {
              toolBlock.details = data.details;
            }
            toolBlock.status = 'running';
          } else {
            appendSystemLog(`[chat] tool-update: block not found for toolUseId=${data.toolUseId}`);
          }
        });
      });
    }

    if (bridge.onChatAiToolResult) {
      bridge.onChatAiToolResult((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.status = data.isError ? 'error' : 'success';
            toolBlock.content = data.output;
            toolBlock.is_error = data.isError;
            if (data.details) {
              toolBlock.details = data.details;
            }
          }
        });
      });
    }

    if (bridge.onChatToolApprovalRequested) {
      bridge.onChatToolApprovalRequested((request) => {
        const existingIndex = uiState.chatToolApprovalRequests.findIndex((entry) => entry.id === request.id);
        const next = existingIndex >= 0
          ? uiState.chatToolApprovalRequests.map((entry) => (entry.id === request.id ? request : entry))
          : [...uiState.chatToolApprovalRequests, request];
        setToolApprovalRequests(next);
        notifyUiStateChanged();
      });
    }

    if (bridge.onChatToolApprovalCleared) {
      bridge.onChatToolApprovalCleared((data) => {
        const next = uiState.chatToolApprovalRequests.filter((entry) => entry.id !== data.id);
        if (next.length !== uiState.chatToolApprovalRequests.length) {
          setToolApprovalRequests(next);
          notifyUiStateChanged();
        }
      });
    }

    if (bridge.onBrowserPreviewOpen) {
      bridge.onBrowserPreviewOpen((data) => {
        uiState.browserPreviewUrl = data.url;
        uiState.browserPreviewRequestId += 1;
        notifyUiStateChanged();
      });
    }

    // Expose API for triggering browser preview programmatically (dev/testing only)
    if (import.meta.env?.DEV) {
      (window as unknown as Record<string, unknown>).__antseedOpenPreview = (url: string) => {
        uiState.browserPreviewUrl = url;
        uiState.browserPreviewRequestId += 1;
        notifyUiStateChanged();
      };
    }


    if (bridge.onChatAiStreamDone) {
      bridge.onChatAiStreamDone((data) => {
        const shouldClearSending = isConversationSending(data.conversationId);
        const startedAt = streamStartedAtByConversation.get(data.conversationId) ?? 0;
        const elapsedMs =
          startedAt > 0 && shouldClearSending
            ? Date.now() - startedAt
            : 0;

        const finalizedStreamingMessage = materializeStreamingMessage(
          getConversationStreamingMessage(data.conversationId),
        );
        const completionMeta = finalizedStreamingMessage
          ? normalizeAssistantMeta(finalizedStreamingMessage)
          : null;

        streamCompletedAtByConversation.set(data.conversationId, Date.now());
        clearPaymentRetry(data.conversationId);

        if (data.conversationId === uiState.chatActiveConversation) {
          if (finalizedStreamingMessage) {
            commitAssistantMessage(finalizedStreamingMessage);
          }
          setConversationStreamingMessage(data.conversationId, null);
          if (shouldClearSending) {
            setConversationSending(data.conversationId, false);
          }
          uiState.chatError = null;
          notifyUiStateChanged();
        } else {
          if (finalizedStreamingMessage) {
            appendAssistantMessageToConversation(
              data.conversationId,
              finalizedStreamingMessage,
            );
          }
          setConversationStreamingMessage(data.conversationId, null);
          if (shouldClearSending) {
            setConversationSending(data.conversationId, false);
            notifyUiStateChanged();
          }
        }

        if (elapsedMs > 0) {
          appendSystemLog(
            `AI stream completed in ${(elapsedMs / 1000).toFixed(1)}s.`,
          );
        }

        scheduleChatConversationsRefresh();
        // Only count completions that finalized an assistant message; an empty
        // or duplicated done event must not inflate the reminder request counters.
        if (completionMeta) {
          onResponseCompleted?.(data.conversationId, {
            inputTokens: completionMeta.inputTokens ?? 0,
            outputTokens: completionMeta.outputTokens ?? 0,
            service: completionMeta.service ?? null,
          });
        }
      });
    }

    if (bridge.onChatAiStreamError) {
      bridge.onChatAiStreamError((data) => {
        const shouldClearSending = isConversationSending(data.conversationId);
        const stopReason = data.stopReason;
        const stopReasonSummary = stopReason
          ? [
              stopReason.kind,
              stopReason.statusCode ? `status=${String(stopReason.statusCode)}` : null,
              stopReason.errorCode ? `code=${stopReason.errorCode}` : null,
              stopReason.retryable ? 'retryable' : 'non-retryable',
            ].filter(Boolean).join(', ')
          : 'unknown';
        const isAbort = data.error === 'Request aborted';

        // Preserve whatever has already streamed in by committing the partial
        // message (mirroring onChatAiStreamDone). This applies to both user
        // aborts and upstream errors — users should never lose visible content
        // just because the stream didn't finish. For non-abort errors the
        // error itself is surfaced below the committed content.
        const finalized = materializeStreamingMessage(
          getConversationStreamingMessage(data.conversationId),
        );
        const outputAlreadyStarted = Boolean(
          finalized
          && (Array.isArray(finalized.content)
            ? finalized.content.length > 0
            : typeof finalized.content === 'string'
              ? finalized.content.length > 0
              : finalized.content != null),
        );
        if (finalized && outputAlreadyStarted) {
          if (data.conversationId === uiState.chatActiveConversation) {
            commitAssistantMessage(finalized);
          } else {
            appendAssistantMessageToConversation(data.conversationId, finalized);
          }
        }
        setConversationStreamingMessage(data.conversationId, null);
        streamFailedAtByConversation.set(data.conversationId, Date.now());

        const isActiveConversation = data.conversationId === uiState.chatActiveConversation;
        const isPinned = isPinnedConversation(data.conversationId);
        if (isActiveConversation) {
          // Ensure the waiting-for-stream flag is cleared even if the error fires
          // before chat:ai-stream-start is received (which is the only other place
          // this flag gets cleared), preventing a permanent UI spinner lock.
          uiState.chatWaitingForStream = false;
          notifyUiStateChanged();
        }
        if (shouldClearSending) {
          setConversationSending(data.conversationId, false);
          if (!isActiveConversation) notifyUiStateChanged();
        }

        if (isAbort) {
          clearPaymentRetry(data.conversationId);
        } else {
          const errStr = typeof data.error === 'string' ? data.error : '';
          const paymentMatch = /^payment_required:(\d+)$/i.exec(errStr);
          if (paymentMatch) {
            if (isActiveConversation) {
              void handlePaymentRequired(paymentMatch[1], { convId: data.conversationId });
              if (bridge.chatAiAbort) void bridge.chatAiAbort(data.conversationId).catch(() => {});
            } else {
              clearPaymentRetry(data.conversationId);
            }
          } else if (stopReason?.retryable === false || outputAlreadyStarted || isPinned) {
            clearPaymentRetry(data.conversationId);
            if (isActiveConversation) {
              reportChatError(stopReason?.message || data.error, 'Request failed');
            }
          } else {
            scheduleChatRetry(
              { convId: data.conversationId },
              'request',
              stopReason?.message ?? data.error,
            );
          }
          appendSystemLog(`AI Chat error (${stopReasonSummary}): ${data.error}`);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  updateThreadMeta(null);
  updateStreamingIndicator();
  void refreshChatServiceOptions();

  // ---------------------------------------------------------------------------
  // Public API
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

  return {
    handleLogLineForThinkingPhase,
    setChatPermissionMode,
    decideToolApproval,
    refreshChatServiceOptions,
    applyPeerAccessRules,
    endProvisionalDefaultModel,
    refreshChatProxyStatus,
    refreshChatConversations,
    refreshWorkspace,
    chooseWorkspace,
    createNewConversation,
    startNewChat,
    deleteConversation,
    renameConversation,
    openConversation,
    sendMessage,
    sendMessageToConversation,
    generateImage,
    retryAfterPayment,
    abortChat,
    handleServiceChange,
    handleServiceFocus,
    handleServiceBlur,
    clearPinnedPeer,
  };
}
