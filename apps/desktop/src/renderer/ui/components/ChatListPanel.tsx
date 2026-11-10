import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  type MouseEvent,
  type RefObject,
} from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  Folder01Icon,
  GitBranchIcon,
  MoreVerticalIcon,
  PinIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { formatCompactTokens } from '../../core/peer-utils';
import { formatUsdcAmount } from '../../core/format';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import type { ConversationFlags } from '../../types/bridge';
import { buildChatSections, folderName, projectFolder, type ChatSection } from './chat-list-sections';
import styles from './ChatListPanel.module.scss';

type ConvRecord = Record<string, unknown>;

const EMPTY_CONVERSATIONS: unknown[] = [];
const RECENT_SESSION_CLOCK_MS = 60 * 1000;
const COLLAPSED_SECTIONS_KEY = 'antseed.chatList.collapsedSections';


function readCollapsedSections(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedSections(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage unavailable; sections open expanded next time.
  }
}

function formatChatTime(timestamp: unknown): string {
  const ts = Number(timestamp);
  if (!ts || ts <= 0) return 'n/a';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** The conversation's model as the gateway names it, else its raw id. */
function modelName(service: unknown, modelLabelById: ReadonlyMap<string, string>): string {
  const id = String(service || '').trim();
  return id ? modelLabelById.get(id) ?? id : '';
}

function getConversationId(conv: ConvRecord): string {
  return String(conv.id ?? '');
}

function getConversationCreatedAt(conv: ConvRecord): number {
  const createdAt = Number(conv.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

function getConversationUpdatedAt(conv: ConvRecord): number {
  const updatedAt = Number(conv.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  return getConversationCreatedAt(conv);
}

function compareConversationsByActivity(left: ConvRecord, right: ConvRecord): number {
  const updatedDelta = getConversationUpdatedAt(right) - getConversationUpdatedAt(left);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = getConversationCreatedAt(right) - getConversationCreatedAt(left);
  if (createdDelta !== 0) return createdDelta;

  return getConversationId(left).localeCompare(getConversationId(right));
}

function conversationMatchesSearch(
  conv: ConvRecord,
  modelLabel: string,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [
    conv.title,
    conv.service,
    conv.workspacePath,
    modelLabel,
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return terms.every((term) => haystack.includes(term));
}

/** The menu sits inside its row, whose click opens the chat. Without this,
 *  Delete would re-open the conversation it just removed. */
function stopRowClick(event: MouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

function ConvContextMenu({
  convId,
  convTitle,
  pinned,
  archived,
  anchorRef,
  onDelete,
  onSetFlags,
  onClose,
}: {
  convId: string;
  convTitle: string;
  pinned: boolean;
  archived: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onDelete: (id: string) => void;
  onSetFlags: (id: string, flags: ConversationFlags) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(convTitle);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const actions = useActions();

  useEffect(() => {
    function handleClick(e: globalThis.MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      cancelledRef.current = false;
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const handleRenameSubmit = useCallback(() => {
    if (cancelledRef.current) return;
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== convTitle) {
      actions.renameConversation(convId, trimmed);
    }
    onClose();
  }, [renameValue, convTitle, convId, actions, onClose]);

  if (renaming) {
    return (
      <div className={styles.contextMenu} ref={menuRef} onClick={stopRowClick}>
        <input
          ref={renameInputRef}
          className={styles.renameInput}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRenameSubmit();
            if (e.key === 'Escape') { cancelledRef.current = true; onClose(); }
          }}
          onBlur={() => {
            setTimeout(() => {
              if (!cancelledRef.current) handleRenameSubmit();
            }, 100);
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.contextMenu} ref={menuRef} onClick={stopRowClick} role="menu">
      <button
        className={styles.contextItem}
        role="menuitem"
        onClick={() => {
          onSetFlags(convId, { pinned: !pinned });
          onClose();
        }}
      >
        {pinned ? 'Unpin' : 'Pin'}
      </button>
      <button
        className={styles.contextItem}
        role="menuitem"
        onClick={() => {
          onSetFlags(convId, { archived: !archived });
          onClose();
        }}
      >
        {archived ? 'Unarchive' : 'Archive'}
      </button>
      <button className={styles.contextItem} role="menuitem" onClick={() => setRenaming(true)}>
        Rename
      </button>
      <button
        className={`${styles.contextItem} ${styles.contextItemDanger}`}
        role="menuitem"
        onClick={() => {
          onDelete(convId);
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

function ConversationRow({
  conv,
  activeConvId,
  sendingConvIds,
  approvalConvIds,
  modelLabelById,
  defaultWorkspace,
  onSelectConv,
  onDeleteConv,
  onSetFlags,
  menuOpenId,
  setMenuOpenId,
  menuBtnRefs,
}: {
  conv: ConvRecord;
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  approvalConvIds: ReadonlySet<string>;
  modelLabelById: ReadonlyMap<string, string>;
  defaultWorkspace: string;
  onSelectConv: (id: string) => void;
  onDeleteConv: (id: string) => void;
  onSetFlags: (id: string, flags: ConversationFlags) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  menuBtnRefs: RefObject<Map<string, HTMLButtonElement | null>>;
}) {
  const id = getConversationId(conv);
  const title = String(conv.title || 'Untitled chat');
  const isActive = id === activeConvId;
  const needsApproval = approvalConvIds.has(id);
  const isRunning = sendingConvIds.has(id);
  const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
  const totalTokens = Number(conv.totalTokens) || 0;
  const costLabel = totalTokens > 0
    ? `$${formatUsdcAmount(totalCost)}/${formatCompactTokens(totalTokens)}`
    : '';
  const modelLabel = modelName(conv.service, modelLabelById);
  const timeLabel = formatChatTime(getConversationUpdatedAt(conv));
  const pinned = Number(conv.pinnedAt) > 0;
  const archived = Number(conv.archivedAt) > 0;
  const folder = projectFolder(conv, defaultWorkspace);
  const gitBranch = typeof conv.gitBranch === 'string' ? conv.gitBranch : '';
  // Like Codex's hover card: the chat, its folder and its branch.
  const tooltip = [
    title,
    folder ? `Folder: ${folderName(folder)}` : '',
    gitBranch ? `Branch: ${gitBranch}` : '',
    [modelLabel, costLabel, timeLabel].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');

  return (
    <div
      className={`${styles.convItem}${isActive ? ` ${styles.active}` : ''}${archived ? ` ${styles.archivedItem}` : ''}`}
      onClick={() => onSelectConv(id)}
      title={tooltip}
    >
      <div className={styles.convTop}>
        <div className={styles.convTitle}>{title}</div>
        {(needsApproval || isRunning) && (
          <span
            className={`${styles.runningDot}${needsApproval ? ` ${styles.approvalDot}` : ''}`}
            role="status"
            aria-label={needsApproval ? 'Approval required' : 'Request in progress'}
            title={needsApproval ? 'Approval required' : 'Request in progress'}
          />
        )}
        <div className={styles.convRight}>
          {gitBranch && (
            <span className={styles.branchIcon} aria-label={`Branch ${gitBranch}`} role="img">
              <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.7} />
            </span>
          )}
          <button
            className={styles.menuBtn}
            aria-label="Conversation options"
            ref={(el) => { if (el) menuBtnRefs.current?.set(id, el); else menuBtnRefs.current?.delete(id); }}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenId(menuOpenId === id ? null : id);
            }}
          >
            <HugeiconsIcon icon={MoreVerticalIcon} size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {menuOpenId === id && (
        <ConvContextMenu
          convId={id}
          convTitle={title}
          pinned={pinned}
          archived={archived}
          anchorRef={{ current: menuBtnRefs.current?.get(id) ?? null }}
          onDelete={onDeleteConv}
          onSetFlags={onSetFlags}
          onClose={() => setMenuOpenId(null)}
        />
      )}
    </div>
  );
}

function ChatSearchModal({
  conversations,
  activeConvId,
  sendingConvIds,
  modelLabelById,
  onSelectConv,
  onClose,
}: {
  conversations: ConvRecord[];
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  modelLabelById: ReadonlyMap<string, string>;
  onSelectConv: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const results = useMemo(() => {
    return conversations
      .filter((conv) => conversationMatchesSearch(conv, modelName(conv.service, modelLabelById), query))
      .sort(compareConversationsByActivity);
  }, [conversations, modelLabelById, query]);

  return (
    <div
      className={styles.searchOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={styles.searchModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
      >
        <header className={styles.searchHeader}>
          <div>
            <h2 id="chat-search-title">Conversations</h2>
            <p>Search across every chat title, model and workspace.</p>
          </div>
          <button className={styles.searchClose} onClick={onClose} aria-label="Close chat search">
            ×
          </button>
        </header>

        <input
          ref={inputRef}
          className={styles.searchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations and models..."
        />

        <div className={styles.searchSummary}>
          {results.length} of {conversations.length} conversation{conversations.length === 1 ? '' : 's'}
        </div>

        <div className={styles.searchResults}>
          {results.length === 0 ? (
            <div className={styles.searchEmpty}>No chats match that search.</div>
          ) : (
            results.map((conv) => {
              const id = getConversationId(conv);
              const title = String(conv.title || 'Untitled chat');
              const serviceLabel = modelName(conv.service, modelLabelById);
              const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
              const totalTokens = Number(conv.totalTokens) || 0;
              const costLabel = totalTokens > 0
                ? `$${formatUsdcAmount(totalCost)}/${formatCompactTokens(totalTokens)}`
                : '';
              const timeLabel = formatChatTime(getConversationUpdatedAt(conv));
              const isActive = id === activeConvId;
              const isRunning = sendingConvIds.has(id);

              return (
                <button
                  key={id}
                  className={`${styles.searchResult}${isActive ? ` ${styles.searchResultActive}` : ''}`}
                  onClick={() => {
                    onSelectConv(id);
                    onClose();
                  }}
                >
                  <span className={styles.searchResultMain}>
                    <span className={styles.searchResultTitle}>{title}</span>
                    {isRunning && (
                      <span
                        className={styles.runningDot}
                        role="status"
                        aria-label="Request in progress"
                        title="Request in progress"
                      />
                    )}
                  </span>
                  <span className={styles.searchResultMeta}>
                    {serviceLabel && <span>{serviceLabel}</span>}
                    {costLabel && <span>{costLabel}</span>}
                    <span>{timeLabel}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

/** The sidebar's Recent section: pinned chats, project folders, other chats and archived ones, with search, pin, archive, rename and delete. */
export function ChatListPanel({ onOpenConversation, onOpenConversationDeleted, highlightActive }: {
  onOpenConversation: () => void;
  /** The chat on screen was deleted, so there is nothing left to show. */
  onOpenConversationDeleted: () => void;
  /** Only the chat screen is "in" a conversation; Home starts a new one. */
  highlightActive: boolean;
}) {
  const {
    chatConversations,
    chatActiveConversation,
    chatSendingConversationIds,
    chatToolApprovalRequests,
    chatModels,
    chatWorkspaceDefaultPath,
  } = useUiSelector((state) => ({
    chatWorkspaceDefaultPath: state.chatWorkspaceDefaultPath,
    chatConversations: state.chatConversations,
    chatActiveConversation: state.chatActiveConversation,
    chatSendingConversationIds: state.chatSendingConversationIds,
    chatToolApprovalRequests: state.chatToolApprovalRequests,
    chatModels: state.chatModels,
  }), shallowEqual);
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : EMPTY_CONVERSATIONS;
  const allConversations = conversations as ConvRecord[];
  const sendingConvIds = useMemo(
    () => new Set(Array.isArray(chatSendingConversationIds) ? chatSendingConversationIds : []),
    [chatSendingConversationIds],
  );
  const approvalConvIds = useMemo(() => {
    const ids = new Set<string>();
    const requests = Array.isArray(chatToolApprovalRequests) ? chatToolApprovalRequests : [];
    for (const request of requests) {
      if (request.conversationId) ids.add(request.conversationId);
    }
    return ids;
  }, [chatToolApprovalRequests]);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [recentNow, setRecentNow] = useState(() => Date.now());
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  // Archived starts folded; projects start open.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const stored = readCollapsedSections();
    if (!stored.has('!archived')) stored.add('archived');
    return stored;
  });
  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      // '!archived' records that Archived was opened on purpose.
      if (key === 'archived') {
        if (next.has('archived')) next.delete('!archived'); else next.add('!archived');
      }
      writeCollapsedSections(next);
      return next;
    });
  }, []);
  const menuBtnRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  useEffect(() => {
    const timer = window.setInterval(() => setRecentNow(Date.now()), RECENT_SESSION_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const modelLabelById = useMemo(
    () => new Map(chatModels.map((model) => [model.id, model.label])),
    [chatModels],
  );

  // Pinned, then one group per project folder, then other chats; each sorted
  // with chats touched in the last day first. Archived chats sit folded below.
  const sections = useMemo(
    () => buildChatSections(allConversations, { defaultWorkspace: chatWorkspaceDefaultPath, now: recentNow }),
    [allConversations, chatWorkspaceDefaultPath, recentNow],
  );
  // With nothing pinned, no projects and nothing archived, the list stays flat.
  const flat = sections.length === 1 && sections[0]!.kind === 'chats';

  const handleSelectConv = useCallback((id: string) => {
    void actions.openConversation(id);
    onOpenConversation();
  }, [actions, onOpenConversation]);

  const handleSetFlags = useCallback((id: string, flags: ConversationFlags) => {
    void actions.setConversationFlags(id, flags);
  }, [actions]);

  const renderRow = (conv: ConvRecord) => (
    <ConversationRow
      key={getConversationId(conv)}
      conv={conv}
      activeConvId={highlightActive ? chatActiveConversation : null}
      sendingConvIds={sendingConvIds}
      approvalConvIds={approvalConvIds}
      modelLabelById={modelLabelById}
      defaultWorkspace={chatWorkspaceDefaultPath}
      onSelectConv={handleSelectConv}
      onDeleteConv={handleDeleteConv}
      onSetFlags={handleSetFlags}
      menuOpenId={menuOpenId}
      setMenuOpenId={setMenuOpenId}
      menuBtnRefs={menuBtnRefs}
    />
  );

  const renderSection = (section: ChatSection) => {
    const collapsed = collapsedSections.has(section.key);
    const icon = section.kind === 'pinned' ? PinIcon : section.kind === 'project' ? Folder01Icon : null;
    const activity = section.conversations.some((conv) => sendingConvIds.has(getConversationId(conv))
      || approvalConvIds.has(getConversationId(conv)));
    return (
      <section key={section.key} className={styles.section} aria-label={section.label}>
        <button
          type="button"
          className={`${styles.sectionHeader}${section.kind === 'archived' ? ` ${styles.sectionHeaderArchived}` : ''}`}
          aria-expanded={!collapsed}
          onClick={() => toggleSection(section.key)}
          title={section.path ?? section.label}
        >
          <span className={`${styles.sectionChevron}${collapsed ? '' : ` ${styles.sectionChevronOpen}`}`} aria-hidden="true">
            <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} />
          </span>
          {icon && <HugeiconsIcon icon={icon} size={13} strokeWidth={1.7} className={styles.sectionIcon} />}
          <span className={styles.sectionLabel}>{section.label}</span>
          {collapsed && activity && <span className={styles.runningDot} aria-label="Chat activity" />}
          {(collapsed || section.kind === 'archived') && (
            <span className={styles.sectionCount}>{section.conversations.length}</span>
          )}
        </button>
        {!collapsed && section.conversations.map(renderRow)}
      </section>
    );
  };

  const handleDeleteConv = useCallback((id: string) => {
    const wasOnScreen = highlightActive && id === chatActiveConversation;
    void actions.deleteConversation(id);
    if (wasOnScreen) onOpenConversationDeleted();
  }, [actions, chatActiveConversation, highlightActive, onOpenConversationDeleted]);

  return (
    <aside className={styles.panel} aria-labelledby="chat-list-label">
      <div className={styles.header}>
        <span id="chat-list-label">Recent</span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setChatSearchOpen(true)}
          aria-label="Search conversations"
          title="Search conversations"
        >
          <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className={styles.list}>
        {sections.length === 0 ? (
          <div className={styles.empty}>No conversations yet</div>
        ) : flat ? (
          sections[0]!.conversations.map(renderRow)
        ) : (
          sections.map(renderSection)
        )}
      </div>
      {chatSearchOpen && (
        <ChatSearchModal
          conversations={allConversations}
          activeConvId={chatActiveConversation}
          sendingConvIds={sendingConvIds}
          modelLabelById={modelLabelById}
          onSelectConv={handleSelectConv}
          onClose={() => setChatSearchOpen(false)}
        />
      )}
    </aside>
  );
}
