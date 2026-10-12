/**
 * Keeps the main process fed with the curated model-picker list — the exact
 * rows the Home model dropdown and the float pill show (starred favorites
 * first, then the recommended lineup, current selection always present) —
 * so non-renderer frontends (the Telegram bridge) offer the same models the
 * app does. See shared/model-picker.ts for the payload contract.
 *
 * Pushes are driven by store notifications plus the favorites-changed event
 * (stars live in localStorage, outside the store), debounced and deduped so
 * the IPC channel stays quiet while nothing the picker shows has changed.
 */

import type { RendererUiState, VprModelCatalogEntry } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import type { ModelPickerEntry, ModelPickerSnapshot } from '../../../shared/model-picker.js';
import { subscribe } from '../../core/store';
import { loadFavoriteModels, VPR_FAVORITES_CHANGED_EVENT } from './favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from './recommended';
import { routesForSelectedModel } from './view-models';
import { chooseBestVprRoute, isPeerRoutable } from '../routing/select';
import { vprModelPinFor } from '../routing/model-pins';
import type { DiscoverRow } from '../../core/state';

const PUSH_DEBOUNCE_MS = 400;

export function initModelPickerSync({ bridge, uiState }: {
  bridge: DesktopBridge | undefined;
  uiState: RendererUiState;
}): void {
  if (!bridge?.chatSyncModelPicker) return;

  /** The seller a picker entry routes to right now: the model's remembered
   *  pin when it is still routable and still serves the model, otherwise the
   *  routing-preferences best route — the same resolution a dropdown pick
   *  performs in actionSelectVprModel. */
  const resolveRoute = (provider: string, serviceId: string): DiscoverRow | null => {
    const routes = routesForSelectedModel(uiState.vprRoutableRows, { provider, serviceId });
    if (routes.length === 0) return null;
    const pinned = vprModelPinFor(uiState.vprModelPins, provider, serviceId);
    if (pinned && isPeerRoutable(pinned, uiState.vprRoutingPreferences)) {
      const pinnedRoute = routes.find((row) => row.peerId === pinned);
      if (pinnedRoute) return pinnedRoute;
    }
    return chooseBestVprRoute(routes, uiState.vprRoutingPreferences);
  };

  const buildSnapshot = (): ModelPickerSnapshot => {
    const favorites = loadFavoriteModels();
    const favoriteEntries = selectFavoriteVprCatalog(uiState.vprModelCatalog, favorites);
    const recommended = selectRecommendedVprCatalog(uiState.vprModelCatalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    // External model pickers currently dispatch chat requests. Image-only
    // endpoints remain browseable in AI VPN but must not leak into those pickers.
    const entries: VprModelCatalogEntry[] = [...favoriteEntries, ...recommended]
      .filter((entry) => entry.kind === 'text');
    const selection = uiState.vprRouteSelection.model;
    if (
      selection
      && !entries.some((entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId)
    ) {
      const selected = uiState.vprModelCatalog.find((entry) => (
        entry.provider === selection.provider
        && entry.serviceId === selection.serviceId
        && entry.kind === 'text'
      ));
      if (selected) entries.unshift(selected);
    }
    const models: ModelPickerEntry[] = entries.map((entry) => {
      const route = resolveRoute(entry.provider, entry.serviceId);
      return {
        provider: entry.provider,
        serviceId: entry.serviceId,
        label: entry.label,
        favorite: favorites.has(catalogEntryKey(entry)),
        routePeerId: route?.peerId ?? null,
        routeServiceId: route?.serviceId ?? null,
        routeProvider: route?.provider ?? null,
      };
    });
    return {
      models,
      selected: selection && uiState.vprModelCatalog.find((entry) => (
        entry.provider === selection.provider
        && entry.serviceId === selection.serviceId
        && entry.kind === 'text'
      ))
        ? { provider: selection.provider, serviceId: selection.serviceId }
        : null,
    };
  };

  let lastPushedJson = '';
  let timer: number | null = null;

  const push = (): void => {
    const snapshot = buildSnapshot();
    if (snapshot.models.length === 0) return;
    const json = JSON.stringify(snapshot);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    void bridge.chatSyncModelPicker?.(snapshot).catch(() => {
      // Retry on the next state change.
      lastPushedJson = '';
    });
  };

  const schedulePush = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      push();
    }, PUSH_DEBOUNCE_MS);
  };

  subscribe(schedulePush);
  window.addEventListener(VPR_FAVORITES_CHANGED_EVENT, schedulePush);
  schedulePush();
}
