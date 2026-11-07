import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, useId } from 'react';
import type { KeyboardEvent } from 'react';
import { Logo } from '@antseed/ui';
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
  Search01Icon,
  SecurityWarningIcon,
  Shield01Icon
} from '@hugeicons/core-free-icons';
import { findChatModel, fundsNoticeAction } from '../../../modules/chat/models';
import { modelAcceptsImages } from '../../../../shared/pinned-model.js';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import { ChatBubble } from '../chat/ChatBubble';
import { isImageRequestPhase } from '../chat/chat-shared';
import { hasSearchPhraseMatch, isToolResultOnlyMessage } from '../chat/chat-utils.js';
import { ThinkingDots } from '../chat/ThinkingDots';
import { ImageGenerationPlaceholder } from '../chat/ImageGenerationPlaceholder';
import { ToolApprovalCard } from '../chat/ToolApprovalCard';
import { FundingStatusNotice } from './FundingStatusNotice';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import { ChatBoxAnt } from '../chat/ChatBoxAnt';
import { ChatNote } from '../chat/ChatNote';
import { ChatModelDropdown } from '../chat/ChatModelDropdown';
import { ChatSellerPicker } from '../chat/ChatSellerPicker';
import { joinPinnedModel } from '../../../../shared/pinned-model.js';
import { AttachmentViewer, type ViewerAttachment } from '../chat/AttachmentViewer';
import { BrowserPreview } from '../BrowserPreview';
import type { ChatMessage } from '../chat/chat-shared';
import { buildDisplayMessages } from '../chat/chat-shared';
import type { ChatPermissionMode, RawChatAttachment } from '../../../types/bridge';
import { VprHeaderActions } from '../vpr/VprHeaderActions';
import { cancelVoiceRecording, startVoiceRecording, stopVoiceRecording } from '../../lib/voice-recorder';
import { modelsForPrivacy, usePrivateMode } from '../vpr/PrivacyToggle';
import { gatewayResource, usePrivacySwitch } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import styles from './ChatView.module.scss';
import bubbleStyles from '../chat/ChatBubble.module.scss';

const MAX_INPUT_HEIGHT = 220;
const PREVIEW_MIN_WIDTH = 280;
const CHAT_MIN_WIDTH = 320;
const DEFAULT_PREVIEW_FRACTION = 0.5;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Source videos for video edits; the agent reads them by path, so they never enter the prompt. */
const MAX_VIDEO_ATTACHMENT_BYTES = 50 * 1024 * 1024;
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
  messageSearchOpen: boolean;
  messageSearchQuery: string;
  selectedSearchIndex: number;
  pendingQueue: PendingDraft[];
  previewAttachment: ViewerAttachment | null;
  permissionMenuOpen: boolean;
  isNearBottom: boolean;
  hasNewActivityWhileScrolledUp: boolean;
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
  messageSearchOpen: false,
  messageSearchQuery: '',
  selectedSearchIndex: 0,
  pendingQueue: [],
  previewAttachment: null,
  permissionMenuOpen: false,
  isNearBottom: true,
  hasNewActivityWhileScrolledUp: false,
};

