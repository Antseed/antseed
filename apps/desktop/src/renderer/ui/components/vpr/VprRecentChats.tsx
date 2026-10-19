import type { JSX } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, ArrowRight02Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import type { BuyerConversationSummary, SystemProxyProfileSummary } from '../../../types/bridge';
import {
  catalogModelLabel,
  conversationAge,
  conversationCost,
  conversationMatchesApp,
  conversationRoutedServiceId,
  conversationTitle,
  isConversationActive,
  shortSessionId,
} from '../../../modules/routing/conversations';
import { displayToolName } from '../../../modules/routing/tool-names';
import { BrandIcon } from '@antseed/ui';
import styles from './VprRecentChats.module.scss';

/* Chat rows sampled on the card — the full list lives on the Chats page. */
const CARD_SAMPLE_COUNT = 3;

/** The model a chat runs on: its latest route (updated when a seller is
    chosen, so an in-app model switch shows before the answer finishes)
    resolved through the catalog, falling back to the default-route label for
    chats that haven't started yet. */
export function chatModelLabel(
  chat: BuyerConversationSummary,
  catalog: VprModelCatalogEntry[],
  defaultModelLabel: string | null,
): string {
  const serviceId = conversationRoutedServiceId(chat);
  if (!serviceId) return defaultModelLabel ?? '';
  return catalogModelLabel(catalog, serviceId);
}

/** One chat row: title + session id on the first line, tool · time on the
    second with the model right-aligned under the cost — the same layout as
    the floating pill's dropdown. */
function appForConversation(
  chat: BuyerConversationSummary,
  profiles: SystemProxyProfileSummary[],
): SystemProxyProfileSummary | null {
  return profiles.find((profile) => conversationMatchesApp(chat.tool, profile)) ?? null;
}

export function VprChatRow({ chat, modelLabel, routedPeerName, profiles = [], onClick }: {
  chat: BuyerConversationSummary;
  modelLabel: string;
  /** Seller that served the chat's last request, appended after the model
      (the "Show routed peer" debug preference) — pass only while it's on. */
  routedPeerName?: string | null;
  profiles?: SystemProxyProfileSummary[];
  onClick: () => void;
}): JSX.Element {
  const title = conversationTitle(chat);
  const cost = conversationCost(chat);
  const app = appForConversation(chat, profiles);
  return (
    <button type="button" className={styles.chatRow} onClick={onClick} title={title}>
      {app?.iconDataUri
        ? <img src={app.iconDataUri} alt="" className={styles.appIcon} />
        : <BrandIcon name={app?.name ?? chat.tool} hints={[app?.displayName ?? chat.tool]} size={18} />}
      <span className={styles.chatText}>
        <span className={styles.chatTitleLine}>
          <span className={styles.chatTitle}>{title}</span>
          {isConversationActive(chat.lastActiveAt)
            ? <span className={styles.runningDot} role="img" aria-label="Receiving traffic" />
            : null}
          <span className={styles.sessionId}>{shortSessionId(chat.sessionKey)}</span>
          {cost ? <span className={styles.chatCost}>{cost}</span> : null}
        </span>
        <span className={styles.chatMeta}>
          <span className={styles.chatMetaText}>
            {app?.displayName ?? displayToolName(chat.tool)} · {conversationAge(chat.lastActiveAt)}
          </span>
          {modelLabel || routedPeerName ? (
            <span className={styles.chatModel}>
              {modelLabel}
              {routedPeerName ? <span className={styles.chatPeer}>{modelLabel ? ' · ' : ''}{routedPeerName}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
      <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.chatChevron} />
    </button>
  );
}

const HAS_CHATS_KEY = 'antseed.desktop.vpr.hasChats';

/** Whether a previous fetch saw at least one tool chat. Gates the loading
    skeletons: first-run users (no chats yet) would otherwise get a flash of
    placeholder rows that resolves to nothing. */
export function hasSeenChats(): boolean {
  try {
    return localStorage.getItem(HAS_CHATS_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberSeenChats(count: number): void {
  try {
    if (count > 0) localStorage.setItem(HAS_CHATS_KEY, '1');
    else localStorage.removeItem(HAS_CHATS_KEY);
  } catch { /* localStorage unavailable */ }
}

/** Placeholder rows while the buyer hasn't answered the first conversations
    query yet (it boots alongside the app) — same silhouette as VprChatRow. */
export function VprChatRowsSkeleton({ rows = 2 }: { rows?: number }): JSX.Element {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <span className={styles.skeletonIcon} />
          <span className={styles.skeletonText}>
            <span className={styles.skeletonLine} />
            <span className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Full-width "Recent chats" sample card; every interaction leads to the
    dedicated Chats page (via onOpen), where chats are managed. Shows
    skeleton rows while the chat list is still loading, and renders nothing
    once it's known that no tool chat has been seen. */
export function VprRecentChatsCard({ conversations, catalog, defaultModelLabel, routedPeerNameFor, profiles = [], loading, onOpen }: {
  conversations: BuyerConversationSummary[];
  catalog: VprModelCatalogEntry[];
  defaultModelLabel: string | null;
  /** Resolves a chat's routed seller name (the "Show routed peer" debug
      preference) — pass only while it's on. */
  routedPeerNameFor?: (chat: BuyerConversationSummary) => string | null;
  profiles?: SystemProxyProfileSummary[];
  loading?: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  if (conversations.length === 0) {
    if (!loading) return null;
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.headTitle}>Recent chats</span>
        </div>
        <VprChatRowsSkeleton />
      </div>
    );
  }
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.headTitle}>Recent chats</span>
        <button type="button" className={styles.viewAll} onClick={onOpen}>
          View all
          <HugeiconsIcon icon={ArrowRight02Icon} size={13} strokeWidth={2} />
        </button>
      </div>
      {conversations.slice(0, CARD_SAMPLE_COUNT).map((chat) => (
        <VprChatRow
          key={chat.id}
          chat={chat}
          modelLabel={chatModelLabel(chat, catalog, defaultModelLabel)}
          routedPeerName={routedPeerNameFor?.(chat)}
          profiles={profiles}
          onClick={onOpen}
        />
      ))}
    </div>
  );
}
