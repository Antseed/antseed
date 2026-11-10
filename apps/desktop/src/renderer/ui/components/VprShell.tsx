import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { BubbleChatIcon, DashboardSquare01Icon, LinkSquare02Icon, PencilEdit02Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import { Logo, LogoMark } from '@antseed/ui';
import type { ViewName } from '../types';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import { selectHeadlineBalanceUsdc } from '../../core/balance';
import { shouldNotifyAppsOnboarding } from '../../modules/app/apps-onboarding';
import { homeProgress } from '../../modules/app/home-progress';
import { gatewayResource, privacyResource, usePrivacySwitch } from '../../modules/app/vpr-resources';
import { useCachedResource } from '../../modules/app/cached-resource';
import { navViews } from './viewRegistry';
import { ChatListPanel } from './ChatListPanel';
import { DepositProgressBanner } from './DepositProgressBanner';
import { NetworkAlertBanner } from './NetworkAlertBanner';
import { UpdateBanner } from './UpdateBanner';
import { SidebarBalance } from './vpr/SidebarBalance';
import { VprNavContext } from './vpr/VprNavContext';
import { VprHeaderActions } from './vpr/VprHeaderActions';
import { PrivacySwitchDialog } from './vpr/PrivacyToggle';
import { setPrivateNight } from '../lib/theme';
import styles from './VprShell.module.scss';
import { usePrivateMode } from '../hooks/usePrivateMode';

/* Views built on VprPage carry Help and API keys inside their pinned header,
   so the shell's floating toolbar would duplicate them. */
const VIEWS_WITH_HEADER_ACTIONS: ReadonlySet<ViewName> = new Set<ViewName>([
  'chat',
  'tools',
  'rewards',
  'deposit',
  'desktop',
  'connection',
  'config',
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

const SIDEBAR_COLLAPSED_KEY = 'antseed.sidebarCollapsed';

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage unavailable; the sidebar opens expanded next launch.
  }
}

const mainNavEntries = navViews('main');
// Home leads the rail, then Chat with its new-chat button, then the rest.
const homeNavEntry = mainNavEntries.find(({ view }) => view === 'home') ?? null;
const otherNavEntries = mainNavEntries.filter(({ view }) => view !== 'home');
const bottomNavEntries = navViews('bottom');

function gatewayStatusText(status: { mode: 'local' | 'remote'; reachable: boolean; starting?: boolean; origin: string | null } | undefined): string {
  if (!status) return 'Gateway starting';
  const where = status.mode === 'local' ? 'Local gateway' : (status.origin?.replace(/^https?:\/\//, '') ?? 'Remote gateway');
  return `${where} · ${status.reachable ? 'ready' : status.starting ? 'starting' : 'unreachable'}`;
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

  // The gateway's model list follows the mode, wherever the user has gone by
  // the time a switch lands.
  const { switching: privacySwitching } = usePrivacySwitch();
  const privacy = useCachedResource(privacyResource);
  const landedMode = privacySwitching ? null : privacy.data?.mode ?? null;
  const lastLandedMode = useRef(landedMode);
  useEffect(() => {
    if (!landedMode) return;
    const changed = lastLandedMode.current !== null && lastLandedMode.current !== landedMode;
    lastLandedMode.current = landedMode;
    if (changed) void actions.privacySwitchLanded(landedMode);
  }, [actions, landedMode]);

  // Private shows the night palette everywhere while it's on.
  useEffect(() => {
    setPrivateNight(privateMode);
    return () => setPrivateNight(false);
  }, [privateMode]);

  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.()?.then(setAppVersion).catch(() => {});
  }, []);

  const navValue = useMemo(
    () => ({ navigate: onSelectView, back: onNavigateBack }),
    [onSelectView, onNavigateBack],
  );

  // Until the first prompt, new chats start from Home's big chat box.
  const startNewChat = useCallback(() => {
    actions.startNewChat();
    onSelectView(homeProgress.get().firstPromptAt === null ? 'home' : 'chat');
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
  const goHome = useCallback(() => onSelectView('home'), [onSelectView]);
  const openDashboard = useCallback(() => {
    void window.antseedDesktop?.gatewayOpenConsole?.('/');
  }, []);
  const chatActive = activeView === 'chat';
  const isMac = globalThis.window?.antseedDesktop?.platform === 'darwin';

  // Collapsed keeps a rail: the Antseed mark, nav icons and the balance.
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const toggleSidebar = useCallback(() => {
    setCollapsed((current) => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }, []);
  const toggleLabel = collapsed ? 'Show sidebar' : 'Hide sidebar';

  return (
    <div className={`${styles.shell}${collapsed ? ` ${styles.shellCollapsed}` : ''}`}>
      {/* Window-drag handle: the hidden-inset title bar has no native drag
          region, so this strip provides one. pointer-events: none keeps web
          clicks working; interactive elements overlapping it opt out with
          -webkit-app-region: no-drag. */}
      <div className={styles.dragStrip} aria-hidden="true" />
      <nav className={styles.sidebar} aria-label="Main navigation">
        <div className={styles.brandRow}>
          {collapsed ? <LogoMark size={26} className={styles.logo} /> : <Logo height={24} className={styles.logo} />}
          <button
            type="button"
            className={styles.sidebarToggle}
            onClick={toggleSidebar}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            title={toggleLabel}
          >
            <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.7} />
          </button>
        </div>
        {homeNavEntry ? (
          <button
            type="button"
            className={`${styles.navButton}${activeView === 'home' ? ` ${styles.navButtonActive}` : ''}`}
            aria-current={activeView === 'home' ? 'page' : undefined}
            aria-label={collapsed ? homeNavEntry.nav.label : undefined}
            title={collapsed ? homeNavEntry.nav.label : undefined}
            onClick={goHome}
          >
            <HugeiconsIcon icon={homeNavEntry.nav.icon} size={18} strokeWidth={1.7} />
            <span className={styles.navLabel}>{homeNavEntry.nav.label}</span>
          </button>
        ) : null}
        <div className={styles.navRow}>
          <button
            type="button"
            className={`${styles.navButton} ${styles.navButtonWithAction}${chatActive ? ` ${styles.navButtonActive}` : ''}`}
            aria-current={chatActive ? 'page' : undefined}
            aria-label={collapsed ? 'Chat' : undefined}
            title={collapsed ? 'Chat' : undefined}
            onClick={openConversation}
          >
            <HugeiconsIcon icon={BubbleChatIcon} size={18} strokeWidth={1.7} />
            <span className={styles.navLabel}>Chat</span>
            {snap.chatNeedsAttention && !chatActive && <span className={styles.navDot} aria-label="Chat activity" />}
          </button>
          <button
            type="button"
            className={styles.navAction}
            onClick={startNewChat}
            aria-label="New chat"
            title={`New chat (${isMac ? '⌘N' : 'Ctrl+N'})`}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} size={16} strokeWidth={1.7} />
          </button>
        </div>
        <div className={styles.navGroup}>
          {otherNavEntries.map(({ view, nav }) => {
            const active = activeView === view;
            return (
              <button
                key={view}
                type="button"
                className={`${styles.navButton}${active ? ` ${styles.navButtonActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed ? nav.label : undefined}
                title={collapsed ? nav.label : undefined}
                onClick={() => onSelectView(view)}
              >
                <HugeiconsIcon icon={nav.icon} size={18} strokeWidth={1.7} />
                <span className={styles.navLabel}>{nav.label}</span>
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
        {collapsed ? (
          <div className={styles.railSpacer} />
        ) : (
          <ChatListPanel onOpenConversation={openConversation} onOpenConversationDeleted={goHome} highlightActive={activeView === 'chat'} />
        )}
        <SidebarBalance credits={snap.headlineBalanceUsdc} onAddFunds={() => onSelectView('deposit')} compact={collapsed} />
        <button
          type="button"
          className={styles.navButton}
          onClick={openDashboard}
          aria-label={collapsed ? 'Dashboard' : undefined}
          title="Open your gateway dashboard in the browser"
        >
          <HugeiconsIcon icon={DashboardSquare01Icon} size={18} strokeWidth={1.7} />
          <span className={styles.navLabel}>Dashboard</span>
          <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={1.8} className={styles.navExternal} />
        </button>
        {bottomNavEntries.map(({ view, nav }) => (
          <button
            key={view}
            type="button"
            className={`${styles.navButton}${activeView === view ? ` ${styles.navButtonActive}` : ''}`}
            aria-current={activeView === view ? 'page' : undefined}
            aria-label={collapsed ? nav.label : undefined}
            title={collapsed ? nav.label : undefined}
            onClick={() => onSelectView(view)}
          >
            <HugeiconsIcon icon={nav.icon} size={18} strokeWidth={1.7} />
            <span className={styles.navLabel}>{nav.label}</span>
          </button>
        ))}
        <p className={styles.status} title={collapsed ? `${gatewayStatusText(gatewayStatus)} · v${appVersion}` : undefined}>
          <span className={gatewayStatus && !gatewayStatus.reachable && !gatewayStatus.starting ? `${styles.statusItem} ${styles.statusWarn}` : styles.statusItem}>
            {gatewayStatusText(gatewayStatus)}
          </span>
          <span className={styles.statusVersion}>v{appVersion}</span>
        </p>
      </nav>
      <main className={styles.mainPane}>
        <div className={styles.content}>
          <VprNavContext.Provider value={navValue}>{children}</VprNavContext.Provider>
          <PrivacySwitchDialog />
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