export function ChatView({ onSelectView }: ChatViewProps) {
  const privateMode = usePrivateMode();
  // Nothing goes out until a mode change has reached the routing policy.
  const { switching: privacySwitching } = usePrivacySwitch();
  const gatewayMode = useCachedResource(gatewayResource).data?.status.mode;
  // Blockers only (a deposit short of the minimum, credits all held in
  // sessions); dismissing hides this one until the situation changes.
  const funding = useFundingStatus();
  const fundingKey = `${funding.kind}:${funding.title}`;
  const [dismissedFundingKey, setDismissedFundingKey] = useState<string | null>(null);
  const snap = useUiSelector((state) => ({
    browserPreviewRequestId: state.browserPreviewRequestId,
    browserPreviewUrl: state.browserPreviewUrl,
    chatAbortVisible: state.chatAbortVisible,
    chatActiveConversation: state.chatActiveConversation,
    chatConversations: state.chatConversations,
    chatConversationsLoaded: state.chatConversationsLoaded,
    chatError: state.chatError,
    chatFundsNotice: state.chatFundsNotice,
    chatImageModelId: state.chatImageModelId,
    chatInputDisabled: state.chatInputDisabled,
    chatMessages: state.chatMessages,
    chatModels: state.chatModels,
    chatModelsError: state.chatModelsError,
    chatModelsLoading: state.chatModelsLoading,
    chatOpeningConversationId: state.chatOpeningConversationId,
    chatPermissionMode: state.chatPermissionMode,
    chatSelectedModelId: state.chatSelectedModelId,
    chatSendDisabled: state.chatSendDisabled,
    chatSending: state.chatSending,
    chatSendingConversationId: state.chatSendingConversationId,
    chatSendingConversationIds: state.chatSendingConversationIds,
    chatStreamingMessage: state.chatStreamingMessage,
    chatThinkingPhase: state.chatThinkingPhase,
    chatToolApprovalRequests: state.chatToolApprovalRequests,
    chatWorkspaceDefaultPath: state.chatWorkspaceDefaultPath,
    chatWorkspacePath: state.chatWorkspacePath,
  }), shallowEqual);
  const actions = useActions();
  const [inputValue, setInputValue] = useRetainedState(chatViewCache, 'inputValue');
  const [attachedFiles, setAttachedFiles] = useRetainedState(chatViewCache, 'attachedFiles');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [sellerMenuOpen, setSellerMenuOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useRetainedState(chatViewCache, 'attachmentError');
  const [attachmentWarning, setAttachmentWarning] = useRetainedState(chatViewCache, 'attachmentWarning');
  const [voiceError, setVoiceError] = useRetainedState(chatViewCache, 'voiceError');
  const [voiceState, setVoiceState] = useRetainedState(chatViewCache, 'voiceState');
  const [voiceElapsedMs, setVoiceElapsedMs] = useRetainedState(chatViewCache, 'voiceElapsedMs');
  const [isDragOver, setIsDragOver] = useRetainedState(chatViewCache, 'isDragOver');
  const [previewOpen, setPreviewOpen] = useRetainedState(chatViewCache, 'previewOpen');
  const [previewFraction, setPreviewFraction] = useRetainedState(chatViewCache, 'previewFraction');
  const [previewTargetUrl, setPreviewTargetUrl] = useRetainedState(chatViewCache, 'previewTargetUrl');
  const [messageSearchOpen, setMessageSearchOpen] = useRetainedState(chatViewCache, 'messageSearchOpen');
  const [messageSearchQuery, setMessageSearchQuery] = useRetainedState(chatViewCache, 'messageSearchQuery');
  const [selectedSearchIndex, setSelectedSearchIndex] = useRetainedState(chatViewCache, 'selectedSearchIndex');
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

  // A new note lands below the last message: bring it into view.
  const noteKey = [snap.chatError, snap.chatFundsNotice?.message, attachmentError, voiceError].filter(Boolean).join('|');
  useEffect(() => {
    const el = scrollRef.current;
    if (noteKey && el) el.scrollTop = el.scrollHeight;
  }, [noteKey]);

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

  const selectedTextModel = findChatModel(snap.chatModels, snap.chatSelectedModelId);
  const imageModel = findChatModel(snap.chatModels, snap.chatImageModelId);
  const fundsAction = fundsNoticeAction(snap.chatFundsNotice?.canAddFunds ?? false, gatewayMode);
  // An image model picked in the dropdown makes Send generate an image until
  // the user picks a text model again; the conversation keeps its text model.
  const imageMode = imageModel?.type === 'image';
  // Unknown models (a plain OpenAI-compatible gateway, or the list still
  // loading) are treated as text-only.
  const supportsMultimodal = selectedTextModel ? modelAcceptsImages(selectedTextModel, snap.chatSelectedModelId) : false;
  const hasAttachedImages = useMemo(
    () => attachedFiles.some((file) => isImageAttachmentLike(file.name, file.mimeType)),
    [attachedFiles],
  );
  const noModelAvailable = !snap.chatSelectedModelId && !imageMode;

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
    if (snap.chatInputDisabled) return;
    // preventScroll: this runs on mount, while the view-slide transition still
    // has the pane translated off-screen. A plain focus() makes Chromium
    // scroll the overflow-hidden ancestors to reveal the input, visibly
    // jerking the pane mid-slide.
    if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    if (activePendingQueue.length === 0) return;
    // Nothing goes out under a policy the screen doesn't show.
    if (privacySwitching) return;
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
  }, [snap.chatInputDisabled, activePendingQueue, actions, privacySwitching]);

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

  // Start a fresh conversation on the model this one uses.
  const handleNewChatWithCurrentModel = useCallback(() => {
    const { chatSelectedModelId: modelId, chatImageModelId: imageModelId } = snap;
    actions.startNewChat();
    if (modelId) actions.selectChatModel(modelId);
    // Choosing a text model leaves image mode, so the image model goes back on last.
    if (imageModelId) actions.selectChatModel(imageModelId);
    inputRef.current?.focus();
  }, [actions, snap.chatSelectedModelId, snap.chatImageModelId]);

  // Toggle between the thin chat panel and the expanded layout. The store
  // flag drives both the conversation-list panel (VprShell) and the window
  // size preset (AppShell).
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
    if (noModelAvailable || privacySwitching) return;
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

    const filesToSend = attachedFiles;
    resetComposer();
    if (imageMode) {
      actions.generateImage(text);
    } else {
      actions.sendMessage(text, filesToSend);
    }
    scrollChatToBottom('smooth');
  }, [inputValue, attachedFiles, actions, snap.chatInputDisabled, snap.chatActiveConversation, resetComposer, noModelAvailable, privacySwitching, imageMode]);

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
        nextError = "Selected model doesn't accept images. Switch to a vision model to attach image files.";
        continue;
      }
      if (attachedFiles.length + accepted.length >= MAX_ATTACHMENTS) {
        nextError = `Only ${MAX_ATTACHMENTS} attachments are allowed per message.`;
        break;
      }
      const video = isVideoAttachmentLike(file.name, file.type);
      if (file.size > (video ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES)) {
        nextError = `${file.name || 'Attachment'} exceeds the ${video ? 50 : 25} MiB per-file limit.`;
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
    setAttachmentWarning("Selected model doesn't accept images. Attached images will be omitted when you send this message.");
  }, [attachedFiles.length, hasAttachedImages, imageMode, supportsMultimodal]);

  useEffect(() => {
    if (supportsMultimodal && attachmentError?.includes("doesn't accept images")) {
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
    if (imageMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, [imageMode]);

  const handleFileDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (imageMode) return;
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, [imageMode]);

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (imageMode) return;
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) void attachFiles(e.dataTransfer.files);
  }, [attachFiles, imageMode]);


  const handleInput = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, MAX_INPUT_HEIGHT);
      inputRef.current.style.height = `${newHeight}px`;
      inputRef.current.style.overflowY = inputRef.current.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
    }
  }, []);

  const handleVoiceRecord = useCallback(async () => {
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
  }, [handleInput, voiceState]);

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
  const chatComposerDisabled = noModelAvailable;
  const chatSendDisabled = chatComposerDisabled
    || privacySwitching
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

  return (
    <section className={`view view-chat`} role="tabpanel">
      <div className={styles.pageHeader} data-glide-fade>
        <div className={styles.pageHeaderLeft}>
          <div className={styles.serviceSwitcherAnchor}>
            <ChatModelDropdown
              onOpenChange={setModelMenuOpen}
              models={modelsForPrivacy(snap.chatModels, privateMode)}
              selectedModelId={imageMode ? snap.chatImageModelId ?? '' : snap.chatSelectedModelId}
              loading={snap.chatModelsLoading}
              error={snap.chatModelsError}
              disabled={(snap.chatInputDisabled || snap.chatSending) && !imageRequestInProgress}
              onSelect={(modelId) => actions.selectChatModel(modelId)}
              onOpen={() => void actions.refreshChatModels()}
              onRetry={() => void actions.refreshChatModels(true)}
            />
            {!imageMode && snap.chatSelectedModelId ? (
              <ChatSellerPicker
                onOpenChange={setSellerMenuOpen}
                modelId={snap.chatSelectedModelId}
                disabled={snap.chatInputDisabled || snap.chatSending}
                onChange={(peerId) => actions.selectChatModel(joinPinnedModel(snap.chatSelectedModelId, peerId))}
              />
            ) : null}
          </div>
        </div>
          <div className={`${styles.pageHeaderRight}${messageSearchOpen ? ` ${styles.pageHeaderRightSearching}` : ''}`}>
            {snap.chatActiveConversation && <>
            {snap.chatSelectedModelId && (
              <button
                type="button"
                className={styles.headerActionButton}
                onClick={handleNewChatWithCurrentModel}
                title="Start a new chat with the same model"
                aria-label="Start a new chat with the same model"
              >
                <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                <span>New chat</span>
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
            <VprHeaderActions onSelectView={onSelectView} />
          </div>
      </div>

      {showWelcome && (
        <button
          className={styles.chatExternalHint}
          onClick={() => onSelectView?.('tools')}
        >
          <span>Use your gateway in your other apps too</span>
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
          <div className={styles.chatMessages} ref={scrollRef} data-chat-scroll data-glide-fade>
            {showWelcome ? (
              <div className={styles.chatWelcome}>
                <Logo height={32} />
                <div className={styles.chatWelcomeSubtitle}>
                  {snap.chatModelsError && !snap.chatSelectedModelId
                    ? snap.chatModelsError
                    : 'Pick a model and start typing.'}
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
              <ThinkingDots label={snap.chatThinkingPhase} />
            ) : null}
            {snap.chatError && <ChatNote>{snap.chatError}</ChatNote>}
            {snap.chatFundsNotice && (
              <ChatNote
                actions={[
                  ...(fundsAction === 'deposit'
                    ? [{ label: 'Add funds', primary: true, onClick: () => onSelectView?.('deposit') }]
                    : []),
                  ...(fundsAction === 'console'
                    ? [{ label: 'Open gateway console', primary: true, onClick: () => { void window.antseedDesktop?.gatewayOpenConsole?.('/'); } }]
                    : []),
                  ...(privacySwitching ? [] : [{ label: 'Try again', onClick: () => actions.retryAfterPayment() }]),
                  { label: 'Dismiss', onClick: () => actions.dismissFundsNotice() },
                ]}
              >
                {snap.chatFundsNotice.message}
              </ChatNote>
            )}
            {attachmentError && <ChatNote>{attachmentError}</ChatNote>}
            {voiceError && <ChatNote>{voiceError}</ChatNote>}
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
            {attachmentWarning && <div className={styles.chatWarning}>{attachmentWarning}</div>}
            {/* This device's wallet doesn't pay for a remote gateway. */}
            {gatewayMode !== 'remote' && dismissedFundingKey !== fundingKey ? (
              <FundingStatusNotice
                variant="strip"
                status={funding}
                includeInfo={false}
                onAddFunds={() => onSelectView?.('deposit')}
                onDismiss={() => setDismissedFundingKey(fundingKey)}
              />
            ) : null}
            <ToolApprovalCard
              request={activeToolApprovalRequest}
              pendingCount={activeToolApprovalRequests.length}
              onAllowOnce={() => activeToolApprovalRequest && actions.decideToolApproval('allow_once', activeToolApprovalRequest.id)}
              onAlwaysAllow={() => activeToolApprovalRequest && actions.decideToolApproval('always_allow', activeToolApprovalRequest.id)}
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

            <div className={styles.chatInputRow} data-composer>
              <ChatBoxAnt
                typing={inputValue.length > 0}
                sending={snap.chatSending}
                answering={Boolean(snap.chatStreamingMessage)}
                error={snap.chatError ?? snap.chatFundsNotice?.message ?? null}
                privateMode={privateMode}
                hidden={Boolean(activeToolApprovalRequest) || Boolean(attachmentWarning) || modelMenuOpen || sellerMenuOpen}
              />
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf,.zip,.txt,.md,.json,.csv,.js,.ts,.tsx,.jsx,.html,.css,.py,.rs,.go,.java,.rb,.sh,.yaml,.yml,.xml,.svg"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileAttach}
                disabled={chatComposerDisabled || imageMode}
              />
              <textarea
                ref={inputRef}
                className={styles.chatTextInput}
                placeholder={
                  noModelAvailable
                    ? 'Choose a model to start chatting.'
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

function isVideoAttachmentLike(name: string, mimeType: string): boolean {
  return mimeType === 'video/mp4' || mimeType === 'video/quicktime' || /\.(mp4|mov|m4v)$/i.test(name);
}

function getAttachmentExtension(name: string): string {
  const ext = name.split('.').pop()?.trim();
  return ext && ext !== name ? ext.slice(0, 4).toUpperCase() : 'FILE';
}
