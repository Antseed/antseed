import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { PencilEdit02Icon } from '@hugeicons/core-free-icons';
import { Logo } from '@antseed/ui';
import type { ViewName } from '../types';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import { selectHeadlineBalanceUsdc } from '../../core/balance';
import { shouldNotifyAppsOnboarding } from '../../modules/app/apps-onboarding';
import { gatewayResource } from '../../modules/app/vpr-resources';
import { useCachedResource } from '../../modules/app/cached-resource';
import { navViews } from './viewRegistry';
import { ChatListPanel } from './ChatListPanel';
import { DepositProgressBanner } from './DepositProgressBanner';
import { NetworkAlertBanner } from './NetworkAlertBanner';
import { UpdateBanner } from './UpdateBanner';
import { SidebarBalance } from './vpr/SidebarBalance';
import { VprNavContext } from './vpr/VprNavContext';
import { VprHeaderActions } from './vpr/VprHeaderActions';
import { usePrivateMode } from './vpr/PrivacyToggle';
import { setPrivateNight } from '../lib/theme';
import styles from './VprShell.module.scss';

/* Views built on VprPage carry Help and API keys inside their pinned header,
   so the shell's floating toolbar would duplicate them. */
const VIEWS_WITH_HEADER_ACTIONS: ReadonlySet<ViewName> = new Set<ViewName>([
  'chat',
  'tools',
  'rewards',
  'deposit',
  'preferences',
  'help',
]);

declare const __APP_VERSION__: string;

type VprShellProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
  onNavigateBack: (fallback: ViewName) => void;
  children: React.ReactNode;
};

const mainNavEntries = navViews('main');
const bottomNavEntries = navViews('bottom');

function gatewayStatusText(status: { mode: 'local' | 'remote'; reachable: boolean; origin: string | null } | undefined): string {
  if (!status) return 'Gateway starting';
  const where = status.mode === 'local' ? 'Local gateway' : (status.origin?.replace(/^https?:\/\//, '') ?? 'Remote gateway');
  return `${where} · ${status.reachable ? 'ready' : 'unreachable'}`;
}

export function VprShell({ activeView, onSelectView, onNavigateBack, children }: VprShellProps) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    headlineBalanceUsdc: selectHeadlineBalanceUsdc(state),
    chatNeedsAttention: state.chatSendingConversationIds.length > 0,
  }), shallowEqual);
  const gateway = useCachedResource(gatewayResource);
  const gatewayStatus = gateway.data?.status;
  const privateMode = usePrivateMode();

  // Private shows the night palette everywhere while it's on.
  useEffect(() => {
    setPrivateNight(privateMode);
    return () => setPrivateNight(false);
  }, [privateMode]);

  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  const navValue = useMemo(
    () => ({ navigate: onSelectView, back: onNavigateBack }),
    [onSelectView, onNavigateBack],
  );

  const startNewChat = useCallback(() => {
    actions.startNewChat();
    onSelectView('home');
  }, [actions, onSelectView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startNewChat]);

  const openConversation = useCallback(() => onSelectView('chat'), [onSelectView]);
  const isMac = globalThis.window?.antseedDesktop?.platform === 'darwin';

  return (
    <div className={styles.shell}>
      {/* Window-drag handle: the hidden-inset title bar has no native drag
          region, so this strip provides one. pointer-events: none keeps web
          clicks working; interactive elements overlapping it opt out with
          -webkit-app-region: no-drag. */}
      <div className={styles.dragStrip} aria-hidden="true" />
      <nav className={styles.sidebar} aria-label="Main navigation">
        <Logo height={24} className={styles.logo} />
        <button type="button" className={styles.newChat} onClick={startNewChat}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={18} strokeWidth={1.7} />
          <span className={styles.newChatLabel}>New chat</span>
          <kbd className={styles.shortcut}>{isMac ? '⌘N' : 'Ctrl+N'}</kbd>
        </button>
        <div className={styles.navGroup}>
          {mainNavEntries.map(({ view, nav }) => {
            // Home stays lit while a conversation is open: that is where chats start.
            const active = activeView === view || (view === 'home' && activeView === 'chat');
            return (
              <button
                key={view}
                type="button"
                className={`${styles.navButton}${active ? ` ${styles.navButtonActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(view)}
              >
                <HugeiconsIcon icon={nav.icon} size={18} strokeWidth={1.7} />
                <span className={styles.navLabel}>{nav.label}</span>
                {view === 'home' && snap.chatNeedsAttention && activeView !== 'chat' && (
                  <span className={styles.navDot} aria-label="Chat activity" />
                )}
                {/* One-shot onboarding nudge: the user hasn't opened Apps
                    yet — opening it plays the connect-your-tools walkthrough
                    and clears the dot for good. */}
                {view === 'tools' && activeView !== 'tools' && shouldNotifyAppsOnboarding() && (
                  <span className={styles.navDot} aria-label="Connect your apps" />
                )}
              </button>
            );
          })}
        </div>
        <ChatListPanel onOpenConversation={openConversation} highlightActive={activeView === 'chat'} />
        <SidebarBalance credits={snap.headlineBalanceUsdc} onAddFunds={() => onSelectView('deposit')} />
        {bottomNavEntries.map(({ view, nav }) => (
          <button
            key={view}
            type="button"
            className={`${styles.navButton}${activeView === view ? ` ${styles.navButtonActive}` : ''}`}
            aria-current={activeView === view ? 'page' : undefined}
            onClick={() => onSelectView(view)}
          >
            <HugeiconsIcon icon={nav.icon} size={18} strokeWidth={1.7} />
            <span className={styles.navLabel}>{nav.label}</span>
          </button>
        ))}
        <p className={styles.status}>
          <span className={gatewayStatus && !gatewayStatus.reachable ? `${styles.statusItem} ${styles.statusWarn}` : styles.statusItem}>
            {gatewayStatusText(gatewayStatus)}
          </span>
          <span className={styles.statusVersion}>v{appVersion}</span>
        </p>
      </nav>
      <main className={styles.mainPane}>
        <div className={styles.content}>
          <VprNavContext.Provider value={navValue}>{children}</VprNavContext.Provider>
        </div>
        {/* The no-drag carve-out lives on this static wrapper: the toolbar
            itself runs a compositor scroll-timeline animation, and animated
            elements don't reliably register app-region rects. The slot must
            also come AFTER the view content in the DOM — app-region rects
            are collected in document order and later drag regions (e.g. the
            home view's hero banner) would otherwise paint over the toolbar's
            no-drag hole and swallow its clicks. */}
        {!VIEWS_WITH_HEADER_ACTIONS.has(activeView) && (
          <div className={styles.creditsPillSlot}>
            <VprHeaderActions className={styles.creditsPill} onSelectView={onSelectView} />
          </div>
        )}
        <NetworkAlertBanner />
        <UpdateBanner />
        <DepositProgressBanner onAddFunds={() => onSelectView('deposit')} onDepositView={activeView === 'deposit'} />
      </main>
    </div>
  );
}
