import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, useId } from 'react';
import type { KeyboardEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowUp02Icon,
  ArrowRight01Icon,
  ArrowDown02Icon,
  BrowserIcon,
  Cancel01Icon,
  Folder01Icon,
  Mic01Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Search01Icon,
  SecurityWarningIcon,
  Shield01Icon
} from '@hugeicons/core-free-icons';
import { displayModelLabel } from '../../../modules/catalog/model-identity';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import { ChatBubble } from '../chat/ChatBubble';
import { isImageRequestPhase } from '../chat/chat-shared';
import { hasSearchPhraseMatch, isToolResultOnlyMessage } from '../chat/chat-utils.js';
import { WalkingAnt } from '../chat/WalkingAnt';
import { ImageGenerationPlaceholder } from '../chat/ImageGenerationPlaceholder';
import { SessionApprovalCard } from '../chat/SessionApprovalCard';
import { ToolApprovalCard } from '../chat/ToolApprovalCard';
import { LowBalanceWarning } from '../chat/LowBalanceWarning';
import { VprModelDropdown } from '../chat/VprModelDropdown';
import { SwitchServiceDialog } from '../chat/SwitchServiceDialog';
import { LowReputationDialog } from '../chat/LowReputationDialog';
import { AttachmentViewer, type ViewerAttachment } from '../chat/AttachmentViewer';
import { BrowserPreview } from '../BrowserPreview';
import type { ChatMessage } from '../chat/chat-shared';
import { buildDisplayMessages } from '../chat/chat-shared';
import type { ChatPermissionMode, RawChatAttachment } from '../../../types/bridge';
import type { VprModelCatalogEntry } from '../../../core/state';
import { getPeerDisplayName } from '../../../core/peer-utils';
import { selectHeadlineBalanceUsdc } from '../../../core/balance';
import { getUiStateRef, notifyUiStateChangedSync } from '../../../core/store';
import { VprStackedLogo } from '../VprLogo';
import { VprHeaderActions } from '../vpr/VprHeaderActions';
import { cancelVoiceRecording, startVoiceRecording, stopVoiceRecording } from '../../lib/voice-recorder';
import styles from './ChatView.module.scss';
import bubbleStyles from '../chat/ChatBubble.module.scss';

const SWITCH_DIALOG_DISMISSED_KEY = 'antseed:switchServiceConfirmDismissed';
const LOW_REPUTATION_SCORE_THRESHOLD = 50;

const MAX_INPUT_HEIGHT = 220;
const PREVIEW_MIN_WIDTH = 280;
const CHAT_MIN_WIDTH = 320;
const DEFAULT_PREVIEW_FRACTION = 0.5;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const NEAR_BOTTOM_PX = 40;
const PERMISSION_MODES: Array<{
  value: ChatPermissionMode;
  label: string;
  tone: 'safe' | 'risk';
}> = [
  {
    value: 'manual',
    label: 'Ask first',
    tone: 'safe',
  },
  {
    value: 'full',
    label: 'Full access',
    tone: 'risk',
  },
];

function isNearScrollBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

function getMessageContentKey(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, 48);
  }
  if (Array.isArray(content)) {
    return `${content.length}:${content
      .map((block) => {
        if (!block || typeof block !== 'object') return 'x';
        const typedBlock = block as { type?: unknown; text?: unknown; name?: unknown };
        return `${String(typedBlock.type || 'x')}:${String(typedBlock.name || typedBlock.text || '').slice(0, 24)}`;
      })
      .join('|')}`;
  }
  return String(content ?? '');
}

function getMessageKey(message: ChatMessage, index: number): string {
  const routeRequestId =
    typeof message.meta?.routeRequestId === 'string' ? message.meta.routeRequestId : '';
  if (routeRequestId) {
    return `${message.role}:${routeRequestId}:${index}`;
  }
  const createdAt = Number(message.createdAt) || 0;
  return `${message.role}:${createdAt}:${getMessageContentKey(message.content)}:${index}`;
}

function collectSearchableText(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectSearchableText(entry, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [
      record.text,
      record.thinking,
      record.content,
      record.name,
      record.fileName,
      record.error,
      record.input,
      record.details,
    ].map((entry) => collectSearchableText(entry, depth + 1)).filter(Boolean).join('\n');
  }
  return '';
}

function getSearchableMessageText(message: ChatMessage): string {
  return collectSearchableText(message.content);
}

function getNormalizedSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function getPathTail(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return 'Workspace';
  }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function getPathEnding(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return 'No workspace';
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) {
    return parts[0] || trimmed;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function formatVoiceElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type ChatViewProps = {
  onSelectView?: (view: import('../../types').ViewName) => void;
};

type PendingDraft = {
  id: string;
  conversationId: string | null;
  text: string;
  attachments: RawChatAttachment[];
  mode: 'text' | 'image';
};

type ChatViewCache = {
  inputValue: string;
  attachedFiles: RawChatAttachment[];
  attachmentError: string | null;
  attachmentWarning: string | null;
  voiceError: string | null;
  voiceState: 'idle' | 'recording' | 'transcribing';
  voiceElapsedMs: number;
  isDragOver: boolean;
  previewOpen: boolean;
  previewFraction: number;
  previewTargetUrl: string | null;
  switchDialogOpen: boolean;
  pendingSwitchModel: VprModelCatalogEntry | null;
  messageSearchOpen: boolean;
  messageSearchQuery: string;
  selectedSearchIndex: number;
  lowReputationDialogOpen: boolean;
  pendingLowReputationSend: { text: string; attachments: RawChatAttachment[] } | null;
  pendingQueue: PendingDraft[];
  previewAttachment: ViewerAttachment | null;
  permissionMenuOpen: boolean;
  isNearBottom: boolean;
  hasNewActivityWhileScrolledUp: boolean;
  approvedLowReputationPeers: Set<string>;
};

// Renderer-lifetime cache: lazy navigation unmounts ChatView, but drafts and
// transient composer state should survive until the app process exits.
const chatViewCache: ChatViewCache = {
  inputValue: '',
  attachedFiles: [],
  attachmentError: null,
  attachmentWarning: null,
  voiceError: null,
  voiceState: 'idle',
  voiceElapsedMs: 0,
  isDragOver: false,
  previewOpen: false,
  previewFraction: DEFAULT_PREVIEW_FRACTION,
  previewTargetUrl: null,
  switchDialogOpen: false,
  pendingSwitchModel: null,
  messageSearchOpen: false,
  messageSearchQuery: '',
  selectedSearchIndex: 0,
  lowReputationDialogOpen: false,
  pendingLowReputationSend: null,
  pendingQueue: [],
  previewAttachment: null,
  permissionMenuOpen: false,
  isNearBottom: true,
  hasNewActivityWhileScrolledUp: false,
  approvedLowReputationPeers: new Set(),
};

export function ChatView({ onSelectView }: ChatViewProps) {
  const snap = useUiSelector((state) => ({
    headlineBalanceUsdc: selectHeadlineBalanceUsdc(state),
    browserPreviewRequestId: state.browserPreviewRequestId,
    browserPreviewUrl: state.browserPreviewUrl,
    chatAbortVisible: state.chatAbortVisible,
    chatActiveConversation: state.chatActiveConversation,
    chatPanelExpanded: state.chatPanelExpanded,
    chatConversations: state.chatConversations,
    chatConversationsLoaded: state.chatConversationsLoaded,
    chatDiscoverRowsLoaded: state.chatDiscoverRowsLoaded,
    chatError: state.chatError,
    chatRoutingNotice: state.chatRoutingNotice,
    chatInputDisabled: state.chatInputDisabled,
    chatLowBalanceWarning: state.chatLowBalanceWarning,
    chatMessages: state.chatMessages,
    chatOpeningConversationId: state.chatOpeningConversationId,
    chatPaymentApprovalAmount: state.chatPaymentApprovalAmount,
    chatPaymentApprovalError: state.chatPaymentApprovalError,
    chatPaymentApprovalPeerInfo: state.chatPaymentApprovalPeerInfo,
    chatPaymentApprovalPeerName: state.chatPaymentApprovalPeerName,
    chatPaymentApprovalVisible: state.chatPaymentApprovalVisible,
    chatPermissionMode: state.chatPermissionMode,
    chatRoutedPeer: state.chatRoutedPeer,
    chatRoutedPeerId: state.chatRoutedPeerId,
    chatSelectedPeerId: state.chatSelectedPeerId,
    chatSelectedServiceValue: state.chatSelectedServiceValue,
    chatSendDisabled: state.chatSendDisabled,
    chatSending: state.chatSending,
    chatSendingConversationId: state.chatSendingConversationId,
    chatSendingConversationIds: state.chatSendingConversationIds,
    chatServiceOptions: state.chatServiceOptions,
    chatServiceSelectDisabled: state.chatServiceSelectDisabled,
    chatStreamingMessage: state.chatStreamingMessage,
    chatThinkingElapsedMs: state.chatThinkingElapsedMs,
    chatThinkingPhase: state.chatThinkingPhase,
    chatToolApprovalRequests: state.chatToolApprovalRequests,
    chatWorkspaceDefaultPath: state.chatWorkspaceDefaultPath,
    chatWorkspacePath: state.chatWorkspacePath,
    creditsAvailableUsdc: state.creditsAvailableUsdc,
    discoverRows: state.discoverRows,
    vprModelCatalog: state.vprModelCatalog,
    vprRouteSelection: state.vprRouteSelection,
    chatImageRouteSelection: state.chatImageRouteSelection,
  }), shallowEqual);
  const actions = useActions();
  const [inputValue, setInputValue] = useRetainedState(chatViewCache, 'inputValue');
  const [attachedFiles, setAttachedFiles] = useRetainedState(chatViewCache, 'attachedFiles');
  const [attachmentError, setAttachmentError] = useRetainedState(chatViewCache, 'attachmentError');
  const [attachmentWarning, setAttachmentWarning] = useRetainedState(chatViewCache, 'attachmentWarning');
  const [voiceError, setVoiceError] = useRetainedState(chatViewCache, 'voiceError');
  const [voiceState, setVoiceState] = useRetainedState(chatViewCache, 'voiceState');
  const [voiceElapsedMs, setVoiceElapsedMs] = useRetainedState(chatViewCache, 'voiceElapsedMs');
  const [isDragOver, setIsDragOver] = useRetainedState(chatViewCache, 'isDragOver');
  const [previewOpen, setPreviewOpen] = useRetainedState(chatViewCache, 'previewOpen');
  const [previewFraction, setPreviewFraction] = useRetainedState(chatViewCache, 'previewFraction');
  const [previewTargetUrl, setPreviewTargetUrl] = useRetainedState(chatViewCache, 'previewTargetUrl');
  const [switchDialogOpen, setSwitchDialogOpen] = useRetainedState(chatViewCache, 'switchDialogOpen');
  const [pendingSwitchModel, setPendingSwitchModel] = useRetainedState(chatViewCache, 'pendingSwitchModel');
  const [messageSearchOpen, setMessageSearchOpen] = useRetainedState(chatViewCache, 'messageSearchOpen');
  const [messageSearchQuery, setMessageSearchQuery] = useRetainedState(chatViewCache, 'messageSearchQuery');
  const [selectedSearchIndex, setSelectedSearchIndex] = useRetainedState(chatViewCache, 'selectedSearchIndex');
  const [lowReputationDialogOpen, setLowReputationDialogOpen] = useRetainedState(chatViewCache, 'lowReputationDialogOpen');
  const [pendingLowReputationSend, setPendingLowReputationSend] = useRetainedState(chatViewCache, 'pendingLowReputationSend');
  // While the LLM is streaming we still let the user type/paste.
  // Drafts the user confirms (Enter / Send) are parked in this queue as
  // cards above the composer and ship one-per-turn as soon as the current
  // stream ends (naturally or via Stop). See issue #59.
  const [pendingQueue, setPendingQueue] = useRetainedState(chatViewCache, 'pendingQueue');
  const [previewAttachment, setPreviewAttachment] = useRetainedState(chatViewCache, 'previewAttachment');
  const [permissionMenuOpen, setPermissionMenuOpen] = useRetainedState(chatViewCache, 'permissionMenuOpen');
  const [isNearBottom, setIsNearBottom] = useRetainedState(chatViewCache, 'isNearBottom');
  const [hasNewActivityWhileScrolledUp, setHasNewActivityWhileScrolledUp] = useRetainedState(chatViewCache, 'hasNewActivityWhileScrolledUp');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messageSearchInputRef = useRef<HTMLInputElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const approvedLowReputationPeersRef = useRef<Set<string>>(chatViewCache.approvedLowReputationPeers);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();
  const isUserScrolledUp = useRef(false);
  const isDragging = useRef(false);
  const permissionMenuRef = useRef<HTMLDivElement>(null);
  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return buildDisplayMessages(msgs).filter((msg) => !isToolResultOnlyMessage(msg));
  }, [snap.chatMessages]);
  const keyedVisibleMessages = useMemo(
    () => visibleMessages.map((message, index) => ({ message, key: getMessageKey(message, index) })),
    [visibleMessages],
  );
  const normalizedMessageSearchQuery = getNormalizedSearchQuery(messageSearchQuery);
  const messageSearchResults = useMemo(() => {
    if (!normalizedMessageSearchQuery) return [];
    return keyedVisibleMessages
      .filter(({ message }) => hasSearchPhraseMatch(getSearchableMessageText(message), normalizedMessageSearchQuery))
      .map(({ key }) => key);
  }, [keyedVisibleMessages, normalizedMessageSearchQuery]);
  const activeSearchResultKey = messageSearchResults[selectedSearchIndex] || null;

  const previewUrl = snap.browserPreviewUrl;
  const previewRequestId = snap.browserPreviewRequestId;
  useEffect(() => {
    if (previewUrl) {
      setPreviewTargetUrl(previewUrl);
      setPreviewOpen(true);
    }
  }, [previewUrl, previewRequestId]);

  useEffect(() => {
    setMessageSearchOpen(false);
    setMessageSearchQuery('');
    setSelectedSearchIndex(0);
  }, [snap.chatActiveConversation]);

  useEffect(() => {
    setSelectedSearchIndex(0);
  }, [normalizedMessageSearchQuery]);

  useEffect(() => {
    if (selectedSearchIndex >= messageSearchResults.length) {
      setSelectedSearchIndex(Math.max(0, messageSearchResults.length - 1));
    }
  }, [messageSearchResults.length, selectedSearchIndex]);

  useEffect(() => {
    if (!messageSearchOpen) return;
    const frame = requestAnimationFrame(() => messageSearchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [messageSearchOpen]);

  useEffect(() => {
    if (!activeSearchResultKey) return;
    const target = messageRefs.current.get(activeSearchResultKey);
    if (!target) return;
    isUserScrolledUp.current = true;

    const frame = requestAnimationFrame(() => {
      const activeMark = target.querySelector('.chat-search-mark-active');
      const scrollTarget = activeMark instanceof HTMLElement ? activeMark : target;
      scrollTarget.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'smooth' });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeSearchResultKey]);

  const openMessageSearch = useCallback(() => {
    setMessageSearchOpen(true);
  }, []);

  const closeMessageSearch = useCallback(() => {
    setMessageSearchOpen(false);
    setMessageSearchQuery('');
    setSelectedSearchIndex(0);
    inputRef.current?.focus();
  }, []);

  const selectNextSearchResult = useCallback(() => {
    setSelectedSearchIndex((current) => {
      if (messageSearchResults.length === 0) return 0;
      return (current + 1) % messageSearchResults.length;
    });
  }, [messageSearchResults.length]);

  const selectPreviousSearchResult = useCallback(() => {
    setSelectedSearchIndex((current) => {
      if (messageSearchResults.length === 0) return 0;
      return (current - 1 + messageSearchResults.length) % messageSearchResults.length;
    });
  }, [messageSearchResults.length]);

  const handleMessageSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) selectPreviousSearchResult();
      else selectNextSearchResult();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMessageSearch();
    }
  }, [closeMessageSearch, selectNextSearchResult, selectPreviousSearchResult]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openMessageSearch();
        return;
      }
      if (event.key === 'Escape' && messageSearchOpen) {
        event.preventDefault();
        closeMessageSearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeMessageSearch, messageSearchOpen, openMessageSearch]);

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = isNearScrollBottom(el);
      isUserScrolledUp.current = !atBottom;
      setIsNearBottom(atBottom);
      if (atBottom) {
        setHasNewActivityWhileScrolledUp(false);
      }
    };
    handleScroll();
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isUserScrolledUp.current = false;
    setIsNearBottom(true);
    setHasNewActivityWhileScrolledUp(false);
  }, []);

  // Opening/reopening a conversation should land on the latest message, not the
  // last scroll offset from a previous visit. Keep manual scrollback behavior
  // during the current visit by only forcing bottom on conversation/view entry.
  // Layout effect so the scroll lands before the first paint: with a plain
  // effect the view-slide transition paints its first frames at the top of
  // the conversation and then visibly snaps to the latest message.
  useLayoutEffect(() => {
    // Runs on view entry (mount) and on conversation switch — both should
    // land on the latest message rather than a stale scroll offset.
    isUserScrolledUp.current = false;
    scrollChatToBottom();
    const frame = requestAnimationFrame(() => scrollChatToBottom());
    return () => cancelAnimationFrame(frame);
  }, [snap.chatActiveConversation, scrollChatToBottom]);

  // Keep the view pinned to the bottom while the user is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    if (isUserScrolledUp.current) {
      setHasNewActivityWhileScrolledUp(true);
      return;
    }

    scrollChatToBottom();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!isUserScrolledUp.current) {
        scrollChatToBottom();
      }
    });

    observer.observe(el);
    Array.from(el.children).forEach((child) => observer.observe(child));

    return () => observer.disconnect();
  }, [visibleMessages, snap.chatStreamingMessage, snap.chatSending, scrollChatToBottom]);

  const activeConversationSummary = useMemo(() => {
    const activeConversationId = snap.chatActiveConversation;
    if (!activeConversationId || !Array.isArray(snap.chatConversations)) return null;
    return snap.chatConversations.find((conv) => (
      conv
      && typeof conv === 'object'
      && String((conv as { id?: unknown }).id || '') === activeConversationId
    )) as Record<string, unknown> | null;
  }, [snap.chatActiveConversation, snap.chatConversations]);
  const activeConversationPeerId =
    typeof activeConversationSummary?.peerId === 'string'
      ? activeConversationSummary.peerId.trim()
      : '';
  const activeConversationResponsePeerId =
    typeof activeConversationSummary?.lastResponsePeerId === 'string'
      ? activeConversationSummary.lastResponsePeerId.trim()
      : '';
  const activeConversationServiceId =
    typeof activeConversationSummary?.service === 'string'
      ? activeConversationSummary.service.trim()
      : '';
  const activeConversationProvider =
    typeof activeConversationSummary?.provider === 'string'
      ? activeConversationSummary.provider.trim()
      : '';
  const activeConversationPeerLabel =
    typeof activeConversationSummary?.peerLabel === 'string'
      ? activeConversationSummary.peerLabel.trim()
      : '';
  const activeConversationDisplayPeerId = activeConversationResponsePeerId || activeConversationPeerId;
  const activeConversationDisplayPeerRow = snap.discoverRows.find(
    (row) => row.peerId === activeConversationDisplayPeerId,
  );
  const activeConversationPeerName =
    activeConversationDisplayPeerRow?.peerDisplayName
    || getPeerDisplayName(activeConversationDisplayPeerRow?.peerLabel || activeConversationPeerLabel)
    || activeConversationDisplayPeerRow?.peerLabel
    || activeConversationPeerLabel
    || (activeConversationDisplayPeerId ? activeConversationDisplayPeerId.slice(0, 8) : '');
  const openingActiveConversation = Boolean(
    snap.chatOpeningConversationId
    && snap.chatOpeningConversationId === snap.chatActiveConversation,
  );

  const currentPeerId = snap.chatRoutedPeerId || snap.chatSelectedPeerId || activeConversationPeerId || '';
  const currentServiceOption = useMemo(
    () => snap.chatServiceOptions.find((o) => o.value === snap.chatSelectedServiceValue),
    [snap.chatServiceOptions, snap.chatSelectedServiceValue],
  );
  const currentPeerNotFound = Boolean(
    snap.chatActiveConversation
    && currentPeerId
    && !openingActiveConversation
    && snap.chatDiscoverRowsLoaded
    && !snap.chatServiceSelectDisabled
    && !snap.discoverRows.some((row) => row.peerId === currentPeerId)
    && !snap.chatServiceOptions.some((option) => option.peerId === currentPeerId),
  );
  // displayModelLabel keeps human text as-is and prettifies raw service keys.
  const currentServiceLabel = displayModelLabel(openingActiveConversation
    ? activeConversationServiceId || currentServiceOption?.label || 'Loading chat...'
    : currentServiceOption?.label || activeConversationServiceId || 'Select a model');

  const selectedCatalogEntry = useMemo(
    () => findCatalogEntry(snap.vprModelCatalog, snap.chatImageRouteSelection?.model?.provider ?? '', snap.chatImageRouteSelection?.model?.serviceId ?? ''),
    [snap.chatImageRouteSelection?.model, snap.vprModelCatalog],
  );
  const imageMode = selectedCatalogEntry?.kind === 'image';
  // Text conversations stay bound to their text model, but an explicit image
  // selection becomes the visible composer mode until the user picks text
  // again. This makes the header accurately describe what Send will do.
  const selectedModelProvider = imageMode
    ? (snap.chatImageRouteSelection?.model?.provider || '')
    : snap.chatActiveConversation
      ? (activeConversationProvider || currentServiceOption?.provider || '')
      : (snap.vprRouteSelection.model?.provider || currentServiceOption?.provider || '');
  const selectedModelServiceId = imageMode
    ? (snap.chatImageRouteSelection?.model?.serviceId || '')
    : snap.chatActiveConversation
      ? (activeConversationServiceId || currentServiceOption?.id || '')
      : (snap.vprRouteSelection.model?.serviceId || currentServiceOption?.id || '');
  const supportsMultimodal = currentServiceOption?.categories?.includes('multimodal') ?? false;
  const hasAttachedImages = useMemo(
    () => attachedFiles.some((file) => isImageAttachmentLike(file.name, file.mimeType)),
    [attachedFiles],
  );
  const peerDisplayName = snap.chatActiveConversation && activeConversationResponsePeerId
    ? activeConversationPeerName
    : currentPeerNotFound
      ? ''
      : openingActiveConversation
        ? activeConversationPeerName
        : snap.chatRoutedPeer || currentServiceOption?.peerDisplayName || currentServiceOption?.peerLabel || '';

  const activePendingQueue = useMemo(
    () => pendingQueue.filter((item) => item.conversationId === snap.chatActiveConversation),
    [pendingQueue, snap.chatActiveConversation],
  );

  // Re-focus the input when the active conversation becomes writable, and if
  // that same conversation has queued drafts, ship the head of its queue as its
  // own turn. Queue entries are scoped to the conversation they were authored
  // in so switching chats while a response streams cannot send the draft in the
  // newly-opened chat.
  useEffect(() => {
    if (snap.chatInputDisabled || (currentPeerNotFound && !imageMode)) return;
    // preventScroll: this runs on mount, while the view-slide transition still
    // has the pane translated off-screen. A plain focus() makes Chromium
    // scroll the overflow-hidden ancestors to reveal the input, visibly
    // jerking the pane mid-slide.
    if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    if (activePendingQueue.length === 0) return;
    const head = activePendingQueue[0];
    if (!head) return;
    setPendingQueue((prev) => prev.filter((item) => item.id !== head.id));
    if (head.mode === 'image') {
      actions.generateImage(head.text);
    } else if (head.conversationId) {
      actions.sendMessageToConversation(head.conversationId, head.text, head.attachments);
    } else {
      actions.sendMessage(head.text, head.attachments);
    }
  }, [snap.chatInputDisabled, activePendingQueue, actions, currentPeerNotFound, imageMode]);

  // --- Divider drag (pointer capture — no orphaned listeners) ---
  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleDividerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const totalWidth = rect.width;
    const chatWidth = e.clientX - rect.left;
    const clamped = Math.max(CHAT_MIN_WIDTH, Math.min(totalWidth - PREVIEW_MIN_WIDTH, chatWidth));
    setPreviewFraction(1 - clamped / totalWidth);
  }, []);

  const handleDividerPointerUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleOpenPreview = useCallback((url: string) => {
    setPreviewTargetUrl(url);
    setPreviewOpen(true);
  }, []);

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && permissionMenuRef.current?.contains(target)) return;
      setPermissionMenuOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPermissionMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [permissionMenuOpen]);

  const currentDiscoverRow = useMemo(() => {
    const peerId = currentServiceOption?.peerId || snap.chatSelectedPeerId || snap.chatRoutedPeerId || '';
    const serviceId = currentServiceOption?.id || '';
    if (!peerId) return null;
    return snap.discoverRows.find((row) => (
      row.peerId === peerId
      && (!serviceId || row.serviceId === serviceId)
      && (!currentServiceOption?.value || row.selectionValue === currentServiceOption.value || row.serviceId === serviceId)
    )) ?? snap.discoverRows.find((row) => row.peerId === peerId) ?? null;
  }, [currentServiceOption, snap.chatSelectedPeerId, snap.chatRoutedPeerId, snap.discoverRows]);
  const lowReputationPeer = useMemo(() => {
    const score = currentDiscoverRow?.effectiveReputationScore ?? currentDiscoverRow?.onChainReputationScore;
    const peerId = currentDiscoverRow?.peerId || currentServiceOption?.peerId || snap.chatSelectedPeerId || snap.chatRoutedPeerId || '';
    if (!peerId || typeof score !== 'number' || !Number.isFinite(score) || score >= LOW_REPUTATION_SCORE_THRESHOLD) {
      return null;
    }
    return {
      peerId,
      score,
      label: peerDisplayName || currentDiscoverRow?.peerDisplayName || currentDiscoverRow?.peerLabel || peerId.slice(0, 8),
    };
  }, [currentDiscoverRow, currentServiceOption?.peerId, snap.chatSelectedPeerId, snap.chatRoutedPeerId, peerDisplayName]);

  // Switching models routes through the AI VPN selection (auto seller pick);
  // with an open conversation this also rebinds the thread to the new model.
  const applyModelChange = useCallback(
    (entry: VprModelCatalogEntry) => {
      actions.selectVprModel(entry.provider, entry.serviceId);
    },
    [actions],
  );

  // Start a fresh conversation with the peer currently shown in this view,
  // pre-selecting the same service so the user can keep working with the
  // same provider in a clean thread. Available whenever there is an active
  // conversation with a known peer (issue: new-chat-with-peer affordance).
  const handleNewChatWithCurrentPeer = useCallback(() => {
    const peerId = currentPeerId;
    const serviceValue = snap.chatSelectedServiceValue;
    actions.startNewChat();
    if (peerId && serviceValue) {
      actions.handleServiceChange(serviceValue, peerId);
    }
    inputRef.current?.focus();
  }, [actions, currentPeerId, snap.chatSelectedServiceValue]);

  // Toggle between the thin chat panel and the expanded layout. The store
  // flag drives both the conversation-list panel (VprShell) and the window
  // size preset (AppShell).
  const handleTogglePanelExpanded = useCallback(() => {
    const state = getUiStateRef();
    state.chatPanelExpanded = !state.chatPanelExpanded;
    notifyUiStateChangedSync();
  }, []);

  const handleModelSwitch = useCallback(
    (entry: VprModelCatalogEntry) => {
      const hasMessages =
        Boolean(snap.chatActiveConversation) && visibleMessages.length > 0;
      const dismissed =
        typeof window !== 'undefined' &&
        window.localStorage.getItem(SWITCH_DIALOG_DISMISSED_KEY) === 'true';
      if (!hasMessages || dismissed) {
        applyModelChange(entry);
        return;
      }
      setPendingSwitchModel(entry);
      setSwitchDialogOpen(true);
    },
    [snap.chatActiveConversation, visibleMessages.length, applyModelChange],
  );

  const persistDismissed = useCallback((dontShowAgain: boolean) => {
    if (dontShowAgain && typeof window !== 'undefined') {
      window.localStorage.setItem(SWITCH_DIALOG_DISMISSED_KEY, 'true');
    }
  }, []);

  const handleSwitchContinue = useCallback(
    (dontShowAgain: boolean) => {
      persistDismissed(dontShowAgain);
      if (pendingSwitchModel) applyModelChange(pendingSwitchModel);
      setSwitchDialogOpen(false);
      setPendingSwitchModel(null);
    },
    [pendingSwitchModel, applyModelChange, persistDismissed],
  );

  const handleSwitchStartNew = useCallback(
    (dontShowAgain: boolean) => {
      persistDismissed(dontShowAgain);
      // New chat first so the current thread keeps its model; the fresh
      // draft then targets the newly selected one.
      actions.startNewChat();
      if (pendingSwitchModel) applyModelChange(pendingSwitchModel);
      setSwitchDialogOpen(false);
      setPendingSwitchModel(null);
    },
    [pendingSwitchModel, applyModelChange, actions, persistDismissed],
  );

  const handleSwitchCancel = useCallback(() => {
    setSwitchDialogOpen(false);
    setPendingSwitchModel(null);
  }, []);

  const resetComposer = useCallback(() => {
    setInputValue('');
    setAttachedFiles([]);
    setAttachmentError(null);
    setAttachmentWarning(null);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.overflowY = 'hidden';
      inputRef.current.focus();
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text && attachedFiles.length === 0) return;
    if (currentPeerNotFound && !imageMode) return;
    // If the current turn is still streaming, park the draft as a pending
    // card above the composer and clear the input so the user can keep
    // typing the next one. The disabled→enabled effect flushes the queue
    // head once the stream ends.
    if (snap.chatInputDisabled) {
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `pending-${String(Date.now())}-${String(Math.random())}`;
      setPendingQueue((prev) => [
        ...prev,
        { id, conversationId: snap.chatActiveConversation, text, attachments: attachedFiles, mode: imageMode ? 'image' : 'text' },
      ]);
      resetComposer();
      return;
    }

    if (
      !imageMode
      && lowReputationPeer
      && visibleMessages.length === 0
      && !approvedLowReputationPeersRef.current.has(lowReputationPeer.peerId)
    ) {
      setPendingLowReputationSend({ text, attachments: attachedFiles });
      setLowReputationDialogOpen(true);
      return;
    }

    const filesToSend = attachedFiles;
    resetComposer();
    if (imageMode) {
      actions.generateImage(text);
    } else {
      actions.sendMessage(text, filesToSend);
    }
    scrollChatToBottom('smooth');
  }, [inputValue, attachedFiles, actions, snap.chatInputDisabled, snap.chatActiveConversation, resetComposer, lowReputationPeer, visibleMessages.length, currentPeerNotFound, imageMode]);

  const handleLowReputationContinue = useCallback(() => {
    if (lowReputationPeer) {
      approvedLowReputationPeersRef.current.add(lowReputationPeer.peerId);
    }
    const pending = pendingLowReputationSend;
    setLowReputationDialogOpen(false);
    setPendingLowReputationSend(null);
    if (!pending) return;
    resetComposer();
    actions.sendMessage(pending.text, pending.attachments);
  }, [actions, lowReputationPeer, pendingLowReputationSend, resetComposer]);

  const handleLowReputationCancel = useCallback(() => {
    setLowReputationDialogOpen(false);
    setPendingLowReputationSend(null);
  }, []);

  const handleRemovePending = useCallback((id: string) => {
    setPendingQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleStop = useCallback(() => {
    // Deliberately leave pendingQueue intact: aborting is how the user asks
    // to move on to the queued drafts, so the disabled→enabled effect should
    // begin flushing the queue as soon as the abort lands.
    void actions.abortChat();
  }, [actions]);

  const readRawAttachment = useCallback((file: File): Promise<RawChatAttachment> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name || 'attachment'}`));
      reader.onload = () => {
        resolve({
          id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          name: file.name || 'attachment',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          base64: String(reader.result || ''),
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    if (imageMode) {
      setAttachmentError('Image generation currently accepts a text prompt only.');
      return;
    }
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const accepted: File[] = [];
    let totalBytes = attachedFiles.reduce((sum, file) => sum + file.size, 0);
    let blockedImageCount = 0;
    let nextError: string | null = null;

    for (const file of incoming) {
      if (!supportsMultimodal && isImageAttachmentLike(file.name, file.type)) {
        blockedImageCount += 1;
        nextError = "Selected model doesn't support images. Switch to a multimodal model to attach image files.";
        continue;
      }
      if (attachedFiles.length + accepted.length >= MAX_ATTACHMENTS) {
        nextError = `Only ${MAX_ATTACHMENTS} attachments are allowed per message.`;
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        nextError = `${file.name || 'Attachment'} exceeds the 25 MiB per-file limit.`;
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        nextError = 'Attachments exceed the 50 MiB per-message limit.';
        continue;
      }
      accepted.push(file);
      totalBytes += file.size;
    }

    if (blockedImageCount > 0 && accepted.length > 0) {
      nextError = `${nextError ? `${nextError} ` : ''}${blockedImageCount} image attachment${blockedImageCount === 1 ? '' : 's'} ${blockedImageCount === 1 ? 'was' : 'were'} skipped.`;
    }
    if (accepted.length === 0) {
      setAttachmentError(nextError);
      return;
    }

    try {
      const raw = await Promise.all(accepted.map(readRawAttachment));
      setAttachedFiles((prev) => [...prev, ...raw].slice(0, MAX_ATTACHMENTS));
      setAttachmentError(nextError);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }, [attachedFiles, readRawAttachment, supportsMultimodal, imageMode]);

  useEffect(() => {
    if (imageMode) {
      setAttachmentWarning(attachedFiles.length > 0
        ? 'Attachments are not used for image generation. Remove them or select a text model to send them.'
        : null);
      return;
    }
    if (supportsMultimodal || !hasAttachedImages) {
      setAttachmentWarning(null);
      return;
    }
    setAttachmentWarning("Selected model doesn't support images. Attached images will be omitted when you send this message.");
  }, [attachedFiles.length, hasAttachedImages, imageMode, supportsMultimodal]);

  useEffect(() => {
    if (supportsMultimodal && attachmentError?.includes("doesn't support images")) {
      setAttachmentError(null);
    }
  }, [supportsMultimodal, attachmentError]);

  const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) void attachFiles(files);
    e.target.value = '';
  }, [attachFiles]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== id));
    setAttachmentError(null);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    void attachFiles(files);
  }, [attachFiles]);

  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (currentPeerNotFound || imageMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, [currentPeerNotFound, imageMode]);

  const handleFileDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (currentPeerNotFound || imageMode) return;
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, [currentPeerNotFound, imageMode]);

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (currentPeerNotFound || imageMode) return;
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) void attachFiles(e.dataTransfer.files);
  }, [attachFiles, currentPeerNotFound, imageMode]);


  const handleInput = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, MAX_INPUT_HEIGHT);
      inputRef.current.style.height = `${newHeight}px`;
      inputRef.current.style.overflowY = inputRef.current.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
    }
  }, []);

  const handleVoiceRecord = useCallback(async () => {
    if (currentPeerNotFound) return;
    setVoiceError(null);
    try {
      if (voiceState === 'idle') {
        await startVoiceRecording();
        setVoiceElapsedMs(0);
        setVoiceState('recording');
        return;
      }

      if (voiceState === 'recording') {
        setVoiceState('transcribing');
        const recording = await stopVoiceRecording();
        if (!recording || recording.durationMs < 300) {
          setVoiceState('idle');
          return;
        }
        const result = await window.antseedDesktop?.voiceTranscribe?.(recording.audio);
        if (!result?.ok) throw new Error(result?.error || 'Local transcription failed.');
        const transcript = result.text?.trim();
        if (transcript) {
          setInputValue((prev) => prev.trim() ? `${prev.trimEnd()} ${transcript}` : transcript);
          requestAnimationFrame(handleInput);
          inputRef.current?.focus();
        }
        setVoiceState('idle');
      }
    } catch (error) {
      await cancelVoiceRecording().catch(() => undefined);
      setVoiceState('idle');
      setVoiceError(error instanceof Error ? error.message : String(error));
    }
  }, [currentPeerNotFound, handleInput, voiceState]);

  useEffect(() => {
    if (voiceState !== 'recording') return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setVoiceElapsedMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  useEffect(() => {
    return () => {
      chatViewCache.voiceState = 'idle';
      chatViewCache.voiceElapsedMs = 0;
      void cancelVoiceRecording();
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && voiceState === 'recording') {
        e.preventDefault();
        void cancelVoiceRecording().finally(() => setVoiceState('idle'));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, voiceState],
  );

  const handleClosePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handleElementSelected = useCallback((info: { selector: string; tagName: string; text: string; attributes: Record<string, string> }) => {
    const textSnippet = info.text.length > 80 ? info.text.slice(0, 80) + '...' : info.text;
    const elementRef = `[Element: <${info.tagName}> "${textSnippet}" (${info.selector})]`;
    setInputValue((prev) => prev ? `${prev}\n${elementRef}\n` : `${elementRef}\n`);
    if (inputRef.current) inputRef.current.focus();

    // Also send via bridge for providers that handle element selection
    const bridge = (window as unknown as { antseedDesktop?: { sendBrowserPreviewElementSelected?: (data: unknown) => void } }).antseedDesktop;
    bridge?.sendBrowserPreviewElementSelected?.(info);
  }, []);

  const handleScrollToLatest = useCallback(() => {
    scrollChatToBottom('smooth');
  }, [scrollChatToBottom]);

  const activeToolApprovalRequests = useMemo(() => {
    const activeConversationId = snap.chatActiveConversation;
    if (!activeConversationId) return [];
    return snap.chatToolApprovalRequests.filter((request) => request.conversationId === activeConversationId);
  }, [snap.chatActiveConversation, snap.chatToolApprovalRequests]);
  const activeToolApprovalRequest = activeToolApprovalRequests[0] ?? null;
  const showWelcome =
    snap.chatConversationsLoaded &&
    !snap.chatActiveConversation &&
    visibleMessages.length === 0 &&
    !snap.chatStreamingMessage;
  const showScrollToLatest = !showWelcome && !isNearBottom;
  const selectedPermissionMode = PERMISSION_MODES.find((mode) => mode.value === snap.chatPermissionMode) ?? PERMISSION_MODES[1];
  const activeConversationIsSending = snap.chatActiveConversation
    ? snap.chatSendingConversationIds.includes(snap.chatActiveConversation)
    : snap.chatSending;
  const permissionModeLocked = activeConversationIsSending || activeToolApprovalRequests.length > 0;

  useEffect(() => {
    if (permissionModeLocked) setPermissionMenuOpen(false);
  }, [permissionModeLocked]);

  const showThinkingIndicator = snap.chatSending && (
    !snap.chatSendingConversationId ||
    snap.chatSendingConversationId === snap.chatActiveConversation ||
    activeConversationIsSending
  );
  const imageRequestInProgress = showThinkingIndicator && isImageRequestPhase(snap.chatThinkingPhase);
  const imageUiMode = imageMode || imageRequestInProgress;
  const chatComposerDisabled = currentPeerNotFound && !imageMode;
  const chatSendDisabled = chatComposerDisabled
    || (imageMode ? snap.chatSendDisabled || inputValue.trim().length === 0 : snap.chatSendDisabled && attachedFiles.length === 0);

  const workspacePath = snap.chatWorkspacePath || snap.chatWorkspaceDefaultPath;
  const workspaceLabel = getPathEnding(workspacePath);

  // Compute widths for split view
  const chatStyle = previewOpen
    ? { flex: `0 0 ${(1 - previewFraction) * 100}%`, minWidth: CHAT_MIN_WIDTH }
    : undefined;
  const previewStyle = previewOpen
    ? { flex: `0 0 ${previewFraction * 100}%`, minWidth: PREVIEW_MIN_WIDTH }
    : undefined;

  // In the thin layout there is no room for the rest of the header chrome
  // while searching — the search bar takes the top bar over entirely. Only
  // with an active conversation: that is what gates the search bar itself.
  const searchOnlyHeader =
    messageSearchOpen && !snap.chatPanelExpanded && Boolean(snap.chatActiveConversation);

  return (
    <section className={`view view-chat`} role="tabpanel">
      <div className={styles.pageHeader}>
        {!searchOnlyHeader && (
        <div className={styles.pageHeaderLeft}>
          <button
            type="button"
            className={styles.panelToggle}
            onClick={handleTogglePanelExpanded}
            title={snap.chatPanelExpanded ? 'Hide chats' : 'View chats'}
            aria-label={snap.chatPanelExpanded ? 'Hide chats' : 'View chats'}
            aria-pressed={snap.chatPanelExpanded}
          >
            <HugeiconsIcon
              icon={snap.chatPanelExpanded ? PanelLeftOpenIcon : PanelLeftCloseIcon}
              size={17}
              strokeWidth={1.8}
            />
            <span>{snap.chatPanelExpanded ? 'Hide chats' : 'View chats'}</span>
          </button>
          <div className={styles.serviceSwitcherAnchor}>
            <VprModelDropdown
              catalog={snap.vprModelCatalog}
              kind={imageUiMode ? 'image' : 'text'}
              selectedProvider={selectedModelProvider}
              selectedServiceId={selectedModelServiceId}
              fallbackLabel={currentServiceLabel}
              disabled={(snap.chatInputDisabled || snap.chatSending) && !imageRequestInProgress}
              onSelect={handleModelSwitch}
              onBrowseAll={() => onSelectView?.('explore')}
            />
          </div>
          {currentPeerNotFound && !imageMode && (
            <span className={styles.headerLabelGroup}>
              <span className={styles.serviceLabel}>Peer was not found</span>
            </span>
          )}
        </div>
        )}
          <div className={`${styles.pageHeaderRight}${messageSearchOpen ? ` ${styles.pageHeaderRightSearching}` : ''}${searchOnlyHeader ? ` ${styles.pageHeaderRightSearchOnly}` : ''}`}>
            {snap.chatActiveConversation && <>
            {!searchOnlyHeader && snap.chatActiveConversation && currentPeerId && (
              <button
                type="button"
                className={`${styles.headerActionButton}${snap.chatPanelExpanded ? '' : ` ${styles.headerActionButtonIconOnly}`}`}
                onClick={handleNewChatWithCurrentPeer}
                title="Start a new chat with the same model"
                aria-label="Start a new chat with the same model"
              >
                <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                {snap.chatPanelExpanded && <span>New chat</span>}
              </button>
            )}
            {messageSearchOpen ? (
              <div className={styles.messageSearchBar} role="search">
                <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.8} className={styles.messageSearchIcon} />
                <input
                  ref={messageSearchInputRef}
                  className={styles.messageSearchInput}
                  value={messageSearchQuery}
                  onChange={(event) => setMessageSearchQuery(event.target.value)}
                  onKeyDown={handleMessageSearchKeyDown}
                  placeholder="Search messages…"
                  aria-label="Search messages in this conversation"
                />
                <span className={styles.messageSearchCount} aria-live="polite">
                  {normalizedMessageSearchQuery
                    ? `${messageSearchResults.length > 0 ? selectedSearchIndex + 1 : 0} / ${messageSearchResults.length}`
                    : '0 / 0'}
                </span>
                <button
                  type="button"
                  className={styles.messageSearchButton}
                  onClick={selectPreviousSearchResult}
                  disabled={messageSearchResults.length === 0}
                  aria-label="Previous search result"
                  title="Previous result"
                >
                  <HugeiconsIcon icon={ArrowUp02Icon} size={14} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className={styles.messageSearchButton}
                  onClick={selectNextSearchResult}
                  disabled={messageSearchResults.length === 0}
                  aria-label="Next search result"
                  title="Next result"
                >
                  <HugeiconsIcon icon={ArrowDown02Icon} size={14} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className={styles.messageSearchButton}
                  onClick={closeMessageSearch}
                  aria-label="Close message search"
                  title="Close search"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.messageSearchTrigger}
                onClick={openMessageSearch}
                aria-label="Search messages in this conversation"
                title="Search messages (⌘/Ctrl+F)"
              >
                <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.8} />
              </button>
            )}
            {previewTargetUrl && (
              <button
                type="button"
                className={`${styles.previewToggle}${previewOpen ? ` ${styles.previewToggleActive}` : ''}`}
                onClick={() => setPreviewOpen((open) => !open)}
                aria-label={previewOpen ? 'Close browser preview' : 'Open browser preview'}
                title={previewOpen ? 'Close preview' : 'Open preview'}
              >
                <HugeiconsIcon icon={BrowserIcon} size={15} strokeWidth={1.8} />
              </button>
            )}
            </>}
            <VprHeaderActions credits={snap.headlineBalanceUsdc} onSelectView={onSelectView} />
          </div>
      </div>

      {showWelcome && (
        <button
          className={styles.chatExternalHint}
          onClick={() => onSelectView?.('tools')}
        >
          <span>Connect tools through your AI VPN profiles</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.5} />
        </button>
      )}

      <div className={styles.chatContainer} ref={containerRef}>
        <div
          className={styles.chatMain}
          style={chatStyle}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          {isDragOver && (
            <div className={styles.chatDropOverlay}>
              <div className={styles.chatDropOverlayInner}>
                <span>
                  {supportsMultimodal ? 'Drop files here' : 'Drop files here (images are unavailable for this model)'}
                </span>
              </div>
            </div>
          )}
          <div className={styles.chatMessages} ref={scrollRef} data-chat-scroll>
            {showWelcome ? (
              <div className={styles.chatWelcome}>
                <VprStackedLogo height={72} />
                <div className={styles.chatWelcomeSubtitle}>
                  Start typing. Best provider auto-selected by reputation.
                </div>
              </div>
            ) : (
              keyedVisibleMessages.map(({ message: msg, key }) => {
                const isSearchMatch = messageSearchResults.includes(key);
                const isActiveSearchMatch = activeSearchResultKey === key;
                return (
                  <div
                    key={key}
                    ref={(node) => {
                      if (node) messageRefs.current.set(key, node);
                      else messageRefs.current.delete(key);
                    }}
                  >
                    <ChatBubble
                      message={msg}
                      onOpenPreview={handleOpenPreview}
                      conversationId={snap.chatActiveConversation || undefined}
                      searchQuery={isSearchMatch ? messageSearchQuery : undefined}
                      searchActive={isActiveSearchMatch}
                    />
                  </div>
                );
              })
            )}
            {snap.chatStreamingMessage ? (
              <ChatBubble
                key={`streaming:${snap.chatActiveConversation || 'new'}`}
                message={snap.chatStreamingMessage as ChatMessage}
                streaming
                onOpenPreview={handleOpenPreview}
                conversationId={snap.chatActiveConversation || undefined}
              />
            ) : null}
            {imageRequestInProgress ? (
              <ImageGenerationPlaceholder editing={snap.chatThinkingPhase === 'Editing image'} />
            ) : showThinkingIndicator ? (
              <WalkingAnt
                elapsedMs={snap.chatThinkingElapsedMs}
                phaseLabel={snap.chatThinkingPhase}
              />
            ) : null}
            {activePendingQueue.map((item) => (
              <div
                key={`pending-${item.id}`}
                className={`${bubbleStyles.chatBubble} ${bubbleStyles.own}`}
                style={{ opacity: 0.7 }}
                title="Will send when the current response finishes"
              >
                <span
                  className={bubbleStyles.chatBubbleStats}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  pending
                  <button
                    type="button"
                    aria-label="Remove queued message"
                    title="Remove queued message"
                    onClick={() => handleRemovePending(item.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 14,
                      lineHeight: 1,
                      opacity: 0.6,
                    }}
                  >
                    ×
                  </button>
                </span>
                <div>
                  {item.text || <em style={{ opacity: 0.7 }}>(attachments only)</em>}
                  {item.attachments.length > 0 && (
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>
                      · {item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <SessionApprovalCard
              visible={snap.chatPaymentApprovalVisible}
              peerName={snap.chatPaymentApprovalPeerName}
              amount={snap.chatPaymentApprovalAmount}
              peerInfo={snap.chatPaymentApprovalPeerInfo}
              error={snap.chatPaymentApprovalError}
              onAddCredits={() => onSelectView?.('deposit')}
              onRetry={() => actions.retryAfterPayment()}
              onCancel={() => actions.rejectPaymentSession()}
            />
          </div>

          {showScrollToLatest ? (
            <button
              type="button"
              className={`${styles.scrollToLatestButton}${hasNewActivityWhileScrolledUp ? ` ${styles.scrollToLatestButtonNew}` : ''}`}
              onClick={handleScrollToLatest}
              aria-label="Scroll to latest message"
              title="Scroll to latest message"
            >
              <HugeiconsIcon icon={ArrowUp02Icon} size={16} strokeWidth={2} className={styles.scrollToLatestIcon} />
            </button>
          ) : null}

          <div className={styles.chatInputArea}>
            {snap.chatError && <div className={styles.chatError}>{snap.chatError}</div>}
            {/* A successful failover is informational, not a failure — amber, not red. */}
            {snap.chatRoutingNotice && <div className={styles.chatWarning}>{snap.chatRoutingNotice}</div>}
            {attachmentError && <div className={styles.chatError}>{attachmentError}</div>}
            {voiceError && <div className={styles.chatError}>{voiceError}</div>}
            {attachmentWarning && <div className={styles.chatWarning}>{attachmentWarning}</div>}
            <LowBalanceWarning
              visible={snap.chatLowBalanceWarning}
              availableUsdc={snap.creditsAvailableUsdc}
              onAddCredits={() => onSelectView?.('deposit')}
            />
            <ToolApprovalCard
              request={activeToolApprovalRequest}
              pendingCount={activeToolApprovalRequests.length}
              onAllowOnce={() => activeToolApprovalRequest && actions.decideToolApproval('allow_once', activeToolApprovalRequest.id)}
              onAlwaysAllow={() => activeToolApprovalRequest && actions.decideToolApproval('always_allow_peer', activeToolApprovalRequest.id)}
              onDeny={() => activeToolApprovalRequest && actions.decideToolApproval('deny', activeToolApprovalRequest.id)}
            />

            {attachedFiles.length > 0 && (
              <div className={styles.chatAttachmentTray}>
                {attachedFiles.map((file) => {
                  const isImage = file.mimeType.startsWith('image/');
                  const openPreview = () => {
                    setPreviewAttachment({
                      name: file.name,
                      mimeType: file.mimeType,
                      size: file.size,
                      dataUrl: file.base64,
                    });
                  };
                  return (
                    <div className={styles.chatAttachmentChip} key={file.id} title={`${file.name} (${formatAttachmentSize(file.size)})${isImage ? ' — click to preview' : ''}`}>
                      {isImage ? (
                        <img
                          src={file.base64}
                          alt=""
                          className={styles.chatAttachmentThumb}
                          onClick={openPreview}
                          style={{ cursor: 'zoom-in' }}
                        />
                      ) : (
                        <span className={styles.chatAttachmentFileIcon}>
                          {getAttachmentExtension(file.name)}
                        </span>
                      )}
                      <span
                        className={styles.chatAttachmentName}
                        onClick={isImage ? openPreview : undefined}
                        style={isImage ? { cursor: 'pointer' } : undefined}
                      >
                        {file.name}
                      </span>
                      <span className={styles.chatAttachmentSize}>{formatAttachmentSize(file.size)}</span>
                      <button
                        className={styles.chatAttachmentRemoveBtn}
                        onClick={() => handleRemoveAttachment(file.id)}
                        title="Remove attachment"
                        type="button"
                      >
                        x
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className={styles.chatInputRow}>
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf,.zip,.txt,.md,.json,.csv,.js,.ts,.tsx,.jsx,.html,.css,.py,.rs,.go,.java,.rb,.sh,.yaml,.yml,.xml,.svg"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileAttach}
                disabled={chatComposerDisabled || imageMode}
              />
              <textarea
                ref={inputRef}
                className={styles.chatTextInput}
                placeholder={
                  currentPeerNotFound && !imageMode
                    ? 'Peer was not found. Choose another service from Discover to continue.'
                    : voiceState === 'recording'
                    ? 'Recording… click the mic again to transcribe, or press Esc to cancel'
                    : voiceState === 'transcribing'
                      ? 'Transcribing locally…'
                      : snap.chatInputDisabled
                        ? 'Type your next message — it will send when the current response finishes…'
                        : imageMode
                          ? 'Describe the image you want to create…'
                          : 'Type a message... (Shift+Enter for newline)'
                }
                rows={1}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                disabled={chatComposerDisabled}
              />
              <div className={styles.chatInputBottom}>
                <div className={styles.chatInputActionsLeft}>
                  <button
                    className={`${styles.chatAttachBtn} ${supportsMultimodal ? '' : styles.chatAttachBtnLimited}`}
                    title={imageMode ? 'Image generation currently accepts a text prompt only' : supportsMultimodal ? 'Attach files' : "Attach files (images unavailable for selected model)"}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={chatComposerDisabled || imageMode}
                    type="button"
                  >
                    <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2} />
                  </button>
                  <button
                    className={`${styles.chatVoiceBtn} ${voiceState === 'recording' ? styles.chatVoiceBtnRecording : ''}`}
                    title={voiceState === 'recording' ? 'Stop recording and transcribe' : voiceState === 'transcribing' ? 'Transcribing locally…' : 'Record voice message'}
                    onClick={() => void handleVoiceRecord()}
                    disabled={chatComposerDisabled || voiceState === 'transcribing'}
                    type="button"
                  >
                    {voiceState === 'transcribing' ? '…' : <HugeiconsIcon icon={Mic01Icon} size={18} strokeWidth={2} />}
                  </button>
                  {voiceState === 'recording' ? (
                    <span className={styles.chatVoiceTimer}>{formatVoiceElapsed(voiceElapsedMs)}</span>
                  ) : null}
                </div>
                {snap.chatAbortVisible ? (
                  <button className={styles.chatAbortBtn} onClick={handleStop}>
                    Stop
                  </button>
                ) : (
                  <button
                    className={styles.chatSendBtn}
                    disabled={chatSendDisabled}
                    onClick={handleSend}
                    aria-label={imageMode ? 'Generate image' : 'Send message'}
                    title={imageMode ? 'Generate image' : 'Send message'}
                  >
                    {imageMode ? <span className={styles.chatGenerateLabel}>Generate</span> : <HugeiconsIcon icon={ArrowUp02Icon} size={18} strokeWidth={2.5} />}
                  </button>
                )}
              </div>
            </div>
            <div className={styles.chatInputMeta}>
              <div className={styles.permissionModePicker} ref={permissionMenuRef}>
                <button
                  type="button"
                  className={`${styles.permissionModeButton} ${selectedPermissionMode.tone === 'risk' ? styles.permissionModeButtonRisk : styles.permissionModeButtonSafe}`}
                  onClick={() => {
                    if (permissionModeLocked) return;
                    setPermissionMenuOpen((open) => !open);
                  }}
                  disabled={permissionModeLocked}
                  title={permissionModeLocked ? 'Agent access can be changed after the current response finishes.' : undefined}
                  aria-haspopup="menu"
                  aria-expanded={permissionMenuOpen}
                >
                  <HugeiconsIcon
                    icon={snap.chatPermissionMode === 'full' ? SecurityWarningIcon : Shield01Icon}
                    size={14}
                    strokeWidth={1.7}
                  />
                  <span>{selectedPermissionMode.label}</span>
                  <span className={styles.permissionModeChevron} aria-hidden="true" />
                </button>
                {permissionMenuOpen && !permissionModeLocked ? (
                  <div className={styles.permissionModeMenu} role="menu">
                    {PERMISSION_MODES.map((mode) => {
                      const selected = mode.value === snap.chatPermissionMode;
                      return (
                        <button
                          key={mode.value}
                          type="button"
                          className={`${styles.permissionModeOption} ${selected ? styles.permissionModeOptionSelected : ''}`}
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => {
                            actions.setChatPermissionMode(mode.value);
                            setPermissionMenuOpen(false);
                          }}
                        >
                          <HugeiconsIcon
                            icon={mode.value === 'full' ? SecurityWarningIcon : Shield01Icon}
                            size={14}
                            strokeWidth={1.7}
                            className={mode.value === 'full' ? styles.permissionModeOptionIconRisk : styles.permissionModeOptionIconSafe}
                          />
                          <span className={styles.permissionModeOptionLabel}>{mode.label}</span>
                          {selected ? <span className={styles.permissionModeOptionCheck}>✓</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.workspaceButton}
                onClick={() => void actions.chooseWorkspace()}
                title={workspacePath || 'Choose workspace'}
              >
                <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.5} />
                <span className={styles.workspaceLabel}>{workspaceLabel}</span>
              </button>
            </div>
          </div>
        </div>
        {previewOpen && (
          <>
            <div
              className={styles.divider}
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
            />
            <div style={previewStyle}>
              <BrowserPreview
                url={previewTargetUrl}
                onClose={handleClosePreview}
                onNavigate={setPreviewTargetUrl}
                onElementSelected={handleElementSelected}
              />
            </div>
          </>
        )}
      </div>
      <SwitchServiceDialog
        visible={switchDialogOpen}
        currentLabel={currentServiceLabel}
        nextLabel={pendingSwitchModel?.label || 'new model'}
        imageOnly={pendingSwitchModel?.kind === 'image'}
        onContinue={handleSwitchContinue}
        onStartNew={handleSwitchStartNew}
        onCancel={handleSwitchCancel}
      />
      <LowReputationDialog
        visible={lowReputationDialogOpen}
        peerLabel={lowReputationPeer?.label || 'this peer'}
        scoreLabel={lowReputationPeer ? (lowReputationPeer.score / 10).toFixed(1) : ''}
        onContinue={handleLowReputationContinue}
        onCancel={handleLowReputationCancel}
      />
      {previewAttachment && (
        <AttachmentViewer
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </section>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function isImageAttachmentLike(name: string, mimeType: string): boolean {
  if (mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|ico|tiff?)$/i.test(name);
}

function getAttachmentExtension(name: string): string {
  const ext = name.split('.').pop()?.trim();
  return ext && ext !== name ? ext.slice(0, 4).toUpperCase() : 'FILE';
}
