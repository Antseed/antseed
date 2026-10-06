import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewHost } from './components/ViewHost';
import { SetupScreen } from './components/SetupScreen';
import { preloadViews, viewsForPreload } from './components/viewRegistry';
import { shallowEqual, useUiSelector } from './hooks/useUiSelector';
import { VIEW_NAMES, type ViewName } from './types';
import { VprShell } from './components/VprShell';
import { recordUserAction, telemetrySurfaceForView } from '../modules/telemetry/actions';

type IdleCallbackHandle = ReturnType<typeof setTimeout> | number;

/** Hard ceiling on the setup screen: two minutes from first showing, then the
    user gets in no matter how far discovery came. Only the plugin install may
    hold longer — the app is unusable without the router plugin. */
const SETUP_MAX_VISIBLE_MS = 120_000;

function scheduleRoutePreload(callback: () => void): () => void {
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (win.requestIdleCallback) {
    const handle = win.requestIdleCallback(callback, { timeout: 1_500 });
    return () => win.cancelIdleCallback?.(handle);
  }

  const handle: IdleCallbackHandle = window.setTimeout(callback, 250);
  return () => window.clearTimeout(handle);
}

export function AppShell() {
  const snap = useUiSelector((state) => ({
    appSetupStatusKnown: state.appSetupStatusKnown,
    appSetupNeeded: state.appSetupNeeded,
    appSetupComplete: state.appSetupComplete,
    chatServiceCount: state.chatServiceOptions.length,
    chatPanelExpanded: state.chatPanelExpanded,
    // A default model backed by a trusted free route — what first-run setup
    // is actually for. The provisional flag clears exactly when routing
    // confirms a free-backed default (or the user picks a model).
    freeDefaultReady: state.vprRouteSelection.model !== null && !state.vprDefaultModelProvisional,
  }), shallowEqual);
  const [activeView, setActiveView] = useState<ViewName>('home');
  const [setupVisible, setSetupVisible] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  /** When the setup screen first showed — anchors the two-minute ceiling. */
  const setupShownAtRef = useRef<number | null>(null);

  // Screens visited before the current one, most recent last. Header back
  // buttons pop this so "back" returns to where the user actually came from;
  // the per-view fallback target only applies when the stack is empty.
  const viewHistoryRef = useRef<ViewName[]>([]);
  const activeViewRef = useRef<ViewName>(activeView);

  const handleSelectView = useCallback((view: ViewName) => {
    const current = activeViewRef.current;
    if (view === current) return;
    recordUserAction('view_opened', telemetrySurfaceForView(view));
    const stack = viewHistoryRef.current;
    stack.push(current);
    if (stack.length > 32) stack.shift();
    activeViewRef.current = view;
    setActiveView(view);
  }, []);

  const handleNavigateBack = useCallback((fallback: ViewName) => {
    const current = activeViewRef.current;
    const stack = viewHistoryRef.current;
    let target = stack.pop();
    while (target === current) target = stack.pop();
    const next = target ?? fallback;
    if (next === current) return;
    recordUserAction('view_opened', telemetrySurfaceForView(next));
    activeViewRef.current = next;
    setActiveView(next);
  }, []);

  const hasServices = snap.chatServiceCount > 0;

  // Show setup during first-run plugin/runtime bootstrapping, but never re-open it
  // just because the service catalog is temporarily empty. Service discovery is
  // refreshed periodically and can briefly return zero rows (peer/DHT/RPC timing,
  // signature/payment probe failures, etc.); treating that as setup-required
  // yanks active desktop users back to SetupScreen.
  //
  // Gate on appSetupStatusKnown so we don't briefly flash the normal app shell
  // before the IPC round-trip resolves and reveals that setup is actually needed.
  useEffect(() => {
    if (!snap.appSetupStatusKnown) return;
    if (!snap.appSetupNeeded) {
      setSetupVisible(false);
      setSetupDismissed(true);
      return;
    }
    if (setupDismissed) {
      setSetupVisible(false);
      return;
    }

    // The setup screen is a first-run bootstrap aid, not a hard gate. If the
    // buyer runtime later starts successfully and services load, let the user
    // into the app even if plugin setup reported a transient repair/install
    // failure. This prevents a stale "Failed to install router plugin" status
    // from covering a now-usable desktop session.
    //
    // Setup's real goal is a model the user can chat with for free, so the
    // screen holds until routing confirms a free-backed default — but never
    // past SETUP_MAX_VISIBLE_MS from when it appeared: a network with no
    // trusted free seller (or none at all) must not lock the user out. The
    // Home "Finding free peers…" hint carries the search on from there. Only
    // an unfinished plugin install may exceed the cap.
    if (hasServices && snap.freeDefaultReady) {
      const timer = setTimeout(() => {
        setSetupVisible(false);
        setSetupDismissed(true);
      }, 900);
      return () => clearTimeout(timer);
    }

    setSetupVisible(true);
    const shownAt = setupShownAtRef.current ?? Date.now();
    setupShownAtRef.current = shownAt;
    if (snap.appSetupComplete) {
      const timer = setTimeout(() => {
        setSetupVisible(false);
        setSetupDismissed(true);
      }, Math.max(0, SETUP_MAX_VISIBLE_MS - (Date.now() - shownAt)));
      return () => clearTimeout(timer);
    }
  }, [snap.appSetupStatusKnown, snap.appSetupNeeded, snap.appSetupComplete, snap.freeDefaultReady, hasServices, setupDismissed]);

  const showSetup = setupVisible;

  useEffect(() => {
    return window.antseedDesktop?.onNavigateView?.((viewName) => {
      if (!(VIEW_NAMES as readonly string[]).includes(viewName)) return;
      handleSelectView(viewName as ViewName);
    });
  }, [handleSelectView]);

  useEffect(() => {
    if (showSetup) return undefined;

    void preloadViews(viewsForPreload('eager'));

    return scheduleRoutePreload(() => {
      void preloadViews(viewsForPreload('idle'));
    });
  }, [showSetup]);

  useEffect(() => {
    if (showSetup) return;
    // Chat supports both window sizes: wide (standard preset, conversation
    // list showing) by default, thin when the user collapses the panel.
    if (activeView === 'chat' && snap.chatPanelExpanded) {
      void window.antseedDesktop?.applyWindowPreset?.('standard');
      return;
    }
    void window.antseedDesktop?.applyWindowView?.(activeView);
  }, [activeView, showSetup, snap.chatPanelExpanded]);

  if (showSetup) {
    return <SetupScreen />;
  }

  return (
    <VprShell activeView={activeView} onSelectView={handleSelectView} onNavigateBack={handleNavigateBack}>
      <ViewHost activeView={activeView} onSelectView={handleSelectView} />
    </VprShell>
  );
}
