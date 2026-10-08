import type { RendererUiState } from '../../core/state';
import { isBuyerReady } from './connect-badge';
import { selectHeadlineBalanceUsdc } from '../../core/balance';
import { formatCompactTokens, formatCredits, shortAddress } from '../../core/format';
import { notifyUiStateChanged } from '../../core/store';
import type {
  BuyerConversationSummary,
  DesktopBridge,
  SystemProxyProfileSummary,
  VprFloatConversation,
  VprFloatData,
  VprFloatModel,
} from '../../types/bridge';
import {
  conversationCost,
  conversationMatchesApp,
  conversationPinnedServiceId,
  conversationRoutedPeerName,
  conversationTitle,
  isConversationActive,
  shortSessionId,
} from '../routing/conversations';
import { loadFavoriteModels } from '../catalog/favorites';
import { sameCanonicalModel } from '../catalog/model-identity';
import { loadFloatAutoOpen } from './float-settings';
import {
  catalogEntryKey,
  isFreeCatalogEntry,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../catalog/recommended';
import { pinnedSellerLabels, resolvePeerForModel } from '../catalog/view-models';
import { activeProfilesFromRuntimeState } from '../routing/tools';

const FLOAT_UPDATE_INTERVAL_MS = 3_000;
/** Chat rows the pill's dropdown shows (buyer stores more). */
const FLOAT_CONVERSATION_LIMIT = 8;
/** How long after the last traffic log line the pulse stays considered live. */
const TRAFFIC_HOLD_MS = 1_500;
/** How long after the buyer's last-activity timestamp traffic reads as live.
    Longer than the poll interval so a stream that pauses briefly between
    frames (or finishes mid-interval) doesn't flicker the pill dark. */
const BUYER_ACTIVITY_HOLD_MS = 4_000;
/** Coalesce burst of completion lines into one forced usage refresh. */
const COMPLETION_REFRESH_DEBOUNCE_MS = 400;
/** After the user closes the pill, auto-open stays quiet this long so the
    same burst of traffic doesn't immediately pop it back up. */
const AUTO_OPEN_CLOSE_COOLDOWN_MS = 30_000;

export type VprFloatModule = {
  /** Open the pill (always with the chat dropdown expanded). */
  openFloat: (profileName?: string) => Promise<void>;
  closeFloat: () => Promise<void>;
  /** Immediate data push for main-window changes the pill mirrors (route
      selection); no-op while the pill is closed. */
  refresh: () => Promise<void>;
  /** Persist the auto-open-on-traffic preference and re-arm (or stand down)
      the closed-pill traffic watcher accordingly. */
  setAutoOpen: (enabled: boolean) => void;
};

/**
 * Main-window side of the detachable pill window: builds the display payload
 * (connected apps, model catalog, buyer usage) and keeps the pill fed while
 * it's open. Model changes made in the pill come back as 'select-model'
 * actions.
 */
export function initVprFloatModule({
  bridge,
  uiState,
  onSelectModel,
  refreshUsage,
  onClosed,
}: {
  bridge: DesktopBridge | undefined;
  uiState: RendererUiState;
  onSelectModel: (provider: string, serviceId: string) => void;
  /** Refresh the payments summary; force bypasses its self-throttle. */
  refreshUsage: (force?: boolean) => Promise<void>;
  onClosed?: () => void;
}): VprFloatModule {
  let timer: number | null = null;
  let profiles: SystemProxyProfileSummary[] = [];
  let selectedApp = '';
  let lastBuyerRequestTotal: number | null = null;

  // --- Auto-open on traffic (opt-in) -------------------------------------
  // While the pill is closed and the preference is on, the same two traffic
  // signals that drive the pulse (log lines + buyer lastActivityAt) also
  // pop the pill open. A cooldown after a manual close keeps the pill from
  // bouncing back for the burst of traffic the user just dismissed it over.
  let autoOpenEnabled = loadFloatAutoOpen();
  let autoOpenSuppressedUntil = 0;
  let autoOpenInFlight = false;
  let autoOpenWatchTimer: number | null = null;

  async function ensureProfiles(): Promise<void> {
    if (profiles.length > 0) return;
    try {
      profiles = (await bridge?.systemProxyListProfiles?.()) ?? [];
    } catch {
      profiles = [];
    }
  }

  /** The same curated list as the Home model dropdown: starred favorites
      first, then the recommended lineup (frontier + free models), with the
      current selection always present so the active model never disappears
      from its own switcher. */
  function floatModels(): { models: VprFloatModel[]; favoriteKeys: string[] } {
    const selection = uiState.vprRouteSelection.model;
    const favorites = loadFavoriteModels();
    const favoriteEntries = selectFavoriteVprCatalog(uiState.vprModelCatalog, favorites);
    const recommended = selectRecommendedVprCatalog(uiState.vprModelCatalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    const models = [...favoriteEntries, ...recommended];
    if (
      selection &&
      !models.some((entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId)
    ) {
      const selected = uiState.vprModelCatalog.find(
        (entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId,
      );
      if (selected) models.unshift(selected);
    }
    return { models, favoriteKeys: [...favorites] };
  }

  /** Usage line: buyer-wide total tokens ("1.2M tok"). */
  function usageLabel(): string {
    const usage = uiState.creditsBuyerUsage;
    return `${formatCompactTokens(usage?.totalInputTokens, usage?.totalOutputTokens)} tok`;
  }

  /** Complete owned balance, including USDC awaiting deposit sweep. */
  function balanceLabel(): string {
    return `$${formatCredits(selectHeadlineBalanceUsdc(uiState))}`;
  }

  /** The buyer identity (signer address), shortened. */
  function identityLabel(): string | null {
    return uiState.creditsEvmAddress ? shortAddress(uiState.creditsEvmAddress) : null;
  }

  /** True when the balance is effectively empty but the selected default
      model is paid — the pill then offers an "Add balance" shortcut. */
  function needsFunds(): boolean {
    // Money locked in a live channel still buys requests, so the nudge keys
    // off spendable — not the unreserved slice, which a reserve drains to ~0.
    const balance = Number(uiState.creditsSpendableUsdc);
    if (!(balance < 0.01)) return false;
    const selection = uiState.vprRouteSelection.model;
    if (!selection) return false;
    const entry = uiState.vprModelCatalog.find(
      (item) => item.provider === selection.provider && item.serviceId === selection.serviceId,
    );
    return entry ? !isFreeCatalogEntry(entry) : false;
  }

  /** Log markers for a model request actually being transferred.
      `[ProxyMux] send/recv` frame lines are the ground truth — they fire per
      DataChannel frame including streaming chunks — but are only emitted
      with debug logging on, so the buyer dispatch/response markers and the
      system proxy's `| source:` forwards back them up. Deliberately narrow:
      control-plane polls (`GET /_antseed/...`, `GET /v1/models`) and CONNECT
      tunnels (any app HTTPS traffic — telemetry, update checks) must not
      pulse. */
  const TRAFFIC_LINE_PATTERN = /\[ProxyMux\] (?:send|recv) |POST \/v1\/|Routing to peer |Response: \d{3} \(|\| source:/;

  /** Markers for a response finishing — trigger an immediate usage refresh. */
  const COMPLETION_LINE_PATTERN = /Response: \d{3} \(|\[ProxyMux\] recv response|from buyer proxy/;

  // Event-driven traffic signal (same pattern as the chat walking ant):
  // every log line is inspected as it arrives via bridge.onLog, so the pulse
  // lights the moment traffic moves instead of waiting for a poll tick.
  let lastTrafficLineAt = 0;
  let completionRefreshTimer: number | null = null;

  function logTrafficActive(): boolean {
    return Date.now() - lastTrafficLineAt < TRAFFIC_HOLD_MS;
  }

  function scheduleCompletionRefresh(): void {
    if (completionRefreshTimer !== null) return;
    completionRefreshTimer = window.setTimeout(() => {
      completionRefreshTimer = null;
      void refreshUsage(true)
        .then(() => buildData())
        .then((data) => bridge?.vprFloatUpdate?.(data));
    }, COMPLETION_REFRESH_DEBOUNCE_MS);
  }

  bridge?.onLog?.((event) => {
    if (event.mode !== 'connect' && event.mode !== 'system-proxy') return;
    const line = event.line.replace(/\x1b\[[0-9;]*m/g, '');
    if (line.includes('cors preflight') || !TRAFFIC_LINE_PATTERN.test(line)) return;

    if (!uiState.vprFloatOpen) {
      // Closed pill: the only thing a traffic line can do is auto-open it.
      lastTrafficLineAt = Date.now();
      maybeAutoOpen();
      return;
    }

    const wasActive = logTrafficActive();
    lastTrafficLineAt = Date.now();
    if (!wasActive) {
      // Idle -> active transition: light the pulse right away.
      void buildData().then((data) => bridge?.vprFloatUpdate?.(data));
    }
    if (COMPLETION_LINE_PATTERN.test(line)) {
      scheduleCompletionRefresh();
    }
  });

  /**
   * Live traffic through the buyer proxy (chat and direct API clients as
   * well as system-proxy forwards). Primary signal is the buyer's
   * `lastActivityAt` timestamp — stamped per dispatch and per streamed frame,
   * independent of debug logging — so config-patch tools (Codex, OpenCode,
   * pi) that talk straight to the buyer light up even with logs off, and
   * stay lit mid-stream. Falls back to the request-total delta for older
   * buyers that don't report the timestamp.
   */
  async function buyerProxyTraffic(): Promise<{ active: boolean; completed: boolean }> {
    try {
      const result = await bridge?.paymentsGetBuyerUsage?.();
      if (!result?.ok) return { active: false, completed: false };

      // A metered request finished since the last tick — drives the forced
      // usage refresh (kept infrequent: only on completion, not per frame).
      const total = result.data?.totalRequests ?? null;
      let completed = false;
      if (total !== null) {
        const previous = lastBuyerRequestTotal;
        lastBuyerRequestTotal = total;
        completed = previous !== null && total > previous;
      }

      // Green signal: recent per-frame activity when the buyer reports it,
      // otherwise fall back to the completion delta for older buyers.
      const lastActivityAt = result.lastActivityAt ?? null;
      const active = lastActivityAt !== null
        ? Date.now() - lastActivityAt < BUYER_ACTIVITY_HOLD_MS
        : completed;

      return { active, completed };
    } catch {
      return { active: false, completed: false };
    }
  }

  // Set while recent buyer activity keeps the pulse alive between the
  // event-driven log signal's holds (detached daemons without log streaming).
  let buyerDeltaActive = false;

  function floatConversation(record: BuyerConversationSummary): VprFloatConversation {
    return {
      id: record.id,
      tool: record.tool,
      title: conversationTitle(record),
      sessionShort: shortSessionId(record.sessionKey),
      pinnedServiceId: conversationPinnedServiceId(record),
      lastActiveAt: record.lastActiveAt,
      active: isConversationActive(record.lastActiveAt),
      cost: conversationCost(record),
      routedPeerName: conversationRoutedPeerName(record, uiState.discoverRows),
    };
  }

  async function loadConversations(): Promise<VprFloatConversation[]> {
    try {
      const records = (await bridge?.buyerConversationsList?.()) ?? [];
      return records.slice(0, FLOAT_CONVERSATION_LIMIT).map(floatConversation);
    } catch {
      return [];
    }
  }

  /** Peer for a chat pinned to this model: the model's own seller pin when
      one exists, else the best auto route — same as the global selection. */
  function resolvePinRoute(provider: string, serviceId: string): string | null {
    const peerId = resolvePeerForModel(
      uiState.vprRoutableRows,
      uiState.vprModelPins,
      uiState.vprRoutingPreferences,
      { provider, serviceId },
    );
    return peerId ? `${peerId}@${serviceId}` : null;
  }

  async function buildData(): Promise<VprFloatData> {
    await ensureProfiles();
    let connected: SystemProxyProfileSummary[] = [];
    try {
      const state = (await bridge?.systemProxyGetState?.()) ?? null;
      const active = activeProfilesFromRuntimeState(state);
      connected = profiles.filter((profile) => active?.has(profile.name) ?? false);
    } catch {
      connected = [];
    }
    if (!connected.some((profile) => profile.name === selectedApp)) {
      selectedApp = connected[0]?.name ?? '';
    }
    const selection = uiState.vprRouteSelection.model;
    const { models, favoriteKeys } = floatModels();
    const identity = identityLabel();
    // Named sellers for pinned models — the pill says where requests go, not
    // just which model, same as the main window.
    const pinnedSellers = Object.fromEntries(
      pinnedSellerLabels(uiState.vprRoutableRows, uiState.vprModelPins, models),
    );
    const runtimeOn = isBuyerReady(uiState.processes, uiState.chatProxyOnline);

    return {
      apps: connected.map((profile) => ({
        name: profile.name,
        displayName: profile.displayName,
        ...(profile.toolSlugs ? { toolSlugs: profile.toolSlugs } : {}),
        // Carry the app's real icon so the pill matches the main window's
        // app rows instead of always drawing the generic brand mark.
        ...(profile.iconDataUri ? { iconDataUri: profile.iconDataUri } : {}),
      })),
      selectedApp,
      models,
      favoriteKeys,
      selectedModel: selection ? { provider: selection.provider, serviceId: selection.serviceId } : null,
      ...(Object.keys(pinnedSellers).length > 0 ? { pinnedSellers } : {}),
      // No chats while routing is stopped — a dead runtime serving a live
      // chat list reads as connected when it isn't.
      conversations: runtimeOn ? await loadConversations() : [],
      usageLabel: usageLabel(),
      balanceLabel: balanceLabel(),
      needsFunds: needsFunds(),
      runtimeOn,
      ...(identity ? { identityLabel: identity } : {}),
      ...(uiState.vprFloatShowRoutedPeer ? { showRoutedPeer: true } : {}),
      trafficActive: logTrafficActive() || buyerDeltaActive,
    };
  }

  async function tick(): Promise<void> {
    const { active, completed } = await buyerProxyTraffic();
    buyerDeltaActive = active;
    bridge?.vprFloatUpdate?.(await buildData());

    if (completed) {
      // A response was metered since the last tick — pull fresh channel
      // totals now instead of waiting out the summary throttle, then push
      // the updated token/cost numbers straight to the pill.
      await refreshUsage(true);
      bridge?.vprFloatUpdate?.(await buildData());
    } else {
      // Ambient keep-warm; the credits module's self-throttle absorbs it.
      void refreshUsage(false);
    }
  }

  function stopUpdater(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function startUpdater(): void {
    if (timer !== null) return;
    timer = window.setInterval(() => { void tick(); }, FLOAT_UPDATE_INTERVAL_MS);
  }

  /** Pop the pill for incoming traffic — gated on the preference, the
      post-close cooldown, and a single in-flight open. */
  function maybeAutoOpen(): void {
    if (!autoOpenEnabled || uiState.vprFloatOpen || autoOpenInFlight) return;
    if (Date.now() < autoOpenSuppressedUntil) return;
    autoOpenInFlight = true;
    void openFloatInternal()
      .catch(() => { /* buyer/bridge hiccup — the next signal retries */ })
      .finally(() => { autoOpenInFlight = false; });
  }

  /** Closed-pill watcher for buyers whose traffic never reaches the log
      stream (config-patch tools talking straight to the buyer, logs off):
      poll the buyer's lastActivityAt at the same cadence as the open-pill
      tick and auto-open on activity. Runs only while the pill is closed
      and the preference is on. */
  function syncAutoOpenWatcher(): void {
    const shouldWatch = autoOpenEnabled && !uiState.vprFloatOpen;
    if (shouldWatch && autoOpenWatchTimer === null) {
      autoOpenWatchTimer = window.setInterval(() => {
        void buyerProxyTraffic().then(({ active }) => {
          if (active) maybeAutoOpen();
        });
      }, FLOAT_UPDATE_INTERVAL_MS);
    } else if (!shouldWatch && autoOpenWatchTimer !== null) {
      window.clearInterval(autoOpenWatchTimer);
      autoOpenWatchTimer = null;
    }
  }

  bridge?.onVprFloatClosed?.(() => {
    stopUpdater();
    if (uiState.vprFloatOpen) {
      uiState.vprFloatOpen = false;
      notifyUiStateChanged();
    }
    // The traffic that prompted this close is likely still flowing — hold
    // auto-open back so dismissing the pill actually dismisses it.
    autoOpenSuppressedUntil = Date.now() + AUTO_OPEN_CLOSE_COOLDOWN_MS;
    syncAutoOpenWatcher();
    onClosed?.();
  });

  bridge?.onVprFloatAction?.((action) => {
    if (typeof action !== 'object' || action === null) return;
    const type = (action as { type?: unknown }).type;
    if (type === 'select-model') {
      const { provider, serviceId } = action as { provider?: unknown; serviceId?: unknown };
      if (typeof provider === 'string' && typeof serviceId === 'string') {
        onSelectModel(provider, serviceId);
        // Push the new selection immediately instead of waiting for the tick.
        void buildData().then((data) => bridge?.vprFloatUpdate?.(data));
      }
      return;
    }
    // Pin one chat to a model: resolve the peer for that model the same way
    // the global selection does, then hand the pin to the buyer.
    if (type === 'pin-chat-model') {
      const { conversationId, provider, serviceId } = action as { conversationId?: unknown; provider?: unknown; serviceId?: unknown };
      if (typeof conversationId !== 'string' || typeof provider !== 'string' || typeof serviceId !== 'string') return;
      void (async () => {
        // Re-picking the chat's current model is a no-op — re-pinning would
        // re-resolve the peer, wiping a per-chat seller pin back to auto.
        const records = (await bridge?.buyerConversationsList?.()) ?? [];
        const record = records.find((row) => row.id === conversationId);
        const current = record ? conversationPinnedServiceId(record) : null;
        if (current && sameCanonicalModel(current, serviceId)) return;
        if (!resolvePinRoute(provider, serviceId)) return;
        await bridge?.buyerConversationsUpdate?.({ id: conversationId, pinnedModel: serviceId, peerSource: 'auto' });
        bridge?.vprFloatUpdate?.(await buildData());
      })();
      return;
    }
    // Open the app a chat belongs to (chat header shortcut): the tool's
    // desktop app when one is known, else the connected profile's open
    // action — same chain as the Chats view's open buttons.
    if (type === 'open-chat-app') {
      const { conversationId } = action as { conversationId?: unknown };
      if (typeof conversationId !== 'string') return;
      void (async () => {
        const records = (await bridge?.buyerConversationsList?.()) ?? [];
        const record = records.find((row) => row.id === conversationId);
        if (!record) return;
        const opened = await bridge?.openToolSession?.(record.tool, record.sessionKey, 'app');
        if (opened?.ok) return;
        await ensureProfiles();
        const profile = profiles.find((item) => conversationMatchesApp(record.tool, item));
        if (profile) await bridge?.openTool?.(profile.toolName ?? profile.name);
      })();
    }
  });

  async function openFloatInternal(profileName?: string): Promise<boolean> {
    if (!bridge?.vprFloatOpen) return false;
    if (profileName) selectedApp = profileName;
    // Fresh numbers on open — don't show a minute-old summary.
    await refreshUsage(true);
    const data = await buildData();
    // Every open lands with the chat dropdown already expanded — the list is
    // the pill's payload, so surfacing the window means surfacing the chats
    // (pop-out button, connect, and traffic auto-open alike). Only the open
    // payload carries the flag; periodic updates must not re-expand a menu
    // the user collapsed.
    const result = await bridge.vprFloatOpen({ ...data, openMenu: true });
    if (!result.ok) return false;
    uiState.vprFloatOpen = true;
    notifyUiStateChanged();
    startUpdater();
    syncAutoOpenWatcher();
    return true;
  }

  // Survive a main-window reload while the pill is open (dev HMR, cmd+R).
  void bridge?.vprFloatIsOpen?.().then((open) => {
    if (open) {
      uiState.vprFloatOpen = true;
      notifyUiStateChanged();
      startUpdater();
    }
    syncAutoOpenWatcher();
  });

  return {
    async openFloat(profileName?: string) {
      // A deliberate open clears the post-close cooldown — the user wants
      // the pill back.
      autoOpenSuppressedUntil = 0;
      await openFloatInternal(profileName);
    },
    async closeFloat() {
      await bridge?.vprFloatClose?.();
    },
    /** Push fresh data to the pill right away — for main-window changes the
        pill should mirror instantly (route selection) instead of waiting
        out the poll tick. No-op while the pill is closed. */
    async refresh() {
      if (!uiState.vprFloatOpen) return;
      bridge?.vprFloatUpdate?.(await buildData());
    },
    setAutoOpen(enabled: boolean) {
      autoOpenEnabled = enabled;
      if (enabled) autoOpenSuppressedUntil = 0;
      syncAutoOpenWatcher();
    },
  };
}
