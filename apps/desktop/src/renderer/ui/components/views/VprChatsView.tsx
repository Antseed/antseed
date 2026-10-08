import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import {
  conversationMatchesApp,
  conversationPinnedPeerId,
  conversationPinnedServiceId,
  conversationRoutedPeerName,
  conversationTitle,
  shortSessionId,
} from '../../../modules/routing/conversations';
import { displayModelLabel, sameCanonicalModel } from '../../../modules/catalog/model-identity';
import { displayToolName } from '../../../modules/routing/tool-names';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/catalog/recommended';
import {
  compareModelRoutesByReputation,
  resolvePeerForModel,
  routesForSelectedModel,
} from '../../../modules/catalog/view-models';
import { shortPeerId } from '../../../modules/routing/tools';
import { isFreeRoute, sellerMetaLabel, sellerReputationLabel, sellerReputationExplanation } from '../../../modules/catalog/seller-format';
import { buyerConversationsResource, systemProxyResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import type { DiscoverRow } from '../../../core/state';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { VprBadge, VprPage, VprSettingRow, VprToggle } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { chatModelLabel, hasSeenChats, rememberSeenChats, VprChatRow, VprChatRowsSkeleton } from '../vpr/VprRecentChats';
import styles from './VprChatsView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/**
 * Dedicated chats page (no nav-rail item — reached from the Recent chats
 * cards on Home and Apps). The list mirrors the floating pill's dropdown;
 * drilling into a chat picks its model the same way the pill does, plus
 * rename and delete management.
 */
export function VprChatsView({ onSelectView: _onSelectView }: Props) {
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    discoverRows: state.vprRoutableRows,
    preferences: state.vprRoutingPreferences,
    pins: state.vprModelPins,
    // Unfiltered discover list, for routed-peer name resolution.
    allRows: state.discoverRows,
    showRoutedPeer: state.vprFloatShowRoutedPeer,
  }), shallowEqual);
  const conversationsResource = useCachedResource(buyerConversationsResource);
  const proxyResource = useCachedResource(systemProxyResource);
  const conversations = conversationsResource.data;
  const profiles = proxyResource.data?.profiles ?? [];
  const [expectChats] = useState(hasSeenChats);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Which way the next level change animates (same pattern as the floating
  // pill): drilling into a chat slides from the right, back from the left.
  const [navDir, setNavDir] = useState<'forward' | 'back'>('forward');
  // Third level: per-chat settings for one model (opened from the config
  // button on its row) — hosts the seller picker.
  const [configModel, setConfigModel] = useState<{ provider: string; serviceId: string } | null>(null);

  const drillIn = useCallback((id: string) => {
    setNavDir('forward');
    setSelectedId(id);
  }, []);
  const drillBack = useCallback(() => {
    setNavDir('back');
    setSelectedId(null);
    setConfigModel(null);
  }, []);
  const configIn = useCallback((provider: string, serviceId: string) => {
    setNavDir('forward');
    setConfigModel({ provider, serviceId });
  }, []);
  const configBack = useCallback(() => {
    setNavDir('back');
    setConfigModel(null);
  }, []);

  const refresh = buyerConversationsResource.refresh;

  useEffect(() => {
    if (conversations) rememberSeenChats(conversations.length);
  }, [conversations]);

  const selected = selectedId
    ? conversations?.find((chat) => chat.id === selectedId) ?? null
    : null;
  // A selected chat that disappears (deleted elsewhere, aged out) falls back
  // to the list; the rename draft resets per visited chat.
  useEffect(() => {
    if (selectedId && (conversations?.length ?? 0) > 0 && !selected) drillBack();
  }, [selectedId, selected, conversations?.length, drillBack]);
  useEffect(() => {
    setDraftLabel(null);
    setMessage(null);
    setConfigModel(null);
  }, [selectedId]);

  const selectedEntry = snap.selection.model
    ? findCatalogEntry(snap.catalog, snap.selection.model.provider, snap.selection.model.serviceId)
    : null;
  const defaultModelLabel = selectedEntry?.label
    ?? (snap.selection.model ? displayModelLabel(snap.selection.model.serviceId, snap.selection.model.label) : null);

  // Same curated lineup as the pill's model list (favorites first, then the
  // recommended models), with the chat's pinned model always present so it
  // never disappears from its own picker.
  const favorites = useMemo(loadFavoriteModels, [selectedId]);
  const models = useMemo(() => {
    const favoriteEntries = selectFavoriteVprCatalog(snap.catalog, favorites);
    const recommended = selectRecommendedVprCatalog(snap.catalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    const list = [...favoriteEntries, ...recommended];
    const pinnedServiceId = selected ? conversationPinnedServiceId(selected) : null;
    if (pinnedServiceId && !list.some((entry) => entry.serviceId === pinnedServiceId)) {
      const pinnedEntry = snap.catalog.find((entry) => entry.serviceId === pinnedServiceId);
      if (pinnedEntry) list.unshift(pinnedEntry);
    }
    return list;
  }, [favorites, selected, snap.catalog]);

  const pinChat = useCallback(async (id: string, provider: string, serviceId: string) => {
    const hasRoute = routesForSelectedModel(snap.discoverRows, { provider, serviceId }).length > 0;
    if (!hasRoute) {
      setMessage(`No available route for ${serviceId} right now`);
      return;
    }
    setMessage(null);
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id, pinnedModel: serviceId, peerSource: 'auto' });
    await refresh();
  }, [refresh, snap.discoverRows]);

  // Per-chat seller choice: pick the exact peer this chat's requests go to
  // (switching the chat's model too when the config page is for another
  // model). 'user' marks it as deliberate so the model-pin sweep never
  // moves it; the auto toggle is the way back.
  const pinChatSeller = useCallback(async (id: string, route: DiscoverRow) => {
    setMessage(null);
    await window.antseedDesktop?.buyerConversationsUpdate?.({
      id,
      // Dispatch carries the chosen row's own serviceId — sellers advertise
      // the same model under near-identical ids.
      pinnedModel: `${route.peerId}@${route.serviceId}`,
      peerSource: 'user',
    });
    await refresh();
  }, [refresh]);

  // Sellers serving the config page's model, reputation first.
  const configEntry = configModel ? findCatalogEntry(snap.catalog, configModel.provider, configModel.serviceId) : null;
  const configRoutes = useMemo(() => {
    if (!configModel) return [];
    return [...routesForSelectedModel(snap.discoverRows, configModel)].sort(compareModelRoutesByReputation);
  }, [configModel, snap.discoverRows]);
  // The chat's current peer counts as active only on its own model's page.
  const configIsChatModel = Boolean(selected && configModel
    && sameCanonicalModel(conversationPinnedServiceId(selected) ?? '', configModel.serviceId));
  // What the chat runs on right now: its peer id and a display name for it.
  const chatPeerId = selected ? conversationPinnedPeerId(selected) : null;
  const chatPeerName = useMemo(() => {
    if (!chatPeerId) return null;
    const route = snap.discoverRows.find((row) => row.peerId.toLowerCase() === chatPeerId);
    return route?.peerDisplayName?.trim() || route?.peerLabel?.trim() || shortPeerId(chatPeerId);
  }, [chatPeerId, snap.discoverRows]);
  // Detail level: the chat's model row names the exact peer serving it, so
  // the route is visible before opening the row's settings.
  const chatPeerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const service = selected ? conversationPinnedServiceId(selected) : null;
    if (!service || !chatPeerName) return labels;
    for (const entry of models) {
      if (sameCanonicalModel(entry.serviceId, service)) {
        labels.set(`${entry.provider}:${entry.serviceId}`, chatPeerName);
      }
    }
    return labels;
  }, [chatPeerName, models, selected]);

  const saveLabel = useCallback(async () => {
    if (!selected || draftLabel === null) return;
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id: selected.id, label: draftLabel.trim() || null });
    setDraftLabel(null);
    await refresh();
  }, [draftLabel, refresh, selected]);

  const deleteChat = useCallback(async () => {
    if (!selected) return;
    const title = conversationTitle(selected);
    if (!window.confirm(`Delete "${title}"? An active chat reappears on its next request.`)) return;
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id: selected.id, delete: true });
    drillBack();
    await refresh();
  }, [drillBack, refresh, selected]);

  return (
    <section
      className={`view view-vpr-chats view-pinned-header ${styles.view}${selected ? ` ${styles.viewDetail}` : ''}`}
      role="tabpanel"
    >
      <VprPage
        title={selected && configModel
          ? (configEntry?.label ?? displayModelLabel(configModel.serviceId))
          : selected ? conversationTitle(selected) : 'Chats'}
        onBack={selected ? (configModel ? configBack : drillBack) : undefined}
        backFallback="home"
      >
        <div className={styles.stack}>
          {message ? <p className={styles.note} role="status">{message}</p> : null}

          <div
            key={selected ? (configModel ? `${selected.id}:config` : selected.id) : 'list'}
            className={navDir === 'back' ? styles.slideBack : styles.slide}
          >
          {selected && configModel ? (
            (() => {
              // Same shape as the Models page: an auto toggle on top, seller
              // rows below, the active one leading with a check and an
              // "• Auto"/"Pinned" badge. On another model's page the toggle
              // reads auto and nothing is active; any pick switches the chat
              // to that model too.
              const autoOn = configIsChatModel ? selected.peerSource !== 'user' : true;
              // Turning auto back on re-resolves the route (the model's
              // seller pin, else the preference-scored best) rather than
              // keeping the seller that was pinned.
              const backToAuto = () => {
                void pinChat(selected.id, configModel.provider, configModel.serviceId);
              };
              return (
                <div className={styles.sellerGroup}>
                  <div className={styles.autoRow}>
                    <VprSettingRow
                      title="Auto select seller"
                      hint="Price + Trust preference"
                      control={(
                        <VprToggle
                          checked={autoOn}
                          onChange={(next) => {
                            if (next) {
                              backToAuto();
                              return;
                            }
                            // Auto off = keep what the chat is on: pin its
                            // current seller (or the one auto would pick).
                            const autoPeerId = resolvePeerForModel(snap.discoverRows, snap.pins, snap.preferences, configModel);
                            const route = configRoutes.find((candidate) => candidate.peerId.toLowerCase() === chatPeerId)
                              ?? configRoutes.find((candidate) => candidate.peerId === autoPeerId);
                            if (route) void pinChatSeller(selected.id, route);
                          }}
                          ariaLabel="Auto select seller"
                        />
                      )}
                    />
                  </div>
                  <p className={styles.sectionLabel}>Seller for this chat</p>
                  {configRoutes.length === 0 ? (
                    <div className={styles.empty}>No sellers available for this model right now</div>
                  ) : (
                    <div className={styles.sellerCard}>
                      {configRoutes.map((route) => {
                        const active = configIsChatModel && route.peerId.toLowerCase() === chatPeerId;
                        const userChosen = active && !autoOn;
                        return (
                          <button
                            type="button"
                            key={route.rowKey}
                            className={`${styles.sellerRow}${active ? ` ${styles.sellerRowActive}` : ''}`}
                            onClick={() => {
                              // Clicking the pinned seller unpins it (same as
                              // the Models page); anyone else pins them.
                              if (userChosen) backToAuto();
                              else void pinChatSeller(selected.id, route);
                            }}
                            title={userChosen ? 'Unpin this seller' : 'Use this seller for this chat'}
                          >
                            {active && (
                              <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.sellerCheck} />
                            )}
                            <span className={styles.sellerText}>
                              <span className={styles.sellerName}>
                                {route.peerDisplayName || route.peerLabel || route.peerId}
                                {active && <VprBadge tone="primary">{autoOn ? '• Auto' : 'Pinned'}</VprBadge>}
                                {isFreeRoute(route) && <VprBadge tone="green">Free</VprBadge>}
                              </span>
                              <span className={styles.sellerMeta}>{sellerMetaLabel(route)}</span>
                            </span>
                            <span className={styles.sellerScore} title={sellerReputationExplanation(route)}>{sellerReputationLabel(route)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()
          ) : selected ? (
            <>
              <div className={styles.nameCard}>
                <label className={styles.nameField}>
                  <span className={styles.nameLabel}>Chat name</span>
                  <input
                    type="text"
                    value={draftLabel ?? selected.label ?? ''}
                    placeholder={selected.snippet || 'Name this chat'}
                    spellCheck={false}
                    onChange={(event) => setDraftLabel(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                    onBlur={() => void saveLabel()}
                  />
                </label>
                <span className={styles.nameMeta}>
                  {profiles.find((profile) => conversationMatchesApp(selected.tool, profile))?.displayName ?? displayToolName(selected.tool)} · {shortSessionId(selected.sessionKey)}
                </span>
              </div>

              <div className={styles.modelGroup}>
                <p className={styles.sectionLabel}>Model</p>
                <div className={styles.modelScroll}>
                  <VprModelRowList
                    entries={models}
                    selectedServiceId={conversationPinnedServiceId(selected) ?? undefined}
                    favoriteKeys={favorites}
                    selectOnly
                    onSelect={(provider, serviceId) => {
                      // Re-clicking the chat's current model must not touch
                      // its route — pinChat re-resolves the peer, which would
                      // wipe a per-chat seller pin back to auto.
                      const current = conversationPinnedServiceId(selected);
                      if (current && sameCanonicalModel(current, serviceId)) return;
                      void pinChat(selected.id, provider, serviceId);
                    }}
                    onConfigure={configIn}
                    pinnedPeerLabels={chatPeerLabels}
                    emptyLabel="No models available"
                    frameless
                  />
                </div>
              </div>

              <button type="button" className={styles.deleteButton} onClick={() => void deleteChat()}>
                Delete chat
              </button>
            </>
          ) : conversations === null && expectChats ? (
            <div className={styles.listCard}>
              <VprChatRowsSkeleton rows={3} />
            </div>
          ) : (conversations?.length ?? 0) === 0 ? (
            <div className={styles.empty}>No tool chats yet — connect an app and send a prompt</div>
          ) : (
            <div className={styles.listCard}>
              {(conversations ?? []).map((chat) => (
                <VprChatRow
                  key={chat.id}
                  chat={chat}
                  modelLabel={chatModelLabel(chat, snap.catalog, defaultModelLabel)}
                  routedPeerName={snap.showRoutedPeer ? conversationRoutedPeerName(chat, snap.allRows) : null}
                  profiles={profiles}
                  onClick={() => drillIn(chat.id)}
                />
              ))}
            </div>
          )}
          </div>
        </div>
      </VprPage>
    </section>
  );
}
