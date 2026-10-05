import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  PowerIcon,
  SparklesIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import type { SystemProxyProfileSummary } from '../../../types/bridge';
import { getUiStateRef } from '../../../core/store';
import { activeProfilesFromRuntimeState } from '../../../modules/routing/tools';
import { pinnedSellerLabel, pinnedSellerLabels } from '../../../modules/catalog/view-models';
import { findCatalogEntry, sortFreeModelsByPriority } from '../../../modules/catalog/model-catalog';
import { computeMeasuredSavings, formatSavedUsd } from '../../../modules/catalog/measured-savings';
import { ensureOpenRouterPrices, getCachedOpenRouterPrices } from '../../../modules/catalog/openrouter-baseline';
import { displayModelLabel } from '../../../modules/catalog/model-identity';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/catalog/recommended';
import { connectVprProfile } from '../../../modules/routing/proxy-sync';
import { buyerConversationsResource, systemProxyResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useEverFunded } from '../../hooks/useEverFunded';
import type { ViewName } from '../../types';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { BottomNotice } from '../BottomNotice';
import { BrandIcon, isThemeAwareAppBrand, resolveBrandKey } from '../brand/BrandIcon';
import { VprModelRowList } from '../vpr/VprModelRows';
import { hasSeenChats, rememberSeenChats, VprRecentChatsCard } from '../vpr/VprRecentChats';
import { conversationRoutedPeerName } from '../../../modules/routing/conversations';
import { formatCompactTokens, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { DisconnectConfirmDialog } from './DisconnectConfirmDialog';
import { isBuyerReady } from '../../../modules/app/connect-badge';
import { isDisconnectConfirmDismissed, persistDisconnectConfirmDismissed } from '../../../modules/app/disconnect-confirm';
import styles from './VprHomeView.module.scss';
import { recordFirstModelShown, recordUserAction } from '../../../modules/telemetry/actions';
import { normalizeTelemetryAppName } from '../../../../shared/telemetry.js';

type Props = { onSelectView?: (view: ViewName) => void };

const ADD_BALANCE_DISMISSED_KEY = 'antseed.desktop.vpr.addBalanceDismissed';
const RESTART_NOTICE_DISMISSED_KEY = 'antseed.desktop.vpr.restartNoticeDismissed';
const MODEL_CHANGE_NOTICE_MS = 4_000;
/* Rows in the model dropdown (Figma) — the full catalog lives on Models. */
const DROPDOWN_MODEL_COUNT = 5;
/* Free rows leading the dropdown before the first deposit ever lands. */
const DROPDOWN_FREE_COUNT = 3;

function isFreeEntry(entry: VprModelCatalogEntry | undefined): boolean {
  if (!entry || entry.kind === 'image') return false;
  const { minInputUsdPerMillion: i, minOutputUsdPerMillion: o } = entry;
  return i !== null && o !== null && i <= 0 && o <= 0;
}

/* Catalog apps shown as pills on Home (plus Telegram, Claude, Cursor). */
const HOME_APP_PILL_LIMIT = 11;

export function VprHomeView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    modelPins: state.vprModelPins,
    discoverRows: state.vprRoutableRows,
    defaultProvisional: state.vprDefaultModelProvisional,
    processes: state.processes,
    proxyOnline: state.chatProxyOnline,
    connectBadge: state.connectBadge,
    usage: state.creditsBuyerUsage,
    floatOpen: state.vprFloatOpen,
    creditsSpendable: state.creditsSpendableUsdc,
    creditsTotalOwned: state.creditsTotalOwnedUsdc,
    creditsChannels: state.creditsChannels,
    reminderOffer: state.reminderOffer,
    networkAlert: state.networkAlert,
    // Unfiltered discover list, for routed-peer name resolution.
    allRows: state.discoverRows,
    showRoutedPeer: state.vprFloatShowRoutedPeer,
  }), shallowEqual);
  const proxyResource = useCachedResource(systemProxyResource);
  const conversationsResource = useCachedResource(buyerConversationsResource);
  const profiles = proxyResource.data?.profiles ?? [];
  const proxyState = proxyResource.data?.state ?? null;
  const conversations = conversationsResource.data;
  const [expectChats] = useState(hasSeenChats);
  const [draft, setDraft] = useState('');
  const [addBalanceDismissed, setAddBalanceDismissed] = useState(() => {
    try {
      return localStorage.getItem(ADD_BALANCE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [restartNoticeDismissed, setRestartNoticeDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(RESTART_NOTICE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Gates the model dropdown lineup — free-only before funding, the regular
  // popular lineup permanently after (even if the balance drains to zero).
  const everFunded = useEverFunded();

  const runtimeOn = snap.processes.some((process) => process.mode === 'connect' && process.running === true);

  const selectedModel = snap.selection.model;
  const selectedEntry = useMemo(
    () => (selectedModel
      ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId) ?? undefined
      : undefined),
    [snap.catalog, selectedModel],
  );
  const modelIsFree = isFreeEntry(selectedEntry);
  // Non-auto routing: the model row names the seller it is pinned to.
  const pinnedSeller = useMemo(
    () => pinnedSellerLabel(snap.discoverRows, snap.selection),
    [snap.discoverRows, snap.selection],
  );
  useEffect(() => {
    if (!selectedEntry) return;
    recordFirstModelShown({
      service: selectedEntry.serviceId,
      peerId: snap.selection.mode === 'pinned-peer' ? snap.selection.peerId : null,
    });
  }, [selectedEntry, snap.selection.mode, snap.selection.peerId]);
  useEffect(() => {
    if (conversations) rememberSeenChats(conversations.length);
  }, [conversations]);

  useEffect(() => {
    void actions.refreshPaymentSummary();
    const timer = window.setInterval(() => { void actions.refreshPaymentSummary(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [actions]);

  const activeProfiles = useMemo(() => activeProfilesFromRuntimeState(proxyState), [proxyState]);
  const connectedProfiles = useMemo(
    () => profiles.filter((profile) => activeProfiles?.has(profile.name) ?? false),
    [activeProfiles, profiles],
  );
  // First-run home preview, mirroring the Apps tab: Telegram (built-in),
  // Claude + Cursor (the two headline desktop integrations), then the top of
  // the catalog. Claude is a proxy profile; Cursor is set up from the Apps
  // page (public endpoint), so its row navigates there.
  const claudeProfile = useMemo(
    () => profiles.find((profile) => profile.name === 'claude-desktop') ?? null,
    [profiles],
  );
  // Pills wrap, so the preview can afford most of the catalog; the tail and
  // custom apps live on the Apps page.
  const homePreviewProfiles = useMemo(
    () => profiles.filter((profile) => profile.name !== 'claude-desktop').slice(0, HOME_APP_PILL_LIMIT),
    [profiles],
  );
  const restartProfiles = useMemo(
    () => connectedProfiles.filter((profile) => profile.needsRestart),
    [connectedProfiles],
  );
  // Measured savings: actual USDC paid vs OpenRouter retail for the same
  // tokens, usage-weighted per model. Falls back to the catalog projection
  // (average best-vs-worst peer spread) until priced usage exists.
  const [referencePrices, setReferencePrices] = useState(getCachedOpenRouterPrices);
  useEffect(() => {
    if (referencePrices) return undefined;
    let cancelled = false;
    void ensureOpenRouterPrices().then((map) => {
      if (cancelled) return;
      if (map) setReferencePrices(map);
    });
    return () => { cancelled = true; };
  }, [referencePrices]);
  const measuredSavings = useMemo(
    () => computeMeasuredSavings(snap.usage?.services, referencePrices),
    [snap.usage?.services, referencePrices],
  );
  const projectedSavingsPct = useMemo(() => {
    const values = snap.catalog
      .map((entry) => entry.expectedSavingsPct)
      .filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }, [snap.catalog]);
  const expectedSavingsPct = measuredSavings?.pct ?? projectedSavingsPct;

  // The usage tiles come from the payments summary; nudge a refresh when the
  // connected variant becomes visible (module-level throttle absorbs bursts).
  const hasConnectedApps = connectedProfiles.length > 0;
  useEffect(() => {
    if (hasConnectedApps) actions.refreshPaymentSummary();
  }, [actions, hasConnectedApps]);

  const [connectingProfile, setConnectingProfile] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChangeNotice, setModelChangeNotice] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelChangeNoticeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (modelChangeNoticeTimer.current !== null) window.clearTimeout(modelChangeNoticeTimer.current);
  }, []);

  function applyModelForNewChats(entry: VprModelCatalogEntry): void {
    const label = entry.label ?? displayModelLabel(entry.serviceId);
    actions.selectVprModel(entry.provider, entry.serviceId);
    setModelChangeNotice(`${label} selected for new chats.\nExisting chats are unchanged.`);
    if (modelChangeNoticeTimer.current !== null) window.clearTimeout(modelChangeNoticeTimer.current);
    modelChangeNoticeTimer.current = window.setTimeout(() => {
      setModelChangeNotice(null);
      modelChangeNoticeTimer.current = null;
    }, MODEL_CHANGE_NOTICE_MS);
  }

  function selectModelForNewChats(provider: string, serviceId: string): void {
    const entry = findCatalogEntry(snap.catalog, provider, serviceId);
    if (!entry) return;
    setModelMenuOpen(false);
    if (entry.kind === 'image') return;
    applyModelForNewChats(entry);
  }

  // Favorites are starred on the model pages (localStorage); re-read on each
  // open so stars toggled elsewhere show up without a remount.
  useEffect(() => {
    if (modelMenuOpen) setFavorites(loadFavoriteModels());
  }, [modelMenuOpen]);

  // Close the model dropdown on any outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    function handleClick(event: MouseEvent): void {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelMenuOpen]);

  // The dropdown lists starred favorites first (marked with a star), then the
  // curated recommended lineup, with the current selection always present. The
  // whole list is capped — favorites included — so the menu can't outgrow the
  // hero; everything past the cap lives behind "All models".
  const dropdownEntries = useMemo(() => {
    const textCatalog = snap.catalog.filter((entry) => entry.kind === 'text');
    const favoriteEntries = selectFavoriteVprCatalog(textCatalog, favorites);
    const recommended = selectRecommendedVprCatalog(textCatalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    // Until the first deposit ever lands, the dropdown leads with the three
    // most available trusted free models — paid rows would just 402 for an
    // unfunded user — and the remaining rows come from the regular popular
    // lineup. The first deposit switches to that lineup alone, for good.
    // (While discovery is still cold there are no eligible free offers yet;
    // the hero shows "Finding free peers…" and the lineup fills the gap.)
    const freeLead = everFunded
      ? []
      : sortFreeModelsByPriority(textCatalog.filter((entry) => entry.hasEligibleFreeSeller))
          .slice(0, DROPDOWN_FREE_COUNT);
    const top: VprModelCatalogEntry[] = [];
    for (const entry of [...favoriteEntries, ...freeLead, ...recommended]) {
      if (top.length >= DROPDOWN_MODEL_COUNT) break;
      if (!top.includes(entry)) top.push(entry);
    }
    // The selected model leads, matching the Models page — hoisted when it is
    // already listed, prepended when it isn't.
    if (selectedEntry?.kind === 'text' && top[0] !== selectedEntry) {
      const rest = top.filter((entry) => entry !== selectedEntry);
      return [selectedEntry, ...rest.slice(0, DROPDOWN_MODEL_COUNT - 1)];
    }
    return top;
  }, [everFunded, favorites, selectedEntry, snap.catalog]);

  // Every listed model that remembers a pin names its seller, not just the
  // selected one — pins survive switching models.
  const dropdownPins = useMemo(
    () => pinnedSellerLabels(snap.discoverRows, snap.modelPins, dropdownEntries),
    [dropdownEntries, snap.discoverRows, snap.modelPins],
  );

  // One-click connect from the app buttons; falls back to the Apps page when
  // the profile can't be connected automatically (e.g. no route yet).
  async function connectApp(profileName: string): Promise<void> {
    if (connectingProfile !== null) return;
    recordUserAction('app_connect', 'home', normalizeTelemetryAppName(profileName));
    setConnectingProfile(profileName);
    try {
      const result = await connectVprProfile(window.antseedDesktop, getUiStateRef(), profileName);
      if (result.ok) {
        if (result.state !== undefined) {
          systemProxyResource.setData({ profiles, state: result.state });
        }
        // Surface the pill right away — it opens with the chat dropdown
        // expanded, so the "start a new session" guidance is in view while
        // the user switches to the tool.
        void actions.openVprFloat?.(profileName);
        return;
      }
      onSelectView?.('tools');
    } finally {
      setConnectingProfile(null);
    }
  }

  function dismissAddBalance(): void {
    setAddBalanceDismissed(true);
    try {
      localStorage.setItem(ADD_BALANCE_DISMISSED_KEY, '1');
    } catch { /* private mode */ }
  }

  function dismissRestartNotice(): void {
    setRestartNoticeDismissed(true);
    try {
      sessionStorage.setItem(RESTART_NOTICE_DISMISSED_KEY, '1');
    } catch { /* private mode */ }
  }

  // Visual-only: with the network unreachable the runtime is still running,
  // but showing the hero lit would promise routing that can't happen.
  const networkDown = snap.networkAlert !== 'none';
  // Lit only once the buyer proxy actually answers — `runtimeOn` is true the
  // moment the process is spawned, which is too early to promise routing.
  const buyerReady = isBuyerReady(snap.processes, snap.proxyOnline);
  const connected = buyerReady && !networkDown;
  const powerLit = buyerReady && !networkDown;
  // Power button off: confirm first unless the user opted out of the prompt.
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const onPowerClick = useCallback(() => {
    if (!runtimeOn) {
      void actions.startAll();
      return;
    }
    if (isDisconnectConfirmDismissed()) {
      void actions.stopAll();
      return;
    }
    setDisconnectConfirmOpen(true);
  }, [actions, runtimeOn]);
  const confirmDisconnect = useCallback((dontShowAgain: boolean) => {
    persistDisconnectConfirmDismissed(dontShowAgain);
    setDisconnectConfirmOpen(false);
    void actions.stopAll();
  }, [actions]);

  // The Add Balance banner is a nudge for low balances only — with more than
  // $5 left it's just noise. Keyed off spendable, not the unreserved slice: an
  // open session holds funds that still buy requests.
  const creditsSpendableNum = Number(snap.creditsSpendable);
  const showAddBalance = !addBalanceDismissed
    && !(Number.isFinite(creditsSpendableNum) && creditsSpendableNum > 5);
  const hasDeposited = Number(snap.creditsTotalOwned) > 0 || snap.creditsChannels.length > 0;
  const reminderOffer = hasDeposited ? null : snap.reminderOffer;

  function submitDraft(): void {
    const text = draft.trim();
    if (!text) return;
    actions.sendMessage(text);
    setDraft('');
    onSelectView?.('chat');
  }

  const defaultModelLabel = selectedEntry?.label
    ?? (selectedModel ? displayModelLabel(selectedModel.serviceId, selectedModel.label) : 'No model');

  /* Recent chats sample — full width, same rows as the floating pill; every
     interaction leads to the dedicated Chats page where chats are managed. */
  const recentChats = (
    <VprRecentChatsCard
      conversations={conversations ?? []}
      catalog={snap.catalog}
      defaultModelLabel={defaultModelLabel}
      routedPeerNameFor={snap.showRoutedPeer
        ? (chat) => conversationRoutedPeerName(chat, snap.allRows)
        : undefined}
      profiles={profiles}
      loading={conversations === null && expectChats}
      onOpen={() => onSelectView?.('chats')}
    />
  );

  const reminderCard = reminderOffer ? (
    <section className={styles.reminderCard} aria-labelledby="reminder-offer-title">
      <div className={styles.reminderContent}>
        <div className={styles.reminderHeadline}>
          <span className={styles.reminderIcon} aria-hidden="true">
            <HugeiconsIcon icon={SparklesIcon} size={26} strokeWidth={2} />
          </span>
          <div className={styles.reminderHeadlineText}>
            <strong id="reminder-offer-title" className={styles.reminderTitle}>
              {reminderOffer.variant === 'd1'
                ? `Your first day cost you $0 for ${reminderOffer.requestsCount} requests worth $${reminderOffer.retrospectiveUsd}.`
                : `So far, you’ve paid $0 for ${reminderOffer.requestsCount} requests worth $${reminderOffer.retrospectiveUsd}.`}
            </strong>
          </div>
        </div>

        <div className={styles.reminderProof}>
          <strong>
            Your $10 can turn into <em>~${Math.round(Number(
              reminderOffer.prospectiveUsd,
            )).toLocaleString('en-US')}</em> in frontier-model value.
          </strong>
        </div>

        <div className={styles.reminderActions}>
          <button
            type="button"
            className={styles.reminderPrimary}
            onClick={() => {
              actions.acceptReminderHome();
              onSelectView?.('deposit');
            }}
          >
            Deposit $10
          </button>
          <button
            type="button"
            className={styles.reminderSecondary}
            onClick={actions.dismissReminderHome}
          >
            Not now
          </button>
        </div>
      </div>
    </section>
  ) : null;

  /* Model picker panel — shared by the composer pill (first-timers) and the
     standalone model card (connected-apps variant). */
  const modelMenu = modelMenuOpen ? (
        <div className={styles.modelMenu} role="listbox">
          <VprModelRowList
            entries={dropdownEntries}
            selectedProvider={selectedModel?.provider}
            selectedServiceId={selectedModel?.serviceId}
            favoriteKeys={favorites}
            selectOnly
            pinnedPeerLabels={dropdownPins}
            dense
            onSelect={(provider, serviceId) => {
              selectModelForNewChats(provider, serviceId);
            }}
            emptyLabel="No models discovered yet"
            frameless
          />
          <button
            type="button"
            className={styles.modelMenuFooter}
            onClick={() => {
              setModelMenuOpen(false);
              onSelectView?.('explore');
            }}
          >
            <span>All models</span>
            <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
          </button>
        </div>
  ) : null;

  const renderProfilePill = (profile: SystemProxyProfileSummary) => {
    // A connected app keeps its pill, shown as connected; clicking it leads
    // to the Apps page where the connection is managed.
    const connected = activeProfiles?.has(profile.name) ?? false;
    return (
      <button
        key={profile.name}
        type="button"
        className={`${styles.toolPill}${connected ? ` ${styles.toolPillConnected}` : ''}`}
        disabled={!connected && connectingProfile !== null}
        onClick={() => {
          if (connected) onSelectView?.('tools');
          else void connectApp(profile.name);
        }}
        title={connected ? `${profile.displayName} is connected` : `Connect ${profile.displayName}`}
      >
        {profile.iconDataUri && !isThemeAwareAppBrand(resolveBrandKey(profile.name, profile.displayName))
          ? <img src={profile.iconDataUri} alt="" className={styles.appIcon} />
          : <BrandIcon name={profile.name} hints={[profile.displayName]} size={16} />}
        <span className={styles.toolLabel}>
          {connectingProfile === profile.name ? 'Connecting...' : profile.displayName}
        </span>
        {connected && <span className={styles.toolConnectedDot} aria-label="Connected" />}
      </button>
    );
  };

  /* Connect pitch — shown on both Home variants until the user has chats:
     connecting one tool shouldn't hide the rest of the catalog. Once chats
     exist the user knows the flow (the full list lives on the Apps page). */
  const appsPitch = (conversations === null ? !expectChats : conversations.length === 0) ? (
    <div className={styles.appsGroup}>
      <p className={styles.appsLabel}>Use Antseed on your favorite app</p>

      <div className={styles.toolList}>
        {/* Same lead items as the Apps tab (Telegram, Claude, Cursor), then
            the catalog — the full list lives on the Apps page. */}
        <button
          type="button"
          className={styles.toolPill}
          onClick={() => onSelectView?.('tools')}
          title="Set up Telegram Bot"
        >
          <BrandIcon name="telegram" hints={['Telegram Bot']} size={16} />
          <span className={styles.toolLabel}>Telegram Bot</span>
        </button>
        {claudeProfile ? renderProfilePill(claudeProfile) : null}
        <button
          type="button"
          className={styles.toolPill}
          onClick={() => onSelectView?.('tools')}
          title="Set up Cursor"
        >
          <BrandIcon name="cursor" hints={['Cursor']} size={16} />
          <span className={styles.toolLabel}>Cursor</span>
        </button>
        {homePreviewProfiles.map(renderProfilePill)}
      </div>
    </div>
  ) : null;

  /* Usage tiles — shown on both Home variants, zeros included, so the
     module is there from the first launch. */
  const usageTiles = (
    <div className={styles.usageGroup}>
      <p className={styles.usageLabel}>Usage</p>
      <VprStatRow>
        <VprStatTile label="Requests" value={(snap.usage?.totalRequests ?? 0).toLocaleString('en-US')} />
        <VprStatTile
          label="Tokens"
          value={formatCompactTokens(snap.usage?.totalInputTokens, snap.usage?.totalOutputTokens)}
        />
        <VprStatTile
          label="Saving"
          value={expectedSavingsPct !== null && (snap.usage?.totalRequests ?? 0) > 0
            ? (
              <span
                className={styles.savingValue}
                title={measuredSavings
                  ? `Measured vs retail: paid $${measuredSavings.actualUsd.toFixed(2)} for usage worth $${measuredSavings.baselineUsd.toFixed(2)} at retail reference prices`
                  : 'Estimated from current network price spread'}
              >
                {measuredSavings
                  ? `${formatSavedUsd(measuredSavings.baselineUsd - measuredSavings.actualUsd)}`
                  : `${expectedSavingsPct}%`}
              </span>
            )
            : formatSavedUsd(0)}
        />
      </VprStatRow>
    </div>
  );

  return (
    <section className={`view view-vpr-home ${styles.view}`} role="tabpanel">
      {/* The hero is pinned outside the scroller — only the content below it
          scrolls, like a fixed app header. */}
      <div className={styles.heroPane}>
      <div className={styles.stack}>
        {/* Power / status hero over the brand gradient banner */}
        <div className={styles.hero}>
          <div
            className={`${styles.heroBanner}${connected ? ` ${styles.heroBannerLive}` : ` ${styles.heroBannerOff}`}`}
            aria-hidden="true"
          />
          <button
            type="button"
            className={styles.heroPop}
            onClick={() => { void actions.openVprFloat?.(); }}
            disabled={snap.floatOpen}
            aria-label="Pop out floating window"
            title={snap.floatOpen ? 'Floating window is open' : 'Pop out floating window'}
          >
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={`${styles.power}${powerLit ? ` ${styles.powerOn}` : ` ${styles.powerOff}`}`}
            onClick={onPowerClick}
            aria-pressed={runtimeOn}
            aria-label={runtimeOn ? 'Stop routing' : 'Start routing'}
            title={runtimeOn ? 'Stop routing' : 'Start routing'}
          >
            <HugeiconsIcon icon={PowerIcon} size={48} strokeWidth={2} />
          </button>

          <div className={`${styles.statusLine}${connected ? ` ${styles.statusOnline}` : ''}`}>
            {networkDown
              ? (snap.networkAlert === 'no-internet' ? 'No internet connection' : 'Network unreachable')
              : snap.connectBadge.label}
          </div>

          {!hasConnectedApps ? (
            /* Chat comes first: one composer card — prompt on top, model pill
               and send below — so the first thing to do is press send. Hidden
               once apps are connected; that variant leads with the chats. */
            <div className={styles.heroAsk}>
              <form
                className={styles.composer}
                onSubmit={(event) => { event.preventDefault(); submitDraft(); }}
              >
                <input
                  className={styles.askInput}
                  type="text"
                  value={draft}
                  placeholder="How can I help you today?"
                  aria-label="How can I help you today?"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className={styles.composerFooter}>
                  <div className={styles.modelDropdownInline} ref={modelMenuRef}>
                    <button
                      type="button"
                      className={styles.modelPill}
                      onClick={() => setModelMenuOpen((open) => !open)}
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      title="Change model for new chats"
                    >
                      {selectedModel && (
                        <BrandIcon name={selectedModel.provider} hints={[selectedModel.label]} size={16} />
                      )}
                      <span className={styles.modelPillName}>{defaultModelLabel}</span>
                      {modelIsFree && <span className={styles.freeTag}>Free</span>}
                      {!modelIsFree && snap.defaultProvisional && (
                        <span className={styles.searchingTag}>Finding free peers…</span>
                      )}
                      <HugeiconsIcon icon={ArrowDown01Icon} size={18} strokeWidth={2} className={styles.modelPillChevron} />
                    </button>
                    {modelMenu}
                  </div>
                  <button
                    type="submit"
                    className={`${styles.askSend}${!expectChats && draft.trim().length > 0 ? ` ${styles.askSendPing}` : ''}`}
                    aria-label="Send message"
                    title="Send message"
                    disabled={draft.trim().length === 0}
                  >
                    <HugeiconsIcon icon={ArrowUp02Icon} size={22} strokeWidth={2} />
                  </button>
                </div>
              </form>
            </div>
          ) : (
          <div className={styles.modelDropdown} ref={modelMenuRef}>
            <button
              type="button"
              className={styles.modelCard}
              onClick={() => setModelMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              title="Change model for new chats"
            >
              <span className={styles.modelCardBody}>
                <span className={styles.modelCardTitle}>
                  {selectedModel && (
                    <BrandIcon name={selectedModel.provider} hints={[selectedModel.label]} size={20} />
                  )}
                  <span className={styles.modelName}>
                    {selectedEntry?.label
                      ?? (selectedModel ? displayModelLabel(selectedModel.serviceId, selectedModel.label) : 'None selected')}
                  </span>
                  {modelIsFree && <span className={styles.freeTag}>Free</span>}
                  {/* First-use warm-up: the default is provisional while no
                      trusted free seller is discovered yet — say so instead of
                      presenting the paid fallback as a settled choice. */}
                  {!modelIsFree && snap.defaultProvisional && (
                    <span className={styles.searchingTag}>Finding free peers…</span>
                  )}
                </span>
                <span className={styles.modelCardCaption}>
                  <span>Model for new chats</span>
                  {/* Where the model routes: the pinned seller by name, or
                      how many peers are serving it while on auto. */}
                  {(pinnedSeller || selectedEntry) && (
                    <span className={styles.modelCardDivider} aria-hidden="true">|</span>
                  )}
                  {pinnedSeller ? (
                    <span className={styles.modelCardSeller}>{pinnedSeller}</span>
                  ) : selectedEntry ? (
                    <span className={styles.modelCardMeta}>
                      {selectedEntry.peerCount} {selectedEntry.peerCount === 1 ? 'peer' : 'peers'}
                    </span>
                  ) : null}
                </span>
              </span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={24} strokeWidth={2} className={styles.modelCardChevron} />
            </button>
            {modelMenu}
          </div>
          )}
        </div>
      </div>
      </div>

      <OverlayScrollArea
        className={styles.scroller}
        viewportClassName={styles.scrollerViewport}
        dataViewScroll
      >
      <div className={styles.stack}>
        {hasConnectedApps ? (
          /* Connected variant: recent chats instead of the ask input */
          <div className={styles.connectedGroup}>
            {/* Connected apps live on the Apps page — home leads with the
                chats themselves. */}
            {restartProfiles.length > 0 && !restartNoticeDismissed ? (
              <div className={styles.restartBanner}>
                <button type="button" className={styles.restartBannerBody} onClick={() => onSelectView?.('tools')}>
                  <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={18} strokeWidth={2} />
                  <span>
                    <strong>{restartProfiles.length === 1 ? restartProfiles[0]!.displayName : `${restartProfiles.length} apps`} need a restart</strong>
                    <small>Restart to apply the AI VPN connection.</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.restartBannerClose}
                  onClick={dismissRestartNotice}
                  aria-label="Dismiss app restart notice"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
                </button>
              </div>
            ) : null}

            {reminderCard}

            {recentChats}

            {showAddBalance && !snap.reminderOffer ? (
              <div className={styles.balanceBanner}>
                <button
                  type="button"
                  className={styles.balanceBody}
                  onClick={() => onSelectView?.('deposit')}
                >
                  <span className={styles.balanceTitle}>Add Balance</span>
                  <span className={styles.balanceText}>
                    Pay only for what you use - no subscriptions, no lock-in. Card or USDC, your choice.
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.balanceClose}
                  onClick={dismissAddBalance}
                  aria-label="Dismiss add balance"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
                </button>
              </div>
            ) : null}

            {appsPitch}

            {usageTiles}
          </div>
        ) : (
        /* Routed apps + recent chats (the ask input lives in the hero) */
        <div className={styles.connectGroup}>
          {appsPitch}

          {reminderCard}

          {recentChats}

          {/* Usage sits last on both variants. */}
          {usageTiles}
        </div>
        )}
      </div>
      </OverlayScrollArea>
      {modelChangeNotice ? (
        <BottomNotice
          ariaLive="polite"
          body={modelChangeNotice}
          dismissIcon={<HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />}
          dismissLabel="Dismiss model change confirmation"
          icon={<HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2.2} />}
          layout="toast"
          onDismiss={() => setModelChangeNotice(null)}
        />
      ) : null}
      <DisconnectConfirmDialog
        visible={disconnectConfirmOpen}
        onConfirm={confirmDisconnect}
        onCancel={() => setDisconnectConfirmOpen(false)}
      />
    </section>
  );
}
