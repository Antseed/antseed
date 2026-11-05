import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ViewName } from '../types';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { selectHeadlineBalanceUsdc } from '../../core/balance';
import { shouldNotifyAppsOnboarding } from '../../modules/app/apps-onboarding';
import { gatewayResource } from '../../modules/app/vpr-resources';
import { useCachedResource } from '../../modules/app/cached-resource';
import { navViews } from './viewRegistry';
import { ChatListPanel } from './ChatListPanel';
import { DepositProgressBanner } from './DepositProgressBanner';
import { NetworkAlertBanner } from './NetworkAlertBanner';
import { UpdateBanner } from './UpdateBanner';
import { VprNavContext } from './vpr/VprNavContext';
import { VprHeaderActions } from './vpr/VprHeaderActions';
import styles from './VprShell.module.scss';

/* Views built on VprPage carry the credits pill inside their pinned header,
   so the shell's floating pill would duplicate it. */
const VIEWS_WITH_HEADER_CREDITS: ReadonlySet<ViewName> = new Set<ViewName>([
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
  const snap = useUiSelector((state) => ({
    headlineBalanceUsdc: selectHeadlineBalanceUsdc(state),
    chatNeedsAttention: state.chatSendingConversationIds.length > 0,
    chatPanelExpanded: state.chatPanelExpanded,
  }), shallowEqual);
  const gateway = useCachedResource(gatewayResource);
  const gatewayStatus = gateway.data?.status;

  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  // Chat opens thin — the conversation-list panel (and the wide window
  // preset, see AppShell) only appear once the user expands the chat view.
  const chatPanelVisible = activeView === 'chat' && snap.chatPanelExpanded;

  const navValue = useMemo(
    () => ({ navigate: onSelectView, back: onNavigateBack }),
    [onSelectView, onNavigateBack],
  );

  return (
      <div className={`${styles.shell}${chatPanelVisible ? ` ${styles.shellWithPanel}` : ''}`}>
      {/* Window-drag handle: the hidden-inset title bar has no native drag
          region, so this strip provides one. pointer-events: none keeps web
          clicks working; interactive elements overlapping it opt out with
          -webkit-app-region: no-drag. */}
      <div className={styles.dragStrip} aria-hidden="true" />
      <nav className={styles.sidebar} aria-label="Main navigation">
        <div className={styles.navGroup}>
          {mainNavEntries.map(({ view, nav }) => {
            const active = activeView === view;
            return (
              <button
                key={view}
                type="button"
                className={`${styles.navButton}${active ? ` ${styles.navButtonActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(view)}
              >
                <HugeiconsIcon icon={nav.icon} size={24} strokeWidth={1.8} />
                <span className={styles.navLabel}>{nav.label}</span>
                {view === 'chat' && snap.chatNeedsAttention && activeView !== 'chat' && (
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
        <div className={styles.navBottom}>
          {bottomNavEntries.map(({ view, nav }) => (
            <button
              key={view}
              type="button"
              className={`${styles.navButton}${activeView === view ? ` ${styles.navButtonActive}` : ''}`}
              aria-current={activeView === view ? 'page' : undefined}
              onClick={() => onSelectView(view)}
            >
              <HugeiconsIcon icon={nav.icon} size={24} strokeWidth={1.8} />
              <span className={styles.navLabel}>{nav.label}</span>
            </button>
          ))}
        </div>
      </nav>
      {chatPanelVisible && <ChatListPanel onSelectView={onSelectView} />}
      <main className={styles.mainPane}>
        <div className={styles.content}>
          <VprNavContext.Provider value={navValue}>{children}</VprNavContext.Provider>
        </div>
        {/* The no-drag carve-out lives on this static wrapper: the pill
            itself runs a compositor scroll-timeline animation, and animated
            elements don't reliably register app-region rects. The slot must
            also come AFTER the view content in the DOM — app-region rects
            are collected in document order and later drag regions (e.g. the
            home view's hero banner) would otherwise paint over the pill's
            no-drag hole and swallow its clicks. */}
        {!VIEWS_WITH_HEADER_CREDITS.has(activeView) && (
          <div className={styles.creditsPillSlot}>
            <VprHeaderActions
              className={styles.creditsPill}
              credits={snap.headlineBalanceUsdc}
              onSelectView={onSelectView}
            />
          </div>
        )}
        <NetworkAlertBanner />
        <UpdateBanner />
        <DepositProgressBanner onAddFunds={() => onSelectView('deposit')} onDepositView={activeView === 'deposit'} />
      </main>
      <footer className={styles.statusStrip}>
        <span className={gatewayStatus && !gatewayStatus.reachable ? `${styles.statusItem} ${styles.statusWarn}` : styles.statusItem}>
          {gatewayStatusText(gatewayStatus)}
        </span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>v{appVersion}</span>
      </footer>
      </div>
  );
}
