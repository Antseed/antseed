import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewHost } from './components/ViewHost';
import { SetupScreen } from './components/SetupScreen';
import { preloadViews, viewsForPreload } from './components/viewRegistry';
import { shallowEqual, useUiSelector } from './hooks/useUiSelector';
import type { ViewName } from './types';
import { VprShell } from './components/VprShell';
import { recordUserAction, telemetrySurfaceForView } from '../modules/telemetry/actions';
import { useCachedResource } from '../modules/app/cached-resource';
import { gatewayResource } from '../modules/app/vpr-resources';

type IdleCallbackHandle = ReturnType<typeof setTimeout> | number;

/** Hard ceiling on the setup screen: two minutes from first showing, then the
    user gets in no matter how far discovery came. Only the plugin install may
    hold longer — the app is unusable without the router plugin. */
const SETUP_MAX_VISIBLE_MS = 120_000;
/** The launch loader waits this long at most for the gateway (its own start gives up after 90 s). */
const GATEWAY_START_MAX_MS = 100_000;
const GATEWAY_START_POLL_MS = 1_000;

/**
 * True once the gateway has answered at least once this launch, its start has
 * failed (then the app shows why), or the wait ran out. Until then the app
 * shows the launch loader instead of a "gateway unreachable" home.
 */
function useGatewayLaunchSettled(): boolean {
  const status = useCachedResource(gatewayResource).data?.status;
  const [settled, setSettled] = useState(false);
  const mountedAtRef = useRef(Date.now());
  const done = settled || (status !== undefined && (status.reachable || !status.starting));
  useEffect(() => {
    if (done) {
      setSettled(true);
      return undefined;
    }
    // The resource polls every few seconds; while starting, look every second.
    const poll = setInterval(() => { void gatewayResource.refresh(); }, GATEWAY_START_POLL_MS);
    const cap = setTimeout(() => setSettled(true), Math.max(0, GATEWAY_START_MAX_MS - (Date.now() - mountedAtRef.current)));
    return () => {
      clearInterval(poll);
      clearTimeout(cap);
    };
  }, [done]);
  return done;
}

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
    chatServiceCount: state.chatModels.length,
    // A model to chat with — what first-run setup is waiting for.
    freeDefaultReady: state.chatSelectedModelId !== null,
  }), shallowEqual);
  const gatewaySettled = useGatewayLaunchSettled();
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
  const showLaunchLoader = !showSetup && !gatewaySettled;

  useEffect(() => {
    if (showSetup || showLaunchLoader) return undefined;

    void preloadViews(viewsForPreload('eager'));

    return scheduleRoutePreload(() => {
      void preloadViews(viewsForPreload('idle'));
    });
  }, [showSetup, showLaunchLoader]);

  if (showSetup) {
    return <SetupScreen />;
  }
  if (showLaunchLoader) {
    return <SetupScreen startingGateway />;
  }

  return (
    <VprShell activeView={activeView} onSelectView={handleSelectView} onNavigateBack={handleNavigateBack}>
      <ViewHost activeView={activeView} onSelectView={handleSelectView} />
    </VprShell>
  );
}
